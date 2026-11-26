package runtime

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"

	adkmemory "google.golang.org/adk/v2/memory"
	"google.golang.org/adk/v2/session"
	"google.golang.org/genai"

	"chatqa/internal/agentx/memory"
	"chatqa/internal/agentx/workflows"
	"chatqa/internal/testengine"
)

func call(id, name string, args map[string]any) func() []*genai.Part {
	return func() []*genai.Part {
		return []*genai.Part{{FunctionCall: &genai.FunctionCall{ID: id, Name: name, Args: args}}}
	}
}

// writeFlowResults writes a testengine.db with login on iOS failing twice and passing once, through the engine's own
// schema and Save.
func writeFlowResults(t *testing.T, path string) {
	t.Helper()
	m, err := testengine.OpenMetrics(path)
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	now := time.Now()
	for i, passed := range []bool{false, false, true} {
		at := now.Add(-time.Duration(3-i) * 24 * time.Hour)
		fr := testengine.FlowRun{DeviceID: "sim-1", Platform: "ios", Driver: "maestro", Flow: "01_login.yaml", Passed: passed}
		if !passed {
			fr.FailureClass, fr.Error = "element_not_found", "không thấy nút Đăng nhập"
		}
		if err := m.Save(testengine.RunRecord{ID: "run-" + string(rune('a'+i)), App: "mexpress", StartedAt: at, FinishedAt: at.Add(time.Minute)}, []testengine.FlowRun{fr}); err != nil {
			t.Fatal(err)
		}
	}
}

func searchMemory(t *testing.T, f *fixture, query string) []adkmemory.Entry {
	t.Helper()
	resp, err := f.rt.memory.SearchMemory(context.Background(), &adkmemory.SearchRequest{AppName: AppName, UserID: "u1", Query: query})
	if err != nil {
		t.Fatal(err)
	}
	return resp.Memories
}

func TestRememberAsksThenRecallFindsIt(t *testing.T) {
	f := newFixture(t, t.TempDir(), passingRun)
	coord := &scripted{steps: []func() []*genai.Part{
		call("m1", "remember", map[string]any{"kind": "fix", "fact": "Flow login iOS hay lỗi vì bàn phím che nút Đăng nhập"}),
		text("Đã ghi nhớ."),
		call("m2", "recall", map[string]any{"query": "login ios"}),
		text("Theo trí nhớ: bàn phím che nút."),
	}}
	f.open(t, map[string]*scripted{"c": coord})

	id, evs, err := collect(t, f.rt, "", "nhớ giúp: flow login iOS hay lỗi vì bàn phím che nút Đăng nhập")
	if err != nil {
		t.Fatal(err)
	}
	c := find(evs, KindConfirmation)
	if c == nil || c.ToolName != "remember" || c.Risk != "write" || c.Consequence == "" {
		t.Fatalf("remember must ask first: %+v", evs)
	}
	if got := searchMemory(t, f, "bàn phím"); len(got) != 0 {
		t.Fatalf("nothing is stored before the answer: %+v", got)
	}
	if _, err := approve(t, f, id, c.ToolCallID, true); err != nil {
		t.Fatal(err)
	}
	got := searchMemory(t, f, "bàn phím che nút")
	if len(got) == 0 || got[0].CustomMetadata["kind"] != memory.KindFix {
		t.Fatalf("after approval = %+v", got)
	}

	_, evs, err = collect(t, f.rt, id, "flow login ios sao hay lỗi?")
	if err != nil || !strings.Contains(allText(evs), "Theo trí nhớ") {
		t.Fatalf("recall turn: %v %+v", err, evs)
	}
	reqs := coord.requests()
	if len(reqs) != 4 || !strings.Contains(reqs[3].body, "bàn phím che nút") || !strings.Contains(reqs[3].body, `"source":"memory"`) {
		t.Fatalf("the model must read the recalled fix: %+v", reqs)
	}
	// Every turn leaves a summary of the session in memory.
	if got := searchMemory(t, f, "Theo trí nhớ"); len(got) == 0 || got[0].CustomMetadata["id"] != "session:"+id {
		t.Fatalf("session summary = %+v", got)
	}
}

