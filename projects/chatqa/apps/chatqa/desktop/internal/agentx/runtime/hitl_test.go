package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"google.golang.org/genai"

	"chatqa/internal/agentx/workflows"
	"chatqa/internal/testengine"
)

const orderPlan = `{"flows":[{"app":"mexpress","flow":"02_order/001_tao.yaml","reason":"tạo đơn"}],"platforms":["android"],"error":""}`

// orderStore is a flow store with one order flow and the app's saved BRANCH.
func orderStore(t *testing.T, branch string) *testengine.FlowStore {
	t.Helper()
	root := t.TempDir()
	p := filepath.Join(root, "mexpress", "02_order", "001_tao.yaml")
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte("appId: x\n---\n- launchApp\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	s := testengine.NewFlowStore(root)
	if _, err := s.SetEnv("mexpress", "all", map[string]string{"BRANCH": branch}); err != nil {
		t.Fatal(err)
	}
	return s
}

func find(evs []Event, kind string) *Event {
	for i := range evs {
		if evs[i].Kind == kind {
			return &evs[i]
		}
	}
	return nil
}

func allText(evs []Event) string { return strings.Join(texts(evs), "\n") }

// askToRunOrder makes the chat team plan an order flow; the Runner must stop and ask.
func askToRunOrder(t *testing.T, branch string) (*fixture, string, Event) {
	t.Helper()
	f := newFixture(t, t.TempDir(), passingRun)
	f.flows = orderStore(t, branch)
	f.open(t, map[string]*scripted{
		"c": {steps: []func() []*genai.Part{transferTo("plan_and_run")}},
		"p": {steps: []func() []*genai.Part{text(orderPlan)}},
	})
	id, evs, err := collect(t, f.rt, "", "tạo đơn trên Android")
	if err != nil {
		t.Fatal(err)
	}
	c := find(evs, KindConfirmation)
	if c == nil || c.ToolName != "test_run" || c.ToolCallID == "" || !strings.Contains(c.Text, "02_order/001_tao.yaml") || c.Risk != "run" || c.Consequence == "" {
		t.Fatalf("confirmation = %+v in %+v", c, evs)
	}
	if !strings.Contains(c.ArgsPreview, "emu-1") || len(f.runArgs) != 0 {
		t.Fatalf("args=%q runs=%d: nothing may run before the answer", c.ArgsPreview, len(f.runArgs))
	}
	return f, id, *c
}

func approve(t *testing.T, f *fixture, id, callID string, ok bool) ([]Event, error) {
	t.Helper()
	var evs []Event
	err := f.rt.Approve(context.Background(), "u1", id, callID, ok, nil, func(e Event) { evs = append(evs, e) })
	return evs, err
}

func TestChatRunWaitsForApprovalThenRuns(t *testing.T) {
	f, id, c := askToRunOrder(t, "GLOBAL0 - Test")
	pend := f.rt.Pending("u1")
	if len(pend) != 1 || pend[0].SessionID != id || pend[0].Kind != KindConfirmation || pend[0].CallID != c.ToolCallID || pend[0].Title != "tạo đơn trên Android" {
		t.Fatalf("pending = %+v", pend)
	}
	if list, _ := f.rt.Sessions(context.Background(), "u1"); len(list) != 1 || !list[0].Pending {
		t.Fatalf("sessions = %+v", list)
	}
	if other := f.rt.Pending("someone-else"); len(other) != 0 {
		t.Fatalf("another user sees %+v", other)
	}
	evs, err := approve(t, f, id, c.ToolCallID, true)
	if err != nil {
		t.Fatal(err)
	}
	select {
	case a := <-f.runArgs:
		if flows, _ := a["flows"].([]any); len(flows) != 1 || flows[0] != "02_order/001_tao.yaml" {
			t.Fatalf("test_run args = %v", a)
		}
	default:
		t.Fatalf("approved run did not call test_run: %+v", evs)
	}
	if !strings.Contains(allText(evs), "1 đạt") || evs[len(evs)-1].Kind != KindDone {
		t.Fatalf("events = %+v", evs)
	}
	if len(f.rt.Pending("u1")) != 0 {
		t.Fatal("an answered confirmation is no longer pending")
	}
	if _, err := approve(t, f, id, c.ToolCallID, true); !errors.Is(err, ErrNotPending) {
		t.Fatalf("a second answer must be refused, got %v", err)
	}
	hist, _ := f.rt.History(context.Background(), "u1", id)
	if h := find(hist, KindConfirmation); h == nil || !h.Resolved {
		t.Fatalf("history confirmation = %+v", h)
	}
}

func TestChatRunRejectedRunsNothing(t *testing.T) {
	f, id, c := askToRunOrder(t, "GLOBAL0 - Test")
	evs, err := approve(t, f, id, c.ToolCallID, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(f.runArgs) != 0 || !strings.Contains(allText(evs), "Đã từ chối") {
		t.Fatalf("runs=%d events=%+v", len(f.runArgs), evs)
	}
}

func TestConfirmationDroppedByNewMessage(t *testing.T) {
	f, id, c := askToRunOrder(t, "GLOBAL0 - Test")
	if _, _, err := collect(t, f.rt, id, "thôi, làm việc khác"); err != nil {
		t.Fatal(err)
	}
	if len(f.rt.Pending("u1")) != 0 {
		t.Fatal("typing a new message drops the open confirmation")
	}
	if _, err := approve(t, f, id, c.ToolCallID, true); !errors.Is(err, ErrNotPending) {
		t.Fatalf("err = %v", err)
	}
	if _, err := approve(t, f, id, "made-up", true); !errors.Is(err, ErrNotPending) {
		t.Fatalf("unknown id: %v", err)
	}
}

func TestGuardBlocksNonGlobalPostOfficeAfterApproval(t *testing.T) {
	f, id, c := askToRunOrder(t, "HCM01 - Quan 1")
	evs, err := approve(t, f, id, c.ToolCallID, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(f.runArgs) != 0 {
		t.Fatal("an approval never lifts the post-office rule")
	}
	if txt := allText(evs); !strings.Contains(txt, "HCM01") || !strings.Contains(txt, "không chạy được") {
		t.Fatalf("events = %q", txt)
	}
}

func waitingPipeline(t *testing.T, f *fixture) (string, Event) {
	t.Helper()
	evs := newEvents()
	id, err := f.rt.StartPipeline(context.Background(), "u1", workflows.Request{Repo: repoMexpress, From: "abc", To: "def"}, evs.add)
	if err != nil {
		t.Fatal(err)
	}
	got := evs.wait(t)
	waitIdle(t, f.rt, id)
	req := find(got, KindRequestInput)
	if req == nil || req.ToolCallID == "" || !strings.Contains(req.Payload, "mexpress/02_order/001_tao.yaml") || !strings.Contains(req.Text, "duyệt") {
		t.Fatalf("request = %+v in %+v", req, got)
	}
	if f.state(t, id, workflows.StateStatus) != workflows.StatusWaitingApproval || len(f.runArgs) != 0 {
		t.Fatalf("status=%q runs=%d", f.state(t, id, workflows.StateStatus), len(f.runArgs))
	}
	return id, *req
}

func TestPipelineApprovalSurvivesRestart(t *testing.T) {
	dir := t.TempDir()
	store := orderStore(t, "GLOBAL0 - Test")
	f := newFixture(t, dir, passingRun)
	f.flows = store
	f.open(t, map[string]*scripted{"p": {steps: []func() []*genai.Part{text(orderPlan)}}})
	id, req := waitingPipeline(t, f)
	if w := f.rt.WaitingPipelines(); len(w) != 1 || w[0].SessionID != id || w[0].Title != "Pipeline mexpress abc..def" {
		t.Fatalf("waiting = %+v", w)
	}
	f.rt.Close()

	g := newFixture(t, dir, passingRun)
	g.flows = store
	g.open(t, map[string]*scripted{"r": {steps: []func() []*genai.Part{text("Báo cáo: đã tạo đơn")}}})
	pend := g.rt.Pending("u1")
	if len(pend) != 1 || pend[0].Kind != KindRequestInput || pend[0].CallID != req.ToolCallID {
		t.Fatalf("after restart pending = %+v", pend)
	}
	hist, _ := g.rt.History(context.Background(), "u1", id)
	if h := find(hist, KindRequestInput); h == nil || h.Resolved || h.Payload == "" {
		t.Fatalf("history request = %+v", h)
	}

	var evs []Event
	reply := json.RawMessage(`{"approved_flows":["mexpress/02_order/001_tao.yaml"]}`)
	if err := g.rt.Respond(context.Background(), "u1", id, req.ToolCallID, reply, func(e Event) { evs = append(evs, e) }); err != nil {
		t.Fatalf("respond: %v (%+v)", err, evs)
	}
	select {
	case a := <-g.runArgs:
		if flows, _ := a["flows"].([]any); len(flows) != 1 || flows[0] != "02_order/001_tao.yaml" {
			t.Fatalf("test_run args = %v", a)
		}
	default:
		t.Fatalf("approved pipeline did not run: %+v", evs)
	}
	if g.state(t, id, workflows.StateStatus) != workflows.StatusDone || !strings.Contains(allText(evs), "Báo cáo: đã tạo đơn") {
		t.Fatalf("status=%q events=%+v", g.state(t, id, workflows.StateStatus), evs)
	}
	if len(g.rt.Pending("u1")) != 0 || len(g.rt.WaitingPipelines()) != 0 {
		t.Fatal("an answered pipeline no longer waits")
	}
	if err := g.rt.Respond(context.Background(), "u1", id, req.ToolCallID, reply, func(Event) {}); !errors.Is(err, ErrNotPending) {
		t.Fatalf("a second answer must be refused, got %v", err)
	}
}

func TestPipelineFromChatResumesWithoutCoordinator(t *testing.T) {
	f := newFixture(t, t.TempDir(), passingRun)
	f.flows = orderStore(t, "GLOBAL0 - Test")
	coord := &scripted{steps: []func() []*genai.Part{transferTo("pipeline")}}
	f.open(t, map[string]*scripted{
		"c": coord,
		"p": {steps: []func() []*genai.Part{text(orderPlan)}},
		"r": {steps: []func() []*genai.Part{text("Báo cáo xong")}},
	})
	id, evs, err := collect(t, f.rt, "", "chạy pipeline cho "+repoMexpress+" commit abc..def")
	if err != nil {
		t.Fatal(err)
	}
	req := find(evs, KindRequestInput)
	if req == nil {
		t.Fatalf("no approval request: %+v", evs)
	}
	var after []Event
	if err := f.rt.Respond(context.Background(), "u1", id, req.ToolCallID, json.RawMessage(`{"approved_flows":[]}`), func(e Event) { after = append(after, e) }); err != nil {
		t.Fatal(err)
	}
	if len(f.runArgs) != 0 || f.state(t, id, workflows.StateStatus) != workflows.StatusDone {
		t.Fatalf("runs=%d status=%q events=%+v", len(f.runArgs), f.state(t, id, workflows.StateStatus), after)
	}
	coord.mu.Lock()
	calls := coord.n
	coord.mu.Unlock()
	if calls != 1 {
		t.Fatalf("the Coordinator ran %d times; the answer must go straight to the pipeline", calls)
	}
}

func TestRespondRejectsBadAnswers(t *testing.T) {
	f := newFixture(t, t.TempDir(), passingRun)
	f.flows = orderStore(t, "GLOBAL0 - Test")
	f.open(t, map[string]*scripted{"p": {steps: []func() []*genai.Part{text(orderPlan)}}})
	id, req := waitingPipeline(t, f)
	if err := f.rt.Respond(context.Background(), "u1", id, req.ToolCallID, json.RawMessage(`[1,2]`), func(Event) {}); err == nil {
		t.Fatal("a non-object answer must be refused")
	}
	if err := f.rt.Respond(context.Background(), "u1", id, "other", json.RawMessage(`{"approved_flows":[]}`), func(Event) {}); !errors.Is(err, ErrNotPending) {
		t.Fatalf("unknown interrupt: %v", err)
	}
	var evs []Event
	err := f.rt.Respond(context.Background(), "u1", id, req.ToolCallID, json.RawMessage(`{"note":"thiếu"}`), func(e Event) { evs = append(evs, e) })
	if err == nil || !strings.Contains(err.Error(), "approved_flows") || len(evs) != 0 || len(f.runArgs) != 0 {
		t.Fatalf("schema mismatch: err=%v events=%+v", err, evs)
	}
	if len(f.rt.Pending("u1")) != 1 {
		t.Fatal("a refused answer leaves the request open")
	}
}
