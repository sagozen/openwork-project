package workflows

import (
	"context"
	"encoding/json"
	"iter"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"

	"google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/model"
	"google.golang.org/adk/v2/runner"
	"google.golang.org/adk/v2/session"
	"google.golang.org/adk/v2/workflow"
	"google.golang.org/genai"

	"chatqa/internal/agentx/agents"
	"chatqa/internal/agentx/memory"
	"chatqa/internal/agentx/store"
	"chatqa/internal/tools"
)

// scripted answers every call with the same text and counts the calls. Safe for concurrent use.
type scripted struct {
	mu    sync.Mutex
	text  string
	calls int
	input []string // user text of each request
	tools []string // tool names offered in the last request
}

func (s *scripted) offered() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := slices.Clone(s.tools)
	slices.Sort(out)
	return out
}

func (s *scripted) Name() string { return "scripted" }

func (s *scripted) GenerateContent(_ context.Context, req *model.LLMRequest, _ bool) iter.Seq2[*model.LLMResponse, error] {
	return func(yield func(*model.LLMResponse, error) bool) {
		s.mu.Lock()
		s.calls++
		var in strings.Builder
		for _, c := range req.Contents {
			if c.Role == genai.RoleUser {
				for _, p := range c.Parts {
					in.WriteString(p.Text)
				}
			}
		}
		s.input = append(s.input, in.String())
		s.tools = nil
		if req.Config != nil {
			for _, tl := range req.Config.Tools {
				for _, fd := range tl.FunctionDeclarations {
					s.tools = append(s.tools, fd.Name)
				}
			}
		}
		text := s.text
		s.mu.Unlock()
		yield(&model.LLMResponse{Content: genai.NewContentFromText(text, genai.RoleModel), TurnComplete: true}, nil)
	}
}

func (s *scripted) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.calls
}

// devices is a fake fleet and test_run: emu-1 is android, sim-1 is ios, web-chrome is a web profile. fail says, per platform and flow, how many
// runs fail before it passes (-1 = always fails).
type devices struct {
	mu    sync.Mutex
	fleet []map[string]any
	fail  map[string]int // "android/02_cart.yaml" -> failures before passing
	runs  []runCall
	diffs []map[string]any
}

type runCall struct {
	Platform string
	Flows    []string
}

func (d *devices) registry() *tools.Registry {
	schema := map[string]any{"type": "object"}
	platformOf := map[string]string{"emu-1": "android", "sim-1": "ios", "web-chrome": "web"}
	return tools.NewRegistry(
		tools.Raw("tower_fleet", "máy", "", "DeviceGrid", schema, func(context.Context, json.RawMessage) (any, error) {
			return d.fleet, nil
		}),
		tools.Raw("test_git_diff", "diff", "", "ReportCard", schema, func(_ context.Context, raw json.RawMessage) (any, error) {
			var a map[string]any
			_ = json.Unmarshal(raw, &a)
			d.mu.Lock()
			d.diffs = append(d.diffs, a)
			d.mu.Unlock()
			return map[string]any{"repo": a["repo"], "stats": map[string]any{"files": 2, "add": 10, "del": 3},
				"files": []map[string]any{{"path": "cart/checkout.go", "fn": []string{"Checkout"}}}, "analysis": "guide for chat clients"}, nil
		}),
		tools.Raw("test_run", "chạy", "cqs.run", "RunProgress", schema, func(_ context.Context, raw json.RawMessage) (any, error) {
			var a struct {
				Flows   []string `json:"flows"`
				Devices []string `json:"devices"`
			}
			_ = json.Unmarshal(raw, &a)
			pl := platformOf[a.Devices[0]]
			d.mu.Lock()
			defer d.mu.Unlock()
			d.runs = append(d.runs, runCall{Platform: pl, Flows: a.Flows})
			var flows []map[string]any
			for _, f := range a.Flows {
				key := pl + "/" + f
				n, ok := d.fail[key]
				passed := !ok || n == 0
				if ok && n > 0 {
					d.fail[key] = n - 1
				}
				fr := map[string]any{"flow": f, "deviceId": a.Devices[0], "platform": pl, "passed": passed}
				if !passed {
					fr["failureClass"], fr["error"] = "element_not_found", "không thấy nút Thanh toán"
				}
				flows = append(flows, fr)
			}
			return map[string]any{"run": map[string]any{"id": "run-" + pl + "-" + string(rune('0'+len(d.runs)))}, "flows": flows}, nil
		}),
		tools.Raw("test_report", "báo cáo", "", "ReportCard", schema, func(context.Context, json.RawMessage) (any, error) {
			return map[string]any{"steps": []string{"tapOn Thanh toán: lỗi"}}, nil
		}),
		tools.Raw("device_screenshot", "ảnh", "", "LiveScreen", schema, func(context.Context, json.RawMessage) (any, error) {
			return map[string]any{"deviceId": "emu-1"}, nil
		}),
	)
}

