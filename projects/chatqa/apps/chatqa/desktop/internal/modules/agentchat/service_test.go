package agentchat

import (
	"context"
	"errors"
	"iter"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"google.golang.org/adk/v2/model"
	"google.golang.org/genai"

	"chatqa/internal/agentx/config"
	"chatqa/internal/agentx/models"
	agentrt "chatqa/internal/agentx/runtime"
	"chatqa/internal/tools"
	"deskcore/apperr"
	"deskcore/modules"
	"deskcore/offline"
)

type host struct{ deny bool }

func (host) Context() context.Context { return context.Background() }
func (host) WorkingActor() (offline.Actor, error) {
	return offline.Actor{UserID: "u1", DeviceID: "PC1"}, nil
}
func (host) RequirePerm(string) error { return nil }
func (h host) RequireApp(modules.Code) error {
	if h.deny {
		return apperr.New(apperr.CodePermissionDenied, "app")
	}
	return nil
}

type say struct{ text string }

func (say) Name() string { return "say" }
func (s say) GenerateContent(context.Context, *model.LLMRequest, bool) iter.Seq2[*model.LLMResponse, error] {
	return func(yield func(*model.LLMResponse, error) bool) {
		yield(&model.LLMResponse{Content: genai.NewContentFromText(s.text, genai.RoleModel), TurnComplete: true}, nil)
	}
}

func enable(t *testing.T, dir string) {
	t.Helper()
	raw, _ := os.ReadFile(filepath.Join(dir, config.FileName))
	raw = []byte(strings.Replace(string(raw), "enabled: false\n  engine", "enabled: true\n  engine", 1))
	if err := os.WriteFile(filepath.Join(dir, config.FileName), raw, 0o600); err != nil {
		t.Fatal(err)
	}
}

func newService(t *testing.T, h host) (*Service, *[]agentrt.Event) {
	dir := t.TempDir()
	if _, err := config.Load(dir); err != nil {
		t.Fatal(err)
	}
	enable(t, dir)
	var emitted []agentrt.Event
	lazy := agentrt.NewLazy(func(ctx context.Context) (*agentrt.Runtime, error) {
		cfg, err := config.Load(dir)
		if err != nil {
			return nil, err
		}
		prices := models.NewStaticPrices([]models.Price{{Alias: "sonnet"}, {Alias: "haiku"}, {Alias: "opus"}}, "sonnet", 26500)
		return agentrt.New(ctx, agentrt.Deps{Registry: tools.NewRegistry(), Config: cfg, DataDir: dir, Prices: prices,
			LLM: func(context.Context, string) (model.LLM, error) { return say{"chào anh"}, nil }})
	})
	t.Cleanup(lazy.Close)
	return New(h, lazy, dir, func(_ string, d any) {
		emitMu.Lock()
		defer emitMu.Unlock()
		emitted = append(emitted, d.(agentrt.Event))
	}), &emitted
}

// emitMu guards the emitted events: a pipeline emits from its own goroutine.
var emitMu sync.Mutex

func TestRunPipelineStartsASessionAndStreams(t *testing.T) {
	s, emitted := newService(t, host{})
	if _, err := s.RunPipeline(" ", "abc", ""); err == nil {
		t.Fatal("an empty repo must be refused")
	}
	id, err := s.RunPipeline(filepath.Join(filepath.VolumeName(os.TempDir())+string(filepath.Separator), "Users", "me", "code", "receiving"), "abc1234", "")
	if err != nil || id == "" {
		t.Fatalf("run: %q %v", id, err)
	}
	// The empty registry has no test_git_diff, so the run ends early with an error card; what matters here is
	// that it streams under the returned session and ends with done.
	var got []agentrt.Event
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(5 * time.Millisecond) {
		emitMu.Lock()
		got = append(got[:0], *emitted...)
		emitMu.Unlock()
		if len(got) > 0 && got[len(got)-1].Kind == agentrt.KindDone {
			break
		}
	}
	if len(got) == 0 || got[len(got)-1].Kind != agentrt.KindDone {
		t.Fatalf("events = %+v", got)
	}
	for _, e := range got {
		if e.SessionID != id {
			t.Fatalf("event of another session: %+v", e)
		}
	}
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(5 * time.Millisecond) {
		if list, _ := s.Sessions(); len(list) == 1 && !list[0].Running {
			if list[0].Title != "Pipeline receiving abc1234..HEAD" {
				t.Fatalf("title = %q", list[0].Title)
			}
			return
		}
	}
	t.Fatal("pipeline session never settled")
}