func TestRememberRejectedStoresNothing(t *testing.T) {
	f := newFixture(t, t.TempDir(), passingRun)
	f.open(t, map[string]*scripted{"c": {steps: []func() []*genai.Part{
		call("m1", "remember", map[string]any{"kind": "fact", "fact": "máy sim-1 chậm"}), text("Không lưu."),
	}}})
	id, evs, err := collect(t, f.rt, "", "nhớ: máy sim-1 chậm")
	if err != nil {
		t.Fatal(err)
	}
	c := find(evs, KindConfirmation)
	if c == nil {
		t.Fatalf("no confirmation: %+v", evs)
	}
	if _, err := approve(t, f, id, c.ToolCallID, false); err != nil {
		t.Fatal(err)
	}
	if got := searchMemory(t, f, "sim-1 chậm"); len(got) != 0 {
		for _, e := range got {
			if e.CustomMetadata["kind"] != memory.KindSessionSummary {
				t.Fatalf("a rejected remember stored %+v", e)
			}
		}
	}
}

func TestRecallAnswersFlakyQuestionFromData(t *testing.T) {
	dir := t.TempDir()
	writeFlowResults(t, filepath.Join(dir, "testengine.db"))
	f := newFixture(t, dir, passingRun)
	coord := &scripted{steps: []func() []*genai.Part{
		call("r1", "recall", map[string]any{"query": "Flow login iOS sao hay lỗi?"}),
		text("Flow login trên iOS lỗi 2/3 lượt gần đây, lỗi chính là không thấy nút."),
	}}
	f.open(t, map[string]*scripted{"c": coord})
	if _, _, err := collect(t, f.rt, "", "Flow login iOS sao hay lỗi?"); err != nil {
		t.Fatal(err)
	}
	reqs := coord.requests()
	if len(reqs) != 2 {
		t.Fatalf("requests = %d", len(reqs))
	}
	body := reqs[1].body
	for _, want := range []string{`"flow":"01_login.yaml"`, `"platform":"ios"`, `"runs":3`, `"fails":2`, "element_not_found"} {
		if !strings.Contains(body, want) {
			t.Fatalf("recall result misses %s: %s", want, body)
		}
	}
}

func TestPipelineSaveMemoryRefreshesFlakyForThePlanner(t *testing.T) {
	dir := t.TempDir()
	f := newFixture(t, dir, passingRun)
	planner := &scripted{steps: []func() []*genai.Part{text(loginPlan), text(loginPlan)}}
	f.open(t, map[string]*scripted{"p": planner, "r": {steps: []func() []*genai.Part{text("Báo cáo 1"), text("Báo cáo 2")}}})
	// The flows the run recorded land in testengine.db after the runtime started.
	writeFlowResults(t, filepath.Join(dir, "testengine.db"))

	run := func() string {
		evs := newEvents()
		id, err := f.rt.StartPipeline(context.Background(), "u1", workflows.Request{Repo: repoMexpress, From: "abc", To: "def"}, evs.add)
		if err != nil {
			t.Fatal(err)
		}
		evs.wait(t)
		waitIdle(t, f.rt, id)
		return id
	}
	id := run()
	if f.state(t, id, workflows.StateStatus) != workflows.StatusDone {
		t.Fatalf("status = %q", f.state(t, id, workflows.StateStatus))
	}
	top, err := f.rt.memory.TopFlaky(context.Background(), 10)
	if err != nil || len(top) != 1 || top[0].Flow != "01_login.yaml" || top[0].Fails != 2 {
		t.Fatalf("flaky after save_memory = %+v %v", top, err)
	}
	if strings.Contains(planner.requests()[0].system, "01_login.yaml ios") {
		t.Fatal("the first plan was made before the statistics existed")
	}
	run()
	reqs := planner.requests()
	if sys := reqs[len(reqs)-1].system; !strings.Contains(sys, "<memory>") || !strings.Contains(sys, "mexpress/01_login.yaml ios: lỗi 2/3 lượt") {
		t.Fatalf("planner prompt lacks the flaky statistics: %q", sys)
	}
	// The Reporter's text is the pipeline session's summary.
	if got := searchMemory(t, f, "Báo cáo"); len(got) != 2 {
		t.Fatalf("pipeline summaries = %+v", got)
	}
}