func (d *devices) runCalls() []runCall {
	d.mu.Lock()
	defer d.mu.Unlock()
	return slices.Clone(d.runs)
}

var bothDevices = []map[string]any{{"id": "emu-1", "platform": "android", "state": "ready"}, {"id": "sim-1", "platform": "ios", "state": "connected"}}

const cartPlan = `{"flows":[{"app":"mexpress","flow":"01_login.yaml","reason":"đăng nhập"},{"app":"mexpress","flow":"02_cart.yaml","reason":"giỏ hàng, thanh toán"}],"platforms":[],"error":""}`

type team struct {
	planner, triage, reporter *scripted
	memOpts                   memory.Options // options of the run's memory service
}

func newTeam(plan string) team {
	return team{
		planner:  &scripted{text: plan},
		triage:   &scripted{text: `[{"flow":"02_cart.yaml","platform":"android","category":"selector","evidence":"không thấy nút Thanh toán","confidence":0.7}]`},
		reporter: &scripted{text: "Báo cáo: tính năng giỏ hàng"},
	}
}

type outcome struct {
	events []*session.Event
	state  map[string]any
	err    error
}

func (o outcome) str(key string) string {
	s, _ := o.state[key].(string)
	return s
}

func (o outcome) results(t *testing.T) Results {
	t.Helper()
	var r Results
	if err := json.Unmarshal([]byte(o.str("pipeline.results")), &r); err != nil {
		t.Fatalf("results state: %v (%q)", err, o.str("pipeline.results"))
	}
	return r
}

func (o outcome) texts(author string) []string {
	var out []string
	for _, ev := range o.events {
		if ev.Author == author && !ev.Partial && ev.Content != nil {
			for _, p := range ev.Content.Parts {
				if p.Text != "" {
					out = append(out, p.Text)
				}
			}
		}
	}
	return out
}

func runPipeline(t *testing.T, d *devices, tm team, retries int, input string) outcome {
	t.Helper()
	return startPipeline(t, d, tm, retries).turn(t, genai.NewContentFromText(input, genai.RoleUser))
}

// newMemory is the real memory service and its agent tools over a temporary agent.db.
func newMemory(t *testing.T, opts memory.Options) (*memory.Service, agents.Memory) {
	t.Helper()
	db, _, err := store.Open(filepath.Join(t.TempDir(), "agent.db"))
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { sqlDB.Close() })
	if err := store.Migrate(sqlDB); err != nil {
		t.Fatal(err)
	}
	svc, err := memory.New(sqlDB, opts)
	if err != nil {
		t.Fatal(err)
	}
	mem, err := svc.AgentTools(memory.ToolOptions{})
	if err != nil {
		t.Fatal(err)
	}
	return svc, mem
}

// pipelineSession is one pipeline in one in-memory session, for runs that take more than one turn.
type pipelineSession struct {
	r        *runner.Runner
	sessions session.Service
	id       string
}

