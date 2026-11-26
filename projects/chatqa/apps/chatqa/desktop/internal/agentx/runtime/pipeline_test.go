package runtime

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"google.golang.org/adk/v2/session"
	"google.golang.org/genai"

	"chatqa/internal/agentx/workflows"
)

func (f *fixture) state(t *testing.T, sessionID, key string) string {
	t.Helper()
	resp, err := f.rt.sessions.Get(context.Background(), &session.GetRequest{AppName: AppName, UserID: "u1", SessionID: sessionID})
	if err != nil {
		t.Fatal(err)
	}
	v, _ := resp.Session.State().Get(key)
	s, _ := v.(string)
	return s
}

// events collects UI events from a background run; wait returns them once done arrives.
type events struct {
	mu   sync.Mutex
	list []Event
	done chan struct{}
}

func newEvents() *events { return &events{done: make(chan struct{})} }

func (e *events) add(ev Event) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.list = append(e.list, ev)
	if ev.Kind == KindDone {
		close(e.done)
	}
}

func (e *events) wait(t *testing.T) []Event {
	t.Helper()
	select {
	case <-e.done:
	case <-time.After(10 * time.Second):
		t.Fatal("pipeline did not finish")
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	return append([]Event(nil), e.list...)
}

func TestPipelineRunsFromChat(t *testing.T) {
	f := newFixture(t, t.TempDir(), passingRun)
	f.open(t, map[string]*scripted{
		"c": {steps: []func() []*genai.Part{transferTo("pipeline")}},
		"p": {steps: []func() []*genai.Part{text(loginPlan)}},
		"r": {steps: []func() []*genai.Part{text("Báo cáo: đăng nhập đạt trên android")}},
	})
	id, evs, err := collect(t, f.rt, "", "chạy pipeline cho "+repoMexpress+" commit abc..def")
	if err != nil {
		t.Fatal(err)
	}
	if len(f.runArgs) != 1 {
		t.Fatalf("test_run calls = %d, want 1 (android only)", len(f.runArgs))
	}
	var sawReport, sawSkip bool
	for _, e := range evs {
		sawReport = sawReport || (e.Author == "reporter" && e.Kind == KindText && strings.Contains(e.Text, "đăng nhập đạt"))
		sawSkip = sawSkip || (e.Author == "runner" && strings.Contains(e.Text, "ios: bỏ qua"))
	}
	if !sawReport || !sawSkip {
		t.Fatalf("report=%v skip=%v events=%+v", sawReport, sawSkip, evs)
	}
	if st, tr := f.state(t, id, workflows.StateStatus), f.state(t, id, workflows.StateTrigger); st != workflows.StatusDone || tr != workflows.TriggerUI {
		t.Fatalf("status=%q trigger=%q", st, tr)
	}
	if done := evs[len(evs)-1]; done.Kind != KindDone || done.CostUSD <= 0 {
		t.Fatalf("done = %+v", done)
	}
}

func TestStartPipelineReturnsSessionAndStreams(t *testing.T) {
	f := newFixture(t, t.TempDir(), passingRun)
	f.open(t, map[string]*scripted{
		"p": {steps: []func() []*genai.Part{text(loginPlan)}},
		"r": {steps: []func() []*genai.Part{text("Báo cáo xong")}},
	})
	evs := newEvents()
	id, err := f.rt.StartPipeline(context.Background(), "u1", workflows.Request{Repo: repoMexpress, From: "abc", To: "def"}, evs.add)
	if err != nil || id == "" {
		t.Fatalf("start: %q %v", id, err)
	}
	got := evs.wait(t)
	for _, e := range got {
		if e.SessionID != id {
			t.Fatalf("event of another session: %+v", e)
		}
	}
	if f.state(t, id, workflows.StateStatus) != workflows.StatusDone || f.state(t, id, workflows.StateTrigger) != workflows.TriggerUI {
		t.Fatalf("status=%q", f.state(t, id, workflows.StateStatus))
	}
	waitIdle(t, f.rt, id)
	list, err := f.rt.Sessions(context.Background(), "u1")
	if err != nil || len(list) != 1 || list[0].Title != "Pipeline mexpress abc..def" || list[0].Running {
		t.Fatalf("sessions = %+v %v", list, err)
	}
}

func TestStartPipelineRejectsBadRequest(t *testing.T) {
	f := newFixture(t, t.TempDir(), passingRun)
	f.open(t, nil)
	if _, err := f.rt.StartPipeline(context.Background(), "u1", workflows.Request{Repo: "relative", From: "abc"}, func(Event) {}); err == nil {
		t.Fatal("a relative repo path must be refused")
	}
	if list, _ := f.rt.Sessions(context.Background(), "u1"); len(list) != 0 {
		t.Fatalf("a refused request must not create a session: %+v", list)
	}
}

func TestPipelineThatStopsMidRunIsMarkedFailed(t *testing.T) {
	f := newFixture(t, t.TempDir(), passingRun)
	f.diffErr = errors.New("không phải repo git")
	f.open(t, nil)
	evs := newEvents()
	id, err := f.rt.StartPipeline(context.Background(), "u1", workflows.Request{Repo: repoNotARepo, From: "abc", Trigger: workflows.TriggerHTTP}, evs.add)
	if err != nil {
		t.Fatal(err)
	}
	got := evs.wait(t)
	var sawErr bool
	for _, e := range got {
		sawErr = sawErr || (e.Kind == KindError && strings.Contains(e.Text, "không lấy được diff"))
	}
	if !sawErr {
		t.Fatalf("no error card: %+v", got)
	}
	waitIdle(t, f.rt, id)
	if st, tr := f.state(t, id, workflows.StateStatus), f.state(t, id, workflows.StateTrigger); st != workflows.StatusFailed || tr != workflows.TriggerHTTP {
		t.Fatalf("status=%q trigger=%q", st, tr)
	}
}

// waitIdle waits until the background run released the session (release runs after the done event).
func waitIdle(t *testing.T, rt *Runtime, id string) {
	t.Helper()
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(5 * time.Millisecond) {
		rt.mu.Lock()
		_, busy := rt.running[id]
		rt.mu.Unlock()
		if !busy {
			return
		}
	}
	t.Fatal("run never released the session")
}