func failingCart(context.Context, map[string]any) (any, error) {
	return map[string]any{
		"run": map[string]any{"id": "run-9", "app": "mexpress", "failed": 1},
		"flows": []map[string]any{{"flow": "01_login.yaml", "deviceId": "emu-1", "platform": "android", "passed": false,
			"failureClass": "element_not_found", "error": "không thấy nút Thanh toán"}},
	}, nil
}

func TestTriageReadsKnownIssuesAndItsProposalWaitsForApproval(t *testing.T) {
	dir := t.TempDir()
	f := newFixture(t, dir, failingCart)
	f.cfg.Pipeline.RetryFailed = new(0)
	triage := &scripted{steps: []func() []*genai.Part{
		call("k1", "known_issues", map[string]any{"query": "không thấy nút Thanh toán"}),
		call("k2", "remember", map[string]any{"kind": "known_issue", "fact": "", "symptom": "Không thấy nút Thanh toán trên Android",
			"cause": "nút đổi id sau bản 5.2", "fix": "dùng selector theo text", "category": "selector", "app": "mexpress", "flow": "01_login.yaml", "platform": "android"}),
		text(`[{"flow":"01_login.yaml","platform":"android","category":"selector","evidence":"không thấy nút Thanh toán","confidence":0.8}]`),
	}}
	f.open(t, map[string]*scripted{
		"p": {steps: []func() []*genai.Part{text(loginPlan)}},
		"t": triage,
		"r": {steps: []func() []*genai.Part{text("Báo cáo: đăng nhập lỗi selector")}},
	})
	if _, err := f.rt.memory.Remember(context.Background(), memory.Note{Kind: memory.SourceKnownIssue, Symptom: "Không thấy nút Thanh toán",
		Cause: "nút bị che bởi banner khuyến mãi", Fix: "đóng banner trước", Category: "selector", Author: "tester"}); err != nil {
		t.Fatal(err)
	}

	evs := newEvents()
	id, err := f.rt.StartPipeline(context.Background(), "u1", workflows.Request{Repo: repoMexpress, From: "abc", To: "def"}, evs.add)
	if err != nil {
		t.Fatal(err)
	}
	got := evs.wait(t)
	waitIdle(t, f.rt, id)
	reqs := triage.requests()
	if len(reqs) < 2 || !strings.Contains(reqs[1].body, "banner khuyến mãi") {
		t.Fatalf("the Triage must read the known issue: %+v", reqs)
	}
	// The report is written; the proposal waits at save_memory and nothing is stored yet.
	if !strings.Contains(allText(got), "đăng nhập lỗi selector") {
		t.Fatalf("report missing: %+v", got)
	}
	req := find(got, KindRequestInput)
	if req == nil || !strings.Contains(req.Payload, "nút đổi id sau bản 5.2") || !strings.Contains(req.Payload, `"key":"k2"`) {
		t.Fatalf("the proposal must wait for approval: %+v", got)
	}
	if st := f.state(t, id, workflows.StateStatus); st != workflows.StatusWaitingApproval {
		t.Fatalf("status while waiting = %q", st)
	}
	if issues, _ := f.rt.memory.KnownIssues(context.Background(), "đổi id", 5); len(issues) != 0 {
		t.Fatalf("stored before approval: %+v", issues)
	}
	f.rt.Close()

	// The question survives a restart; the answer stores the approved proposal and ends the run.
	g := newFixture(t, dir, failingCart)
	g.open(t, nil)
	if pend := g.rt.Pending("u1"); len(pend) != 1 || pend[0].CallID != req.ToolCallID {
		t.Fatalf("after restart pending = %+v", pend)
	}
	var after []Event
	if err := g.rt.Respond(context.Background(), "u1", id, req.ToolCallID, []byte(`{"approved_memories":["k2"],"note":"đúng rồi"}`),
		func(e Event) { after = append(after, e) }); err != nil {
		t.Fatalf("respond: %v (%+v)", err, after)
	}
	issues, err := g.rt.memory.KnownIssues(context.Background(), "đổi id selector theo text", 5)
	if err != nil || len(issues) != 1 || issues[0].CreatedBy != "triage" || issues[0].Platform != "android" {
		t.Fatalf("known issue after approval = %+v %v", issues, err)
	}
	if st := g.state(t, id, workflows.StateStatus); st != workflows.StatusDone {
		t.Fatalf("status after approval = %q (events %+v)", st, after)
	}
	if txt := allText(after); !strings.Contains(txt, "Đã lưu 1 mục vào trí nhớ QA, bỏ 0") || !strings.Contains(txt, "đúng rồi") {
		t.Fatalf("closing line = %q", txt)
	}
	if len(g.runArgs) != 0 {
		t.Fatal("answering must not run the flows again")
	}
	if p := g.rt.memory.Proposals(stateOf(t, g, id)); len(p) != 0 {
		t.Fatalf("handled proposals must be cleared: %+v", p)
	}
}