func TestStatusSendAndHistory(t *testing.T) {
	s, emitted := newService(t, host{})
	st := s.Status()
	if !st.Enabled || !st.Ready || st.Error != "" || len(st.Models) != 3 || st.Agents["planner"] != "haiku" || st.Models[0].Alias != "haiku" {
		t.Fatalf("status = %+v", st)
	}
	id, err := s.Send("", "xin chào")
	if err != nil || id == "" {
		t.Fatalf("send: %q %v", id, err)
	}
	if len(*emitted) == 0 || (*emitted)[len(*emitted)-1].Kind != agentrt.KindDone {
		t.Fatalf("events = %+v", *emitted)
	}
	list, err := s.Sessions()
	if err != nil || len(list) != 1 || list[0].Title != "xin chào" {
		t.Fatalf("sessions = %+v %v", list, err)
	}
	ev, err := s.Session(id)
	if err != nil || len(ev) < 2 || ev[0].Author != "user" {
		t.Fatalf("session = %+v %v", ev, err)
	}
	if err := s.DeleteSession(id); err != nil {
		t.Fatal(err)
	}
	if list, _ := s.Sessions(); len(list) != 0 {
		t.Fatalf("session not deleted: %+v", list)
	}
}

func TestSetModelAndEngineWriteYamlAndRebuild(t *testing.T) {
	s, _ := newService(t, host{})
	if err := s.SetModel("planner", "opus"); err != nil {
		t.Fatal(err)
	}
	if err := s.SetEngine("adk"); err != nil {
		t.Fatal(err)
	}
	st := s.Status()
	if st.Agents["planner"] != "opus" || st.Engine != "adk" || !st.Ready {
		t.Fatalf("status = %+v", st)
	}
	if err := s.SetModel("planner", " "); err == nil {
		t.Fatal("empty alias must fail")
	}
	if err := s.SetModel("nobody", "opus"); err == nil {
		t.Fatal("unknown agent must fail")
	}
	// A model the Worker does not offer is saved, and Status says why the team cannot start.
	if err := s.SetModel("planner", "gpt-9"); err != nil {
		t.Fatal(err)
	}
	if st := s.Status(); st.Ready || !strings.Contains(st.Error, "gpt-9") {
		t.Fatalf("status = %+v", st)
	}
	if err := s.SetModel("planner", "haiku"); err != nil || !s.Status().Ready {
		t.Fatal("fixing the model must bring the team back")
	}
}

func TestEveryCallIsGatedByTheApp(t *testing.T) {
	s, _ := newService(t, host{deny: true})
	if st := s.Status(); st.Ready || st.Error == "" {
		t.Fatalf("status = %+v", st)
	}
	if _, err := s.Send("", "x"); err == nil {
		t.Fatal("Send must be refused")
	}
	if _, err := s.Sessions(); err == nil {
		t.Fatal("Sessions must be refused")
	}
	if _, err := s.RunPipeline("/r", "a", ""); err == nil {
		t.Fatal("RunPipeline must be refused")
	}
	if err := s.SetModel("planner", "opus"); err == nil {
		t.Fatal("SetModel must be refused")
	}
	if err := s.Approve("s", "c", true, nil); err == nil {
		t.Fatal("Approve must be refused")
	}
	if err := s.Respond("s", "i", `{"approved_flows":[]}`); err == nil {
		t.Fatal("Respond must be refused")
	}
}

func TestApproveAndRespondNeedAnOpenQuestion(t *testing.T) {
	s, _ := newService(t, host{})
	if st := s.Status(); st.Pending == nil || len(st.Pending) != 0 {
		t.Fatalf("pending must be an empty list, got %#v", st.Pending)
	}
	id, err := s.Send("", "xin chào")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Approve(id, "nothing-asked", true, nil); !errors.Is(err, agentrt.ErrNotPending) {
		t.Fatalf("approve: %v", err)
	}
	if err := s.Respond(id, "nothing-asked", `{"approved_flows":[]}`); !errors.Is(err, agentrt.ErrNotPending) {
		t.Fatalf("respond: %v", err)
	}
	if err := s.Respond(id, "nothing-asked", `not json`); err == nil || errors.Is(err, agentrt.ErrNotPending) {
		t.Fatalf("malformed reply must be refused before the lookup: %v", err)
	}
}

func TestDisabledAndMissingTower(t *testing.T) {
	dir := t.TempDir()
	s := New(host{}, nil, dir, func(string, any) {})
	st := s.Status()
	if st.Enabled || st.Ready || st.Engine != "legacy" {
		t.Fatalf("status = %+v", st)
	}
	if _, err := s.Send("", "x"); err == nil || !errors.Is(err, err) {
		t.Fatal("no tower: Send must error")
	}
}