func startPipeline(t *testing.T, d *devices, tm team, retries int) *pipelineSession {
	t.Helper()
	reg := d.registry()
	toolset, err := reg.ADKToolset(tools.ADKOptions{})
	if err != nil {
		t.Fatal(err)
	}
	svc, mem := newMemory(t, tm.memOpts)
	planner, err := agents.NewPipelinePlanner(tm.planner, toolset, nil, mem)
	if err != nil {
		t.Fatal(err)
	}
	triage, err := agents.NewTriage(tm.triage, toolset, mem)
	if err != nil {
		t.Fatal(err)
	}
	reporter, err := agents.NewReporter(tm.reporter, mem)
	if err != nil {
		t.Fatal(err)
	}
	pipe, err := NewPostDeploy(Deps{
		Caller: reg, Planner: planner, Triage: triage, Reporter: reporter, RetryFailed: retries, Memory: svc,
		IsDataChanging: func(_, flow string) bool { return strings.HasPrefix(flow, "02_order/") },
	})
	if err != nil {
		t.Fatal(err)
	}
	sessions := session.InMemoryService()
	r, err := runner.New(runner.Config{AppName: "chatqa", Agent: pipe, SessionService: sessions, AutoCreateSession: true})
	if err != nil {
		t.Fatal(err)
	}
	created, err := sessions.Create(context.Background(), &session.CreateRequest{AppName: "chatqa", UserID: "u1"})
	if err != nil {
		t.Fatal(err)
	}
	return &pipelineSession{r: r, sessions: sessions, id: created.Session.ID()}
}

// turn runs one message and returns this turn's events and the session state after it.
func (ps *pipelineSession) turn(t *testing.T, msg *genai.Content) outcome {
	t.Helper()
	var o outcome
	for ev, err := range ps.r.Run(context.Background(), "u1", ps.id, msg, agent.RunConfig{}) {
		if err != nil {
			o.err = err
			break
		}
		o.events = append(o.events, ev)
	}
	got, err := ps.sessions.Get(context.Background(), &session.GetRequest{AppName: "chatqa", UserID: "u1", SessionID: ps.id})
	if err != nil {
		t.Fatal(err)
	}
	o.state = map[string]any{}
	for k, v := range got.Session.State().All() {
		o.state[k] = v
	}
	return o
}

// absPath is an absolute path on this OS ("C:\r" on Windows, "/r" elsewhere): the request check wants full paths.
func absPath(rel string) string {
	return filepath.Join(filepath.VolumeName(os.TempDir())+string(filepath.Separator), filepath.FromSlash(rel))
}