func stateOf(t *testing.T, f *fixture, id string) session.ReadonlyState {
	t.Helper()
	resp, err := f.rt.sessions.Get(context.Background(), &session.GetRequest{AppName: AppName, UserID: "u1", SessionID: id})
	if err != nil {
		t.Fatal(err)
	}
	return resp.Session.State()
}

func TestCompactionSummarizesOnTheCheapModelAndChatContinues(t *testing.T) {
	f := newFixture(t, t.TempDir(), passingRun)
	// Every scripted reply reports a 1000-token prompt, so from the second turn on the prompt is over the threshold.
	f.cfg.Agent.Compaction.TokenThreshold = 1005
	f.cfg.Agent.Compaction.EventRetention = 2
	coord := &scripted{}
	for i := range 6 {
		coord.steps = append(coord.steps, text("trả lời số "+string(rune('1'+i))))
	}
	summarizer := &scripted{}
	for range 6 {
		summarizer.steps = append(summarizer.steps, text("TÓM TẮT: người dùng hỏi về flow thanh toán"))
	}
	f.open(t, map[string]*scripted{"c": coord, "s": summarizer})

	id := ""
	for i := range 6 {
		var evs []Event
		var err error
		id, evs, err = collect(t, f.rt, id, "câu hỏi số "+string(rune('1'+i))+" về flow thanh toán")
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(allText(evs), "trả lời số "+string(rune('1'+i))) {
			t.Fatalf("turn %d did not answer: %+v", i+1, evs)
		}
	}
	if len(summarizer.requests()) == 0 {
		t.Fatal("the summarizer alias was never called")
	}
	resp, err := f.rt.sessions.Get(context.Background(), &session.GetRequest{AppName: AppName, UserID: "u1", SessionID: id})
	if err != nil {
		t.Fatal(err)
	}
	compacted := false
	for ev := range resp.Session.Events().All() {
		if c := ev.Actions.Compaction; c != nil && c.CompactedContent != nil && strings.Contains(c.CompactedContent.Parts[0].Text, "TÓM TẮT") {
			compacted = true
		}
	}
	if !compacted {
		t.Fatal("no compaction event carries the summarizer's text")
	}
	reqs := coord.requests()
	last := reqs[len(reqs)-1]
	if last.contents >= 11 || !strings.Contains(last.body, "TÓM TẮT") {
		t.Fatalf("the prompt after compaction has %d contents (11 without it): %s", last.contents, last.body)
	}
	if got := searchMemory(t, f, "thanh toán"); len(got) == 0 || !strings.Contains(got[0].Content.Parts[0].Text, "TÓM TẮT") {
		t.Fatalf("the session summary must use the compaction summary: %+v", got)
	}
}
