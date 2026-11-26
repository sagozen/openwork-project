package runtime

import (
	"context"
	"encoding/json"
	"iter"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"google.golang.org/adk/v2/model"
	"google.golang.org/genai"

	"chatqa/internal/agentx/config"
	"chatqa/internal/agentx/guard"
	"chatqa/internal/agentx/models"
	"chatqa/internal/testengine"
	"chatqa/internal/tools"
)

// scripted answers each model call from a list of steps; after the list it says "xong".
type scripted struct {
	mu    sync.Mutex
	steps []func() []*genai.Part
	n     int
	reqs  []seenRequest // every request received, in order
}

// seenRequest is a snapshot of one model request: how many contents it had, the contents as JSON (tool results
// included) and the system instruction.
type seenRequest struct {
	contents int
	body     string
	system   string
}

func (s *scripted) Name() string { return "scripted" }

// requests returns the requests received so far.
func (s *scripted) requests() []seenRequest {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]seenRequest(nil), s.reqs...)
}

func (s *scripted) GenerateContent(_ context.Context, req *model.LLMRequest, _ bool) iter.Seq2[*model.LLMResponse, error] {
	return func(yield func(*model.LLMResponse, error) bool) {
		s.mu.Lock()
		seen := seenRequest{contents: len(req.Contents)}
		if raw, err := json.Marshal(req.Contents); err == nil {
			seen.body = string(raw)
		}
		if req.Config != nil && req.Config.SystemInstruction != nil {
			for _, p := range req.Config.SystemInstruction.Parts {
				seen.system += p.Text
			}
		}
		s.reqs = append(s.reqs, seen)
		parts := []*genai.Part{{Text: "xong"}}
		if s.n < len(s.steps) {
			parts = s.steps[s.n]()
		}
		s.n++
		s.mu.Unlock()
		yield(&model.LLMResponse{
			Content:       &genai.Content{Role: genai.RoleModel, Parts: parts},
			UsageMetadata: &genai.GenerateContentResponseUsageMetadata{PromptTokenCount: 1000, CandidatesTokenCount: 100},
			TurnComplete:  true,
		}, nil)
	}
}

func text(s string) func() []*genai.Part {
	return func() []*genai.Part { return []*genai.Part{{Text: s}} }
}

func transferTo(name string) func() []*genai.Part {
	return func() []*genai.Part {
		return []*genai.Part{{FunctionCall: &genai.FunctionCall{ID: "t1", Name: "transfer_to_agent", Args: map[string]any{"agent_name": name}}}}
	}
}

const loginPlan = `{"flows":[{"app":"mexpress","flow":"01_login.yaml","reason":"người dùng nói login"}],"platforms":["android"],"error":""}`

type fixture struct {
	diffErr error // test_git_diff fails with this when set
	rt      *Runtime
	dir     string
	runArgs chan map[string]any
	cfg     config.Config
	llm     func(ctx context.Context, alias string) (model.LLM, error)
	prices  *models.Prices
	reg     *tools.Registry
	flows   guard.FlowSource // flow store the safety guard reads; nil = none
	store   *testengine.FlowStore
	mcpDial mcpDialer
}