// quoted is s as a JSON string literal, so a Windows path survives inside a JSON request.
func quoted(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

var (
	repoMexpress = absPath("Users/me/code/mexpress")
	repoApp      = absPath("Users/me/code/app")
	repoR        = absPath("r")
	uiRequest    = `{"repo":` + quoted(repoMexpress) + `,"from":"abc1234","to":"def5678","trigger":"ui"}`
)

func TestAllPassSkipsTriage(t *testing.T) {
	d := &devices{fleet: bothDevices}
	tm := newTeam(cartPlan)
	o := runPipeline(t, d, tm, 1, uiRequest)
	if o.err != nil {
		t.Fatal(o.err)
	}
	if tm.triage.count() != 0 || tm.reporter.count() != 1 {
		t.Fatalf("triage=%d reporter=%d, want 0 and 1", tm.triage.count(), tm.reporter.count())
	}
	if o.str("pipeline.status") != StatusDone || o.str("pipeline.trigger") != TriggerUI {
		t.Fatalf("status=%q trigger=%q", o.str("pipeline.status"), o.str("pipeline.trigger"))
	}
	res := o.results(t)
	if res.Failed || len(res.Platforms) != 3 || res.Platforms[0].Skipped || res.Platforms[1].Skipped || !res.Platforms[2].Skipped {
		t.Fatalf("results = %+v", res)
	}
	if runs := d.runCalls(); len(runs) != 2 {
		t.Fatalf("one test_run per platform, got %+v", runs)
	}
	if len(d.diffs) != 1 || d.diffs[0]["repo"] != repoMexpress || d.diffs[0]["commit_a"] != "abc1234" || d.diffs[0]["commit_b"] != "def5678" {
		t.Fatalf("test_git_diff args = %+v", d.diffs)
	}
	// The Planner reads the diff, without the guide meant for chat clients.
	if in := tm.planner.input[0]; !strings.Contains(in, "cart/checkout.go") || strings.Contains(in, "guide for chat clients") {
		t.Fatalf("planner input = %q", in)
	}
	if o.str("pipeline.report") != "Báo cáo: tính năng giỏ hàng" || o.str("user:pipeline.last_repo") != repoMexpress {
		t.Fatalf("report=%q last_repo=%q", o.str("pipeline.report"), o.str("user:pipeline.last_repo"))
	}
}

func TestOneFailRunsTriageThenReporter(t *testing.T) {
	d := &devices{fleet: bothDevices, fail: map[string]int{"android/02_cart.yaml": -1}}
	tm := newTeam(cartPlan)
	o := runPipeline(t, d, tm, 1, uiRequest)
	if o.err != nil {
		t.Fatal(o.err)
	}
	if tm.triage.count() != 1 || tm.reporter.count() != 1 {
		t.Fatalf("triage=%d reporter=%d, want 1 and 1", tm.triage.count(), tm.reporter.count())
	}
	// Triage speaks before the Reporter, and the Reporter's prompt carries the findings.
	order := []string{}
	for _, ev := range o.events {
		if (ev.Author == "triage" || ev.Author == "reporter") && !ev.Partial && ev.Content != nil && (len(order) == 0 || order[len(order)-1] != ev.Author) {
			order = append(order, ev.Author)
		}
	}
	if !slices.Equal(order, []string{"triage", "reporter"}) {
		t.Fatalf("order = %v", order)
	}
	findings, err := agents.ParseTriage(o.str("pipeline.triage"))
	if err != nil || len(findings) != 1 || findings[0].Category != "selector" {
		t.Fatalf("triage state: %+v %v", findings, err)
	}
	res := o.results(t)
	if !res.Failed || res.Platforms[1].Platform != "android" || !res.Platforms[1].Failed() || res.Platforms[0].Failed() {
		t.Fatalf("results = %+v", res)
	}
	// The failed flow was run again alone, and still failed.
	runs := d.runCalls()
	var android []runCall
	for _, r := range runs {
		if r.Platform == "android" {
			android = append(android, r)
		}
	}
	if len(android) != 2 || !slices.Equal(android[1].Flows, []string{"02_cart.yaml"}) {
		t.Fatalf("android runs = %+v", android)
	}
	if o.str("pipeline.status") != StatusDone {
		t.Fatalf("status = %q", o.str("pipeline.status"))
	}
}

func TestDataChangingPlanRoutesGateToApproval(t *testing.T) {
	d := &devices{fleet: bothDevices}
	tm := newTeam(`{"flows":[{"app":"mexpress","flow":"02_order/01_create.yaml","reason":"tạo đơn"}],"platforms":["android"],"error":""}`)
	o := runPipeline(t, d, tm, 1, uiRequest)
	if o.err != nil {
		t.Fatal(o.err)
	}
	var gateRoutes []string
	for _, ev := range o.events {
		if ev.NodeInfo != nil && strings.Contains(ev.NodeInfo.Path, "gate") && ev.Output != nil {
			gateRoutes = ev.Routes
		}
	}
	if !slices.Equal(gateRoutes, []string{"true"}) {
		t.Fatalf("gate routes = %v", gateRoutes)
	}
	if len(d.runCalls()) != 0 || tm.reporter.count() != 0 {
		t.Fatalf("nothing may run before approval: runs=%+v reporter=%d", d.runCalls(), tm.reporter.count())
	}
	if o.str("pipeline.status") != StatusWaitingApproval || !strings.Contains(o.str("pipeline.dangerous"), "02_order/01_create.yaml") {
		t.Fatalf("status=%q dangerous=%q", o.str("pipeline.status"), o.str("pipeline.dangerous"))
	}
	if txt := strings.Join(o.texts(PipelineName), "\n"); !strings.Contains(txt, "02_order/01_create.yaml") || !strings.Contains(txt, "duyệt") {
		t.Fatalf("approval text = %q", txt)
	}
	req := requestedInput(o)
	if req == nil || req.InterruptID == "" || req.ResponseSchema == nil {
		t.Fatalf("no approval request: %+v", req)
	}
	payload, err := decode[ApprovalPayload](req.Payload)
	if err != nil || len(payload.Flows) != 1 || payload.Flows[0].Key != "mexpress/02_order/01_create.yaml" || payload.Flows[0].Reason != "tạo đơn" {
		t.Fatalf("payload = %+v %v", payload, err)
	}
}

// requestedInput is the approval request of a turn, or nil.
func requestedInput(o outcome) *session.RequestInput {
	for _, ev := range o.events {
		if ev.RequestedInput != nil {
			return ev.RequestedInput
		}
	}
	return nil
}

func answer(interruptID string, reply any) *genai.Content {
	return &genai.Content{Role: genai.RoleUser, Parts: []*genai.Part{{FunctionResponse: &genai.FunctionResponse{
		ID: interruptID, Name: workflow.WorkflowInputFunctionCallName, Response: map[string]any{"payload": reply},
	}}}}
}

const orderPlan = `{"flows":[{"app":"mexpress","flow":"01_login.yaml","reason":"đăng nhập"},` +
	`{"app":"mexpress","flow":"02_order/01_create.yaml","reason":"tạo đơn"},{"app":"mexpress","flow":"02_order/02_cancel.yaml","reason":"huỷ đơn"}],"platforms":["android"],"error":""}`

func TestApprovalRunsOnlyApprovedFlows(t *testing.T) {
	d := &devices{fleet: bothDevices}
	tm := newTeam(orderPlan)
	ps := startPipeline(t, d, tm, 0)
	first := ps.turn(t, genai.NewContentFromText(uiRequest, genai.RoleUser))
	req := requestedInput(first)
	if first.err != nil || req == nil {
		t.Fatalf("first turn: %v %+v", first.err, req)
	}
	payload, _ := decode[ApprovalPayload](req.Payload)
	if len(payload.Flows) != 2 || !slices.Equal(payload.Others, []string{"mexpress/01_login.yaml"}) {
		t.Fatalf("payload = %+v", payload)
	}

	second := ps.turn(t, answer(req.InterruptID, map[string]any{"approved_flows": []string{"mexpress/02_order/01_create.yaml"}, "note": "chỉ tạo"}))
	if second.err != nil {
		t.Fatal(second.err)
	}
	runs := d.runCalls()
	if len(runs) != 1 || runs[0].Platform != "android" || !slices.Equal(runs[0].Flows, []string{"01_login.yaml", "02_order/01_create.yaml"}) {
		t.Fatalf("runs = %+v", runs)
	}
	if second.str("pipeline.status") != StatusDone || tm.reporter.count() != 1 || tm.planner.count() != 1 {
		t.Fatalf("status=%q reporter=%d planner=%d", second.str("pipeline.status"), tm.reporter.count(), tm.planner.count())
	}
	txt := strings.Join(second.texts(PipelineName), "\n")
	if !strings.Contains(txt, "Đã duyệt: mexpress/02_order/01_create.yaml") || !strings.Contains(txt, "Không chạy: mexpress/02_order/02_cancel.yaml") || !strings.Contains(txt, "chỉ tạo") {
		t.Fatalf("approval result text = %q", txt)
	}
}

func TestApprovalOfNothingSkipsDevices(t *testing.T) {
	d := &devices{fleet: bothDevices}
	tm := newTeam(`{"flows":[{"app":"mexpress","flow":"02_order/01_create.yaml"}],"platforms":["android"],"error":""}`)
	ps := startPipeline(t, d, tm, 0)
	req := requestedInput(ps.turn(t, genai.NewContentFromText(uiRequest, genai.RoleUser)))
	if req == nil {
		t.Fatal("no approval request")
	}
	o := ps.turn(t, answer(req.InterruptID, map[string]any{"approved_flows": []string{}}))
	if o.err != nil || len(d.runCalls()) != 0 || o.str("pipeline.status") != StatusDone {
		t.Fatalf("err=%v runs=%+v status=%q", o.err, d.runCalls(), o.str("pipeline.status"))
	}
	if !strings.Contains(strings.Join(o.texts(agents.RunnerName), "\n"), "người duyệt không cho chạy flow nào") {
		t.Fatalf("runner texts = %v", o.texts(agents.RunnerName))
	}
}

func TestApprovalAnswerMustMatchSchema(t *testing.T) {
	d := &devices{fleet: bothDevices}
	ps := startPipeline(t, d, newTeam(`{"flows":[{"app":"mexpress","flow":"02_order/01_create.yaml"}],"platforms":["android"],"error":""}`), 0)
	req := requestedInput(ps.turn(t, genai.NewContentFromText(uiRequest, genai.RoleUser)))
	if req == nil {
		t.Fatal("no approval request")
	}
	if o := ps.turn(t, answer(req.InterruptID, map[string]any{"note": "thiếu danh sách"})); o.err == nil || len(d.runCalls()) != 0 {
		t.Fatalf("an answer without approved_flows must fail: err=%v runs=%+v", o.err, d.runCalls())
	}
}

func TestMissingIOSDeviceIsSkippedNotFailed(t *testing.T) {
	d := &devices{fleet: []map[string]any{{"id": "emu-1", "platform": "android", "state": "ready"}, {"id": "sim-1", "platform": "ios", "state": "busy"}}}
	tm := newTeam(cartPlan)
	o := runPipeline(t, d, tm, 1, uiRequest)
	if o.err != nil {
		t.Fatal(o.err)
	}
	res := o.results(t)
	ios := res.Platforms[0]
	if ios.Platform != "ios" || !ios.Skipped || !strings.Contains(ios.Reason, "không có máy ios") || res.Failed {
		t.Fatalf("results = %+v", res)
	}
	if tm.triage.count() != 0 || o.str("pipeline.status") != StatusDone {
		t.Fatalf("triage=%d status=%q", tm.triage.count(), o.str("pipeline.status"))
	}
	for _, r := range d.runCalls() {
		if r.Platform == "ios" {
			t.Fatal("ios must not run")
		}
	}
}

const webPlan = `{"flows":[{"app":"e2e-web","flow":"mo-trang.spec.ts","reason":"mở trang"}],"platforms":["web"],"error":""}`

var allDevices = append(slices.Clone(bothDevices), map[string]any{"id": "web-chrome", "platform": "web", "state": "ready"})

func TestWebPlanRunsOnlyOnTheWebProfile(t *testing.T) {
	d := &devices{fleet: allDevices}
	tm := newTeam(webPlan)
	o := runPipeline(t, d, tm, 1, uiRequest)
	if o.err != nil {
		t.Fatal(o.err)
	}
	runs := d.runCalls()
	if len(runs) != 1 || runs[0].Platform != "web" || !slices.Equal(runs[0].Flows, []string{"mo-trang.spec.ts"}) {
		t.Fatalf("runs = %+v", runs)
	}
	res := o.results(t)
	if res.Failed || len(res.Platforms) != 3 || !res.Platforms[0].Skipped || !res.Platforms[1].Skipped || res.Platforms[2].Platform != "web" || res.Platforms[2].Skipped {
		t.Fatalf("results = %+v", res)
	}
	if tm.triage.count() != 0 || o.str("pipeline.status") != StatusDone {
		t.Fatalf("triage=%d status=%q", tm.triage.count(), o.str("pipeline.status"))
	}
}

func TestFailingWebFlowIsRetriedThenTriaged(t *testing.T) {
	d := &devices{fleet: allDevices, fail: map[string]int{"web/mo-trang.spec.ts": -1}}
	tm := newTeam(webPlan)
	o := runPipeline(t, d, tm, 1, uiRequest)
	if o.err != nil {
		t.Fatal(o.err)
	}
	if n := len(d.runCalls()); n != 2 {
		t.Fatalf("one run plus one retry, got %d: %+v", n, d.runCalls())
	}
	res := o.results(t)
	if !res.Failed || !res.Platforms[2].Failed() || tm.triage.count() != 1 || tm.reporter.count() != 1 {
		t.Fatalf("results = %+v triage=%d reporter=%d", res, tm.triage.count(), tm.reporter.count())
	}
}

func TestPlanWithoutPlatformsSkipsWeb(t *testing.T) {
	d := &devices{fleet: allDevices}
	o := runPipeline(t, d, newTeam(cartPlan), 1, uiRequest)
	if o.err != nil {
		t.Fatal(o.err)
	}
	for _, r := range d.runCalls() {
		if r.Platform == "web" {
			t.Fatal("web must run only when the plan names it")
		}
	}
	if web := o.results(t).Platforms[2]; !web.Skipped {
		t.Fatalf("web = %+v", web)
	}
}

func TestRetryTurnsFlakyFlowIntoPass(t *testing.T) {
	d := &devices{fleet: bothDevices, fail: map[string]int{"android/02_cart.yaml": 1}}
	tm := newTeam(cartPlan)
	o := runPipeline(t, d, tm, 1, uiRequest)
	if o.err != nil {
		t.Fatal(o.err)
	}
	res := o.results(t)
	if res.Failed || !slices.Equal(res.Flaky, []string{"android: mexpress/02_cart.yaml"}) {
		t.Fatalf("results = %+v", res)
	}
	android := res.Platforms[1]
	var flaky, login agents.FlowOutcome
	for _, f := range android.Jobs[0].Outcome {
		switch f.Flow {
		case "02_cart.yaml":
			flaky = f
		case "01_login.yaml":
			login = f
		}
	}
	if !flaky.Passed || !flaky.Flaky || !login.Passed || login.Flaky || android.Jobs[0].RetryRunID == "" {
		t.Fatalf("android outcome = %+v", android.Jobs[0])
	}
	if tm.triage.count() != 0 || !strings.Contains(o.str("pipeline.flaky"), "02_cart.yaml") {
		t.Fatalf("triage=%d flaky=%q", tm.triage.count(), o.str("pipeline.flaky"))
	}
	if txt := strings.Join(o.texts("runner"), "\n"); !strings.Contains(txt, "đạt khi chạy lại (flaky)") {
		t.Fatalf("runner text = %q", txt)
	}
}

func TestNoRetryWhenDisabled(t *testing.T) {
	d := &devices{fleet: bothDevices, fail: map[string]int{"android/02_cart.yaml": 1}}
	tm := newTeam(cartPlan)
	o := runPipeline(t, d, tm, 0, uiRequest)
	if o.err != nil {
		t.Fatal(o.err)
	}
	if res := o.results(t); !res.Failed || len(d.runCalls()) != 2 || tm.triage.count() != 1 {
		t.Fatalf("results=%+v runs=%+v triage=%d", res, d.runCalls(), tm.triage.count())
	}
}

func TestBadRequestFailsWithClearError(t *testing.T) {
	d := &devices{fleet: bothDevices}
	tm := newTeam(cartPlan)
	o := runPipeline(t, d, tm, 1, "chạy pipeline giúp tôi")
	if o.err == nil || !strings.Contains(o.err.Error(), "khoảng commit") {
		t.Fatalf("err = %v", o.err)
	}
	if tm.planner.count() != 0 || len(d.diffs) != 0 || o.str("pipeline.status") != StatusRunning {
		t.Fatalf("planner=%d diffs=%d status=%q", tm.planner.count(), len(d.diffs), o.str("pipeline.status"))
	}
}

func TestParseRequest(t *testing.T) {
	cases := []struct {
		in, last string
		want     Request
		err      string
	}{
		{in: uiRequest, want: Request{Repo: repoMexpress, From: "abc1234", To: "def5678", Trigger: "ui"}},
		{in: "chạy pipeline cho commit abc..def", last: absPath("r/app"), want: Request{Repo: absPath("r/app"), From: "abc", To: "def", Trigger: "ui"}},
		{in: "pipeline " + repoApp + " v1.2...HEAD", want: Request{Repo: repoApp, From: "v1.2", To: "HEAD", MergeBase: true, Trigger: "ui"}},
		{in: "chạy pipeline cho commit abc..def", err: "đường dẫn repo"},
		{in: `{"repo":"rel/path","from":"a"}`, err: "đầy đủ"},
		{in: `{"repo":` + quoted(repoR) + `,"from":"--upload-pack=x"}`, err: "không hợp lệ"},
		{in: `{"repo":` + quoted(repoR) + `,"from":"a","trigger":"cron"}`, err: "nguồn chạy"},
		{in: `{"repo":` + quoted(repoR) + `,"from":"a","extra":1}`, err: "không đọc được"},
		{in: `{"repo":` + quoted(repoR) + `,"from":"a","trigger":"http"}`, want: Request{Repo: repoR, From: "a", Trigger: "http"}},
	}
	for _, c := range cases {
		got, err := ParseRequest(c.in, c.last)
		if c.err != "" {
			if err == nil || !strings.Contains(err.Error(), c.err) {
				t.Errorf("%q: err = %v, want %q", c.in, err, c.err)
			}
			continue
		}
		if err != nil || got != c.want {
			t.Errorf("%q: got %+v %v, want %+v", c.in, got, err, c.want)
		}
	}
}

// The registry tools Triage gets (test_report, device_screenshot) are pinned as read-only in tools/risk_test.go;
// here the model must be offered exactly those plus the memory lookups, and the Reporter only recall.
func TestTriageAndReporterToolAllowlists(t *testing.T) {
	d := &devices{fleet: bothDevices, fail: map[string]int{"android/02_cart.yaml": -1}}
	tm := newTeam(cartPlan)
	if o := runPipeline(t, d, tm, 0, uiRequest); o.err != nil {
		t.Fatal(o.err)
	}
	if got := tm.triage.offered(); !slices.Equal(got, []string{"device_screenshot", "known_issues", "recall", "remember", "test_report"}) {
		t.Fatalf("triage tools = %v", got)
	}
	// The Reporter only reads memory: it is never offered remember.
	if got := tm.reporter.offered(); !slices.Equal(got, []string{"feature_flow_map", "recall"}) {
		t.Fatalf("reporter tools = %v", got)
	}
	// This registry has only test_git_diff of the Planner's registry tools.
	if got := tm.planner.offered(); !slices.Equal(got, []string{"feature_flow_map", "recall", "test_git_diff"}) {
		t.Fatalf("planner tools = %v", got)
	}
}

func TestSaveMemoryFailureDoesNotFailTheRun(t *testing.T) {
	d := &devices{fleet: bothDevices}
	tm := newTeam(cartPlan)
	broken := filepath.Join(t.TempDir(), "testengine.db")
	if err := os.WriteFile(broken, []byte("không phải sqlite"), 0o600); err != nil {
		t.Fatal(err)
	}
	tm.memOpts = memory.Options{TestDB: broken}
	o := runPipeline(t, d, tm, 0, uiRequest)
	if o.err != nil || o.str(StateStatus) != StatusDone {
		t.Fatalf("a memory failure must not fail the run: err=%v status=%q", o.err, o.str(StateStatus))
	}
	if got := strings.Join(o.texts(PipelineName), "|"); !strings.Contains(got, "Pipeline xong. Lưu ý: chưa cập nhật được thống kê flow hay lỗi") {
		t.Fatalf("pipeline texts = %q", got)
	}
}