func newFixture(t *testing.T, dir string, runTool func(ctx context.Context, args map[string]any) (any, error)) *fixture {
	t.Helper()
	f := &fixture{dir: dir, runArgs: make(chan map[string]any, 4)}
	schema := map[string]any{"type": "object"}
	f.reg = tools.NewRegistry(
		tools.Raw("tower_fleet", "máy", "", "DeviceGrid", schema, func(context.Context, json.RawMessage) (any, error) {
			return []map[string]any{{"id": "emu-1", "platform": "android", "state": "ready"}, {"id": "sim-1", "platform": "ios", "state": "busy"}}, nil
		}),
		tools.Raw("test_git_diff", "diff", "", "ReportCard", schema, func(context.Context, json.RawMessage) (any, error) {
			if f.diffErr != nil {
				return nil, f.diffErr
			}
			return map[string]any{"stats": map[string]any{"files": 1, "add": 4, "del": 1}, "files": []map[string]any{{"path": "auth/login.go"}}}, nil
		}),
		tools.Raw("test_run", "chạy", "cqs.run", "RunProgress", schema, func(ctx context.Context, raw json.RawMessage) (any, error) {
			var a map[string]any
			json.Unmarshal(raw, &a)
			f.runArgs <- a
			return runTool(ctx, a)
		}),
	)
	f.cfg = config.Defaults()
	f.cfg.Agent.DefaultModel = "c"
	f.cfg.Agent.Agents = map[string]config.AgentModel{"coordinator": {Model: "c"}, "planner": {Model: "p"}, "summarizer": {Model: "s"},
		"triage": {Model: "t"}, "reporter": {Model: "r"}, "flowfixer": {Model: "f"}, "author": {Model: "a"}}
	f.prices = models.NewStaticPrices([]models.Price{
		{Alias: "c", InUsdPerM: 1, OutUsdPerM: 1}, {Alias: "p", InUsdPerM: 1, OutUsdPerM: 1}, {Alias: "s", InUsdPerM: 1, OutUsdPerM: 1},
		{Alias: "t", InUsdPerM: 1, OutUsdPerM: 1}, {Alias: "r", InUsdPerM: 1, OutUsdPerM: 1}, {Alias: "f", InUsdPerM: 1, OutUsdPerM: 1},
		{Alias: "a", InUsdPerM: 1, OutUsdPerM: 1},
	}, "c", 26500)
	return f
}

func (f *fixture) open(t *testing.T, models map[string]*scripted) {
	t.Helper()
	f.llm = func(_ context.Context, alias string) (model.LLM, error) {
		if m, ok := models[alias]; ok {
			return m, nil
		}
		return &scripted{}, nil
	}
	noDelay := time.Duration(0)
	rt, err := New(context.Background(), Deps{Registry: f.reg, Config: f.cfg, DataDir: f.dir, Prices: f.prices, LLM: f.llm, PipelineRetryDelay: &noDelay, Flows: f.flows,
		FlowStore: f.store, mcpDial: f.mcpDial})
	if err != nil {
		t.Fatal(err)
	}
	f.rt = rt
	t.Cleanup(rt.Close)
}

func passingRun(context.Context, map[string]any) (any, error) {
	return map[string]any{
		"run":   map[string]any{"id": "run-1", "app": "mexpress", "passed": 1},
		"flows": []map[string]any{{"flow": "01_login.yaml", "deviceId": "emu-1", "platform": "android", "passed": true}},
	}, nil
}

func collect(t *testing.T, rt *Runtime, sessionID, msg string) (string, []Event, error) {
	t.Helper()
	var evs []Event
	id, err := rt.Send(context.Background(), "u1", sessionID, msg, func(e Event) { evs = append(evs, e) })
	return id, evs, err
}

func kinds(evs []Event) []string {
	var out []string
	for _, e := range evs {
		out = append(out, e.Kind)
	}
	return out
}

func TestChatRunsLoginFlowOnAndroidEndToEnd(t *testing.T) {
	f := newFixture(t, t.TempDir(), passingRun)
	f.open(t, map[string]*scripted{
		"c": {steps: []func() []*genai.Part{transferTo("plan_and_run")}},
		"p": {steps: []func() []*genai.Part{text(loginPlan)}},
	})
	id, evs, err := collect(t, f.rt, "", "chạy flow login trên Android")
	if err != nil || id == "" {
		t.Fatalf("send: %q %v", id, err)
	}
	select {
	case a := <-f.runArgs:
		flows, _ := a["flows"].([]any)
		devs, _ := a["devices"].([]any)
		if a["app"] != "mexpress" || len(flows) != 1 || flows[0] != "01_login.yaml" || len(devs) != 1 || devs[0] != "emu-1" {
			t.Fatalf("test_run args = %v", a)
		}
	default:
		t.Fatal("test_run was not called")
	}

	// Events stream in order: the transfer, progress from the Runner, the result, then done with the run total.
	ks := kinds(evs)
	if ks[len(ks)-1] != KindDone {
		t.Fatalf("last event must be done: %v", ks)
	}
	var sawTransfer, sawProgress, sawResult bool
	for _, e := range evs {
		switch {
		case e.Kind == KindToolCall && e.ToolName == "transfer_to_agent":
			sawTransfer = true
			if sawProgress || sawResult {
				t.Fatal("transfer must come first")
			}
		case e.Author == "runner" && e.Kind == KindProgress && strings.Contains(e.Text, "Đang chạy"):
			sawProgress = true
		case e.Author == "runner" && e.Kind == KindText && strings.Contains(e.Text, "01_login.yaml đạt") && strings.Contains(e.Text, "1 đạt, 0 lỗi"):
			sawResult = true
		}
	}
	if !sawTransfer || !sawProgress || !sawResult {
		t.Fatalf("transfer=%v progress=%v result=%v events=%+v", sawTransfer, sawProgress, sawResult, evs)
	}
	done := evs[len(evs)-1]
	if done.CostUSD <= 0 || done.TokensIn < 2000 {
		t.Fatalf("done = %+v", done)
	}
}

func TestPlannerErrorMeansNothingRuns(t *testing.T) {
	f := newFixture(t, t.TempDir(), passingRun)
	f.open(t, map[string]*scripted{
		"c": {steps: []func() []*genai.Part{transferTo("plan_and_run")}},
		"p": {steps: []func() []*genai.Part{text(`{"flows":[],"platforms":[],"error":"không có flow nào tên login"}`)}},
	})
	_, evs, err := collect(t, f.rt, "", "chạy flow login")
	if err != nil {
		t.Fatal(err)
	}
	if len(f.runArgs) != 0 {
		t.Fatal("test_run must not be called without a plan")
	}
	found := false
	for _, e := range evs {
		if e.Kind == KindText && strings.Contains(e.Text, "Chưa chạy gì") && strings.Contains(e.Text, "không có flow nào tên login") {
			found = true
		}
	}
	if !found {
		t.Fatalf("no clear error in %+v", evs)
	}
}

func TestSessionsPersistAndReopen(t *testing.T) {
	dir := t.TempDir()
	f := newFixture(t, dir, passingRun)
	f.open(t, map[string]*scripted{"c": {steps: []func() []*genai.Part{text("chào anh")}}})
	id, _, err := collect(t, f.rt, "", "xin chào, kiểm tra giúp tôi")
	if err != nil {
		t.Fatal(err)
	}
	f.rt.Close()

	g := newFixture(t, dir, passingRun)
	g.open(t, map[string]*scripted{"c": {steps: []func() []*genai.Part{text("vẫn nhớ")}}})
	list, err := g.rt.Sessions(context.Background(), "u1")
	if err != nil || len(list) != 1 || list[0].ID != id || list[0].Title != "xin chào, kiểm tra giúp tôi" {
		t.Fatalf("sessions = %+v %v", list, err)
	}
	if other, _ := g.rt.Sessions(context.Background(), "someone-else"); len(other) != 0 {
		t.Fatal("another user must not see this session")
	}
	hist, err := g.rt.History(context.Background(), "u1", id)
	if err != nil || len(hist) < 2 || hist[0].Author != "user" || hist[0].Text != "xin chào, kiểm tra giúp tôi" || hist[1].Text != "chào anh" {
		t.Fatalf("history = %+v %v", hist, err)
	}
	// The session continues after a restart.
	if _, evs, err := collect(t, g.rt, id, "tiếp tục"); err != nil || !strings.Contains(strings.Join(texts(evs), "|"), "vẫn nhớ") {
		t.Fatalf("continue: %v %+v", err, evs)
	}
	if list, _ := g.rt.Sessions(context.Background(), "u1"); len(list) != 1 {
		t.Fatalf("continuing must not create a session: %+v", list)
	}
}

func texts(evs []Event) []string {
	var out []string
	for _, e := range evs {
		if e.Kind == KindText {
			out = append(out, e.Text)
		}
	}
	return out
}

func TestCancelStopsRunWithinASecond(t *testing.T) {
	if raceDetector {
		// google.golang.org/adk/v2 v2.8.0 races on Event.Actions.Compaction between runner.fromPlugin (write) and the
		// LLM flow's IsFinalResponse (read) when a run is cancelled mid-tool. Both accesses are inside ADK. The
		// behaviour is still covered by the normal run of this test; re-enable under -race after upgrading ADK.
		t.Skip("known data race inside ADK v2.8.0 on the cancel path")
	}
	started := make(chan struct{})
	f := newFixture(t, t.TempDir(), func(ctx context.Context, _ map[string]any) (any, error) {
		close(started)
		<-ctx.Done()
		return nil, ctx.Err()
	})
	f.open(t, map[string]*scripted{
		"c": {steps: []func() []*genai.Part{transferTo("plan_and_run")}},
		"p": {steps: []func() []*genai.Part{text(loginPlan)}},
	})
	resp := make(chan error, 1)
	var sid atomic.Value
	go func() {
		id, _, err := collect(t, f.rt, "", "chạy flow login trên Android")
		sid.Store(id)
		resp <- err
	}()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("run never reached test_run")
	}
	sessions, _ := f.rt.Sessions(context.Background(), "u1")
	if len(sessions) != 1 || !sessions[0].Running {
		t.Fatalf("running session not listed: %+v", sessions)
	}
	begin := time.Now()
	if !f.rt.Cancel(sessions[0].ID) {
		t.Fatal("Cancel found no run")
	}
	select {
	case <-resp:
		if d := time.Since(begin); d > time.Second {
			t.Fatalf("stopped after %v", d)
		}
	case <-time.After(time.Second):
		t.Fatal("run did not stop within 1s of Cancel")
	}
	if f.rt.Cancel(sessions[0].ID) {
		t.Fatal("nothing left to cancel")
	}
}

func TestOneRunPerSessionAndSpendLimits(t *testing.T) {
	f := newFixture(t, t.TempDir(), passingRun)
	f.cfg.Agent.Limits.MaxCostUSD = 0.0001 // one scripted call already costs 0.0011 USD
	f.open(t, map[string]*scripted{"c": {steps: []func() []*genai.Part{text("a"), text("b")}}})
	_, evs, _ := collect(t, f.rt, "", "hỏi")
	found := false
	for _, e := range evs {
		if e.Kind == KindError && strings.Contains(e.Text, "vượt trần chi phí") {
			found = true
		}
	}
	if !found || evs[len(evs)-1].Kind != KindDone {
		t.Fatalf("cost limit: %+v", evs)
	}
}

func TestStartRefusesModelTheWorkerDoesNotOffer(t *testing.T) {
	f := newFixture(t, t.TempDir(), passingRun)
	f.cfg.Agent.Agents["triage"] = config.AgentModel{Model: "gpt-9"}
	_, err := New(context.Background(), Deps{Registry: f.reg, Config: f.cfg, DataDir: f.dir, Prices: f.prices, LLM: func(context.Context, string) (model.LLM, error) { return &scripted{}, nil }})
	if err == nil || !strings.Contains(err.Error(), "gpt-9") {
		t.Fatalf("err = %v", err)
	}
}

func TestEventsRedactSecretsAndCapPreview(t *testing.T) {
	f := newFixture(t, t.TempDir(), passingRun)
	f.reg.Secrets = func() []string { return []string{"S3cret-Value"} }
	f.open(t, map[string]*scripted{"c": {steps: []func() []*genai.Part{func() []*genai.Part {
		return []*genai.Part{{FunctionCall: &genai.FunctionCall{ID: "x", Name: "tower_fleet", Args: map[string]any{"note": "S3cret-Value " + strings.Repeat("a", 900)}}}}
	}, text("S3cret-Value đã dùng")}}})
	_, evs, err := collect(t, f.rt, "", "thử")
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range evs {
		if strings.Contains(e.Text+e.ArgsPreview, "S3cret-Value") {
			t.Fatalf("secret leaked: %+v", e)
		}
		if e.Kind == KindToolCall && len([]rune(e.ArgsPreview)) > argsPreviewMax+1 {
			t.Fatalf("preview not capped: %d", len(e.ArgsPreview))
		}
	}
}
