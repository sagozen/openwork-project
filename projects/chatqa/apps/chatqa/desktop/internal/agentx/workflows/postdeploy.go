// Package workflows holds the fixed ADK graphs: the post-deploy pipeline.
//
// Every decision in a graph ("is a flow dangerous?", "did anything fail?") is code, never a model.
package workflows

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/google/jsonschema-go/jsonschema"
	"google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/agent/workflowagent"
	"google.golang.org/adk/v2/session"
	"google.golang.org/adk/v2/workflow"
	"google.golang.org/genai"

	"chatqa/internal/agentx/agents"
	"chatqa/internal/agentx/memory"
	"chatqa/internal/testengine"
	"chatqa/internal/tools"
)

// PipelineName is the pipeline agent's name, and the author of its status lines.
const PipelineName = "pipeline"

// Session-state keys of a pipeline run, besides the ones the agents read (agents.StatePlan, agents.StateResults,
// agents.TriageKey, agents.ReportKey).
const (
	StateStatus    = "pipeline.status"  // running | waiting_approval | done | failed
	StateTrigger   = "pipeline.trigger" // ui | http | cli
	StateRequest   = "pipeline.request" // the Request as JSON
	StateDangerous = "pipeline.dangerous"
	StateFlaky     = "pipeline.flaky"
	// StateLastRepo remembers the repo of the user's last run (user-scoped), so "chạy pipeline cho commit a..b" in
	// chat works without a path.
	StateLastRepo = session.KeyPrefixUser + "pipeline.last_repo"
)

// Pipeline statuses.
const (
	StatusRunning         = "running"
	StatusWaitingApproval = "waiting_approval"
	StatusDone            = "done"
	StatusFailed          = "failed"
)

// Platforms the pipeline runs on, in report order.
var Platforms = []string{"ios", "android", "web"}

// defaultPlatforms is what a plan without platforms runs on. Web (a browser profile) runs only when the plan names it.
var defaultPlatforms = []string{"ios", "android"}

// maxDiffChars bounds the diff the Planner reads. Above it the hunks are dropped and only files, functions and
// line counts remain.
const maxDiffChars = 60_000

// Deps is what the pipeline needs. The agents must be built for this pipeline only: an ADK agent has one parent.
type Deps struct {
	Caller   agents.Caller // the tool registry
	Planner  agent.Agent   // agents.NewPipelinePlanner
	Triage   agent.Agent   // agents.NewTriage
	Reporter agent.Agent   // agents.NewReporter
	// IsDataChanging marks flows that create or change data; a plan with one stops for approval.
	IsDataChanging func(app, flow string) bool
	// RetryFailed is how many times failed flows are run again (pipeline.retry_failed).
	RetryFailed int
	// RetryDelay is the pause before a re-run.
	RetryDelay time.Duration
	Runner     agents.RunnerOptions
	// Memory is the QA memory the save_memory step updates: it refreshes the flaky statistics from the flow results
	// the run recorded and stores the memories the Triage proposed once the tester approves them. nil = nothing saved.
	Memory *memory.Service
	// ConfirmMemory is the confirmation policy for a proposed memory (guard.Confirm, asked with tools.RiskWrite).
	// nil = always ask.
	ConfirmMemory func(name string, args map[string]any, risk tools.Risk) bool
}

// NewPostDeploy builds the post-deploy pipeline:
//
//	START → receive_diff → planner → gate ─ true  → approve (waits for a person) ─┐
//	                                      └ false ────────────────────────────────┴→ split ─┬→ run_ios     ─┬→ join → any_fail ─ true  → triage → reporter → save_memory
//	                                                                                        ├→ run_android ─┤                  └ false → reporter
//	                                                                                        └→ run_web     ─┘
func NewPostDeploy(d Deps) (agent.Agent, error) {
	if d.Caller == nil || d.Planner == nil || d.Triage == nil || d.Reporter == nil || d.IsDataChanging == nil {
		return nil, errors.New("pipeline needs a tool caller, the Planner, Triage and Reporter agents and a data-changing rule")
	}
	if d.RetryFailed < 0 {
		return nil, errors.New("pipeline retry count must not be negative")
	}
	p := &pipeline{d: d, runner: agents.NewFlowRunner(d.Caller, d.Runner), memo: map[string]memoEntry{}}

	receive := workflow.NewEmittingFunctionNode("receive_diff", p.receiveDiff, workflow.NodeConfig{})
	planner, err := workflow.NewAgentNode(d.Planner, workflow.NodeConfig{})
	if err != nil {
		return nil, err
	}
	gate := workflow.NewEmittingFunctionNode("gate", p.gate, workflow.NodeConfig{})
	// The approval node runs again when the answer arrives (also after an app restart: the run state is rebuilt from
	// the stored session events) and hands the approved plan to split.
	approve := workflow.NewEmittingFunctionNode(ApproveNode, p.approve, workflow.NodeConfig{RerunOnResume: new(true)})
	split := workflow.NewEmittingFunctionNode("split", p.split, workflow.NodeConfig{})
	runCfg := workflow.NodeConfig{RetryConfig: p.retryConfig()}
	runIOS := workflow.NewEmittingFunctionNode("run_ios", p.runPlatform("ios"), runCfg)
	runAndroid := workflow.NewEmittingFunctionNode("run_android", p.runPlatform("android"), runCfg)
	runWeb := workflow.NewEmittingFunctionNode("run_web", p.runPlatform("web"), runCfg)
	join := workflow.NewJoinNode("join")
	anyFail := workflow.NewEmittingFunctionNode("any_fail", p.anyFail, workflow.NodeConfig{})
	triage, err := workflow.NewAgentNode(d.Triage, workflow.NodeConfig{})
	if err != nil {
		return nil, err
	}
	reporter, err := workflow.NewAgentNode(d.Reporter, workflow.NodeConfig{})
	if err != nil {
		return nil, err
	}
	// save_memory runs again when the tester answers which proposed memories to keep (also after a restart).
	save := workflow.NewEmittingFunctionNode(SaveMemoryNode, p.saveMemory, workflow.NodeConfig{RerunOnResume: new(true)})

	eb := workflow.NewEdgeBuilder()
	eb.Add(workflow.Start, receive).Add(receive, planner).Add(planner, gate)
	eb.AddRoute(gate, approve, workflow.BoolRoute(true))
	eb.AddRoute(gate, split, workflow.BoolRoute(false))
	eb.Add(approve, split)
	eb.AddFanOut(split, runIOS, runAndroid, runWeb)
	eb.AddFanIn(join, runIOS, runAndroid, runWeb)
	eb.Add(join, anyFail)
	eb.AddRoute(anyFail, triage, workflow.BoolRoute(true))
	eb.AddRoute(anyFail, reporter, workflow.BoolRoute(false))
	eb.Add(triage, reporter)
	eb.Add(reporter, save)

	return workflowagent.New(workflowagent.Config{
		Name:        PipelineName,
		Description: "Quy trình sau deploy cho một khoảng commit: diff, chọn flow, chạy iOS, Android và web song song, phân loại lỗi, báo cáo.",
		Edges:       eb.Build(),
		// Registered so the runner can name their events. The Planner is not: the chat team already has an agent
		// named planner and names must be unique in one agent tree.
		SubAgents: []agent.Agent{d.Triage, d.Reporter},
	})
}

type pipeline struct {
	d      Deps
	runner *agents.FlowRunner

	mu   sync.Mutex
	memo map[string]memoEntry // results of a run node between its attempts, by invocation and platform
}

type memoEntry struct {
	results  []agents.JobResult
	attempts int
	at       time.Time
}

// emit helpers: one event per call. Status lines are final text events authored by the pipeline; progress lines
// are partial events authored by the Runner so the chat shows them as a replaceable status line.
type emitFn = func(*session.Event) error

func newEvent(ctx agent.Context, author string) *session.Event {
	ev := session.NewEvent(ctx, ctx.InvocationID())
	ev.Author = author
	return ev
}

func say(ctx agent.Context, emit emitFn, author, text string, delta map[string]any) error {
	ev := newEvent(ctx, author)
	ev.Content = genai.NewContentFromText(text, genai.RoleModel)
	for k, v := range delta {
		ev.Actions.StateDelta[k] = v
	}
	return emit(ev)
}

func progress(ctx agent.Context, emit emitFn, text string) {
	ev := newEvent(ctx, agents.RunnerName)
	ev.Content = genai.NewContentFromText(text, genai.RoleModel)
	ev.Partial = true
	_ = emit(ev) // a progress line lost to a stopped run is harmless
}

// output emits the node's one output, with its routes and state changes, and no text.
func output(ctx agent.Context, emit emitFn, out any, routes []string, delta map[string]any) error {
	ev := newEvent(ctx, PipelineName)
	ev.Output = out
	ev.Routes = routes
	for k, v := range delta {
		ev.Actions.StateDelta[k] = v
	}
	return emit(ev)
}

func jsonText(v any) string {
	raw, err := json.Marshal(v)
	if err != nil {
		return ""
	}
	return string(raw)
}

// decode reads a node input that is either the Go value a predecessor produced or, after a resume from stored
// events, its JSON form.
func decode[T any](in any) (T, error) {
	var out T
	switch v := in.(type) {
	case T:
		return v, nil
	case *T:
		if v != nil {
			return *v, nil
		}
		return out, nil
	case nil:
		return out, nil
	case string:
		err := json.Unmarshal([]byte(v), &out)
		return out, err
	}
	raw, err := json.Marshal(in)
	if err != nil {
		return out, err
	}
	err = json.Unmarshal(raw, &out)
	return out, err
}

func (p *pipeline) call(ctx context.Context, tool string, args map[string]any) (any, error) {
	raw, err := json.Marshal(args)
	if err != nil {
		return nil, err
	}
	res, err := p.d.Caller.Call(tools.WithSource(ctx, testengine.ToolSourceAgent), tool, raw)
	if err != nil {
		return nil, err
	}
	return res.Data, nil
}

// receiveDiff reads the request, resets the run's state and fetches the diff through test_git_diff. Its output is
// the text the Planner reads.
func (p *pipeline) receiveDiff(ctx agent.Context, in string, emit emitFn) (any, error) {
	lastRepo := ""
	if v, err := ctx.ReadonlyState().Get(StateLastRepo); err == nil {
		lastRepo, _ = v.(string)
	}
	req, perr := ParseRequest(in, lastRepo)
	trigger := req.Trigger
	if trigger == "" || !slices.Contains(triggers, trigger) {
		trigger = TriggerUI
	}
	// A session may hold an earlier run: clear its results so the Reporter never mixes two runs.
	reset := map[string]any{
		StateStatus: StatusRunning, StateTrigger: trigger, StateRequest: jsonText(req),
		agents.StatePlan: "", agents.PipelinePlanKey: "", agents.StateResults: "", agents.TriageKey: "", agents.ReportKey: "",
		StateDangerous: "", StateFlaky: "",
	}
	for k, v := range ctx.ReadonlyState().All() {
		if strings.HasPrefix(k, memory.ProposalPrefix) && v != "" {
			reset[k] = "" // proposals of an earlier run that ended before its save_memory step
		}
	}
	if err := say(ctx, emit, PipelineName, "Bắt đầu pipeline sau deploy.", reset); err != nil {
		return nil, err
	}
	if perr != nil {
		return nil, perr
	}
	data, err := p.call(ctx, "test_git_diff", map[string]any{"repo": req.Repo, "commit_a": req.From, "commit_b": req.To, "merge_base": req.MergeBase})
	if err != nil {
		return nil, fmt.Errorf("không lấy được diff: %w", err)
	}
	text, summary := diffForPlanner(req, data)
	if err := say(ctx, emit, PipelineName, summary, map[string]any{StateLastRepo: req.Repo}); err != nil {
		return nil, err
	}
	return nil, output(ctx, emit, text, nil, nil)
}

// diffForPlanner turns the test_git_diff result into the Planner's input, without the analysis guide meant for
// chat clients, and bounded to maxDiffChars.
func diffForPlanner(req Request, data any) (string, string) {
	var d map[string]any
	if raw, err := json.Marshal(data); err == nil {
		_ = json.Unmarshal(raw, &d)
	}
	delete(d, "analysis")
	delete(d, "diffPath")
	to := req.To
	if to == "" {
		to = "HEAD"
	}
	summary := fmt.Sprintf("Đã lấy diff %s..%s", req.From, to)
	if st, ok := d["stats"].(map[string]any); ok {
		summary += fmt.Sprintf(": %v file (+%v −%v).", st["files"], st["add"], st["del"])
	} else {
		summary += "."
	}
	body := jsonText(d)
	if len(body) > maxDiffChars {
		if files, ok := d["files"].([]any); ok {
			for _, f := range files {
				if m, ok := f.(map[string]any); ok {
					delete(m, "hunks")
				}
			}
		}
		body = jsonText(d)
		if len(body) > maxDiffChars {
			body = body[:maxDiffChars] + "…(đã cắt bớt)"
		}
	}
	return fmt.Sprintf("Diff của repo %s giữa %s (cũ) và %s (mới):\n%s", req.Repo, req.From, to, body), summary
}

// gate parses the plan and routes true when any planned flow creates or changes data. A reply that is not a plan
// becomes a plan with an error, so the run still ends with a report that says why nothing ran.
func (p *pipeline) gate(ctx agent.Context, in any, emit emitFn) (any, error) {
	text, _ := in.(string)
	plan, err := agents.ParsePlan(text)
	if err != nil {
		plan = agents.Plan{Error: err.Error()}
	}
	var dangerous []agents.PlanFlow
	for _, f := range plan.Flows {
		if p.d.IsDataChanging(f.App, f.Flow) {
			dangerous = append(dangerous, f)
		}
	}
	delta := map[string]any{agents.StatePlan: jsonText(plan), StateDangerous: jsonText(dangerous)}
	return nil, output(ctx, emit, plan, []string{fmt.Sprint(len(dangerous) > 0)}, delta)
}

// Split is the plan cut into one request per platform.
type Split struct {
	Platforms map[string]PlatformRequest `json:"platforms"`
}

// PlatformRequest is what one run node does: Jobs on one device, or nothing when Skip says why.
type PlatformRequest struct {
	Platform string       `json:"platform"`
	Jobs     []agents.Job `json:"jobs,omitempty"`
	Skip     string       `json:"skip,omitempty"`
}

// split picks one free device per platform. A platform that is not planned, has no free device or has no flows
// is skipped with a reason; it never fails the run.
func (p *pipeline) split(ctx agent.Context, in any, emit emitFn) (any, error) {
	approved, err := decode[ApprovedPlan](in) // the gate's Plan, or the approval step's ApprovedPlan
	if err != nil {
		return nil, err
	}
	plan := approved.Plan
	out := Split{Platforms: map[string]PlatformRequest{}}
	skipAll := func(reason string) (any, error) {
		for _, pl := range Platforms {
			out.Platforms[pl] = PlatformRequest{Platform: pl, Skip: reason}
		}
		return nil, output(ctx, emit, out, nil, nil)
	}
	if approved.Skip != "" {
		return skipAll(approved.Skip)
	}
	if plan.Error != "" {
		return skipAll("Planner không chọn được flow: " + plan.Error)
	}
	if len(plan.Flows) == 0 {
		return skipAll("Planner không chọn flow nào")
	}
	wanted := defaultPlatforms
	if len(plan.Platforms) > 0 {
		wanted = nil
		for _, pl := range Platforms {
			if slices.Contains(plan.Platforms, pl) {
				wanted = append(wanted, pl)
			}
		}
	}
	free, err := p.runner.FreeDevices(ctx)
	if err != nil {
		return nil, fmt.Errorf("không đọc được danh sách thiết bị: %w", err)
	}
	for _, pl := range Platforms {
		switch {
		case !slices.Contains(wanted, pl):
			out.Platforms[pl] = PlatformRequest{Platform: pl, Skip: "kế hoạch không chạy trên " + pl}
		case len(free[pl]) == 0:
			out.Platforms[pl] = PlatformRequest{Platform: pl, Skip: "không có máy " + pl + " rảnh"}
		default:
			out.Platforms[pl] = PlatformRequest{Platform: pl, Jobs: agents.JobsFor(plan, pl, free[pl][0])}
		}
	}
	return nil, output(ctx, emit, out, nil, nil)
}

// PlatformResult is one platform's outcome. Skipped platforms carry the reason and count as neither pass nor fail.
type PlatformResult struct {
	Platform string             `json:"platform"`
	Skipped  bool               `json:"skipped,omitempty"`
	Reason   string             `json:"reason,omitempty"`
	Jobs     []agents.JobResult `json:"jobs,omitempty"`
}

// Failed reports whether a job did not run or a flow failed.
func (r PlatformResult) Failed() bool { return len(failedFlows(r.Jobs)) > 0 }

// failedFlows lists, per job index, the flows to run again: the failed ones, or all of them when the job produced
// no flow results.
func failedFlows(jobs []agents.JobResult) map[int][]string {
	out := map[int][]string{}
	for i, j := range jobs {
		if j.Error != "" && len(j.Outcome) == 0 {
			out[i] = slices.Clone(j.Flows)
			continue
		}
		for _, o := range j.Outcome {
			if !o.Passed {
				out[i] = append(out[i], o.Flow)
			}
		}
	}
	return out
}

// errRetryFailed asks the scheduler to run the node again; the node then runs only the flows that failed.
type errRetryFailed struct {
	platform string
	flows    []string
}

func (e *errRetryFailed) Error() string {
	return fmt.Sprintf("còn %d flow lỗi trên %s, sẽ chạy lại: %s", len(e.flows), e.platform, strings.Join(e.flows, ", "))
}

func isRetryFailed(err error) bool {
	var r *errRetryFailed
	return errors.As(err, &r)
}

func (p *pipeline) retryConfig() *workflow.RetryConfig {
	if p.d.RetryFailed == 0 {
		return nil
	}
	return &workflow.RetryConfig{
		MaxAttempts:   p.d.RetryFailed + 1,
		InitialDelay:  p.d.RetryDelay,
		MaxDelay:      p.d.RetryDelay,
		BackoffFactor: 1,
		ShouldRetry:   isRetryFailed, // other errors are real failures, not flaky flows
	}
}

// memoTTL drops results of runs that were stopped between two attempts.
const memoTTL = 24 * time.Hour

func (p *pipeline) takeMemo(key string) (memoEntry, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	e, ok := p.memo[key]
	delete(p.memo, key)
	return e, ok
}

func (p *pipeline) putMemo(key string, e memoEntry) {
	p.mu.Lock()
	defer p.mu.Unlock()
	for k, old := range p.memo {
		if time.Since(old.at) > memoTTL {
			delete(p.memo, k)
		}
	}
	e.at = time.Now()
	p.memo[key] = e
}

// runPlatform builds the run node of one platform. The first attempt runs every planned flow. When flows fail and
// re-runs are left, it keeps the results and returns errRetryFailed; the scheduler's RetryConfig then runs the node
// again, which runs only the failed flows and merges: a flow that passes on a re-run is marked flaky.
func (p *pipeline) runPlatform(platform string) func(agent.Context, any, emitFn) (any, error) {
	return func(ctx agent.Context, in any, emit emitFn) (any, error) {
		split, err := decode[Split](in)
		if err != nil {
			return nil, err
		}
		req := split.Platforms[platform]
		if req.Skip != "" || len(req.Jobs) == 0 {
			reason := req.Skip
			if reason == "" {
				reason = "không có flow nào cho " + platform
			}
			if err := say(ctx, emit, agents.RunnerName, fmt.Sprintf("%s: bỏ qua (%s).", platform, reason), nil); err != nil {
				return nil, err
			}
			return nil, output(ctx, emit, PlatformResult{Platform: platform, Skipped: true, Reason: reason}, nil, nil)
		}

		key := ctx.InvocationID() + "/" + platform
		prev, retrying := p.takeMemo(key)
		var results []agents.JobResult
		if !retrying {
			for _, j := range req.Jobs {
				results = append(results, p.runner.RunJob(ctx, j, func(s string) { progress(ctx, emit, s) }))
			}
		} else {
			results = p.rerunFailed(ctx, emit, prev.results)
		}
		attempts := prev.attempts + 1
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if failed := failedFlows(results); len(failed) > 0 && attempts <= p.d.RetryFailed {
			var names []string
			for _, fl := range failed {
				names = append(names, fl...)
			}
			p.putMemo(key, memoEntry{results: results, attempts: attempts})
			progress(ctx, emit, fmt.Sprintf("Chạy lại %d flow lỗi trên %s: %s", len(names), platform, strings.Join(names, ", ")))
			return nil, &errRetryFailed{platform: platform, flows: names}
		}
		if err := say(ctx, emit, agents.RunnerName, agents.Summarize(results, nil), nil); err != nil {
			return nil, err
		}
		return nil, output(ctx, emit, PlatformResult{Platform: platform, Jobs: results}, nil, nil)
	}
}

// rerunFailed runs the failed flows of each job again on the same device and merges the outcome into a copy.
func (p *pipeline) rerunFailed(ctx agent.Context, emit emitFn, prev []agents.JobResult) []agents.JobResult {
	out := make([]agents.JobResult, len(prev))
	for i, r := range prev {
		r.Outcome = slices.Clone(r.Outcome)
		out[i] = r
	}
	for i, flows := range failedFlows(prev) {
		j := out[i].Job
		j.Flows = flows
		again := p.runner.RunJob(ctx, j, func(s string) { progress(ctx, emit, s) })
		if len(again.Outcome) == 0 {
			continue // the re-run produced nothing: the first failure stands
		}
		out[i].RetryRunID = again.RunID
		if out[i].Error != "" && len(out[i].Outcome) == 0 {
			out[i].Error = ""
			for _, o := range again.Outcome {
				o.Flaky = o.Passed
				out[i].Outcome = append(out[i].Outcome, o)
			}
			continue
		}
		for _, o := range again.Outcome {
			for k := range out[i].Outcome {
				cur := &out[i].Outcome[k]
				if cur.Flow != o.Flow || cur.Passed {
					continue
				}
				if o.Passed {
					*cur = agents.FlowOutcome{Flow: o.Flow, Passed: true, Flaky: true}
				} else {
					cur.FailureClass, cur.Error = o.FailureClass, o.Error
				}
			}
		}
	}
	return out
}

// Results is the whole run: every platform, whether anything failed, and the flows that were flaky.
type Results struct {
	Platforms []PlatformResult `json:"platforms"`
	Failed    bool             `json:"failed"`
	Flaky     []string         `json:"flaky,omitempty"` // "<platform>: <app>/<flow>"
}

// anyFail collects the platform results and routes true when anything failed. Skipped platforms do not count.
func (p *pipeline) anyFail(ctx agent.Context, in any, emit emitFn) (any, error) {
	joined, err := decode[map[string]any](in)
	if err != nil {
		return nil, err
	}
	var res Results
	for _, pl := range Platforms {
		r, err := decode[PlatformResult](joined["run_"+pl])
		if err != nil {
			return nil, fmt.Errorf("kết quả %s không đọc được: %w", pl, err)
		}
		if r.Platform == "" {
			r = PlatformResult{Platform: pl, Skipped: true, Reason: "không có kết quả"}
		}
		res.Platforms = append(res.Platforms, r)
		res.Failed = res.Failed || r.Failed()
		for _, j := range r.Jobs {
			for _, o := range j.Outcome {
				if o.Flaky {
					res.Flaky = append(res.Flaky, fmt.Sprintf("%s: %s/%s", pl, j.App, o.Flow))
				}
			}
		}
	}
	delta := map[string]any{agents.StateResults: jsonText(res), StateFlaky: jsonText(res.Flaky)}
	return nil, output(ctx, emit, res, []string{fmt.Sprint(res.Failed)}, delta)
}

// SaveMemoryNode is the name of the pipeline's last step.
const SaveMemoryNode = "save_memory"

// MemoryInterruptID is the id of the request that asks which proposed memories to keep, unique per run.
func MemoryInterruptID(invocationID string) string { return SaveMemoryNode + "-" + invocationID }

// MemoryPayload is RequestInput.Payload of the save_memory step: the memories the Triage proposed.
type MemoryPayload struct {
	Memories []memory.Proposal `json:"memories"`
}

// MemoryReply is the answer: the keys of the proposals to store and an optional note.
type MemoryReply struct {
	ApprovedMemories []string `json:"approved_memories"`
	Note             string   `json:"note,omitempty"`
}

var memorySchema = &jsonschema.Schema{
	Type: "object",
	Properties: map[string]*jsonschema.Schema{
		"approved_memories": {Type: "array", Items: &jsonschema.Schema{Type: "string"}},
		"note":              {Type: "string"},
	},
	Required: []string{"approved_memories"},
}

// needsApproval applies the confirmation policy to a proposed memory: a write, so with the default policy it asks.
func (p *pipeline) needsApproval(n memory.Note) bool {
	if p.d.ConfirmMemory == nil {
		return true
	}
	args, err := decode[map[string]any](n)
	if err != nil {
		return true
	}
	return p.d.ConfirmMemory(memory.RememberName, args, memory.Risks[memory.RememberName])
}

// saveMemory ends the run. It refreshes the flaky statistics, then handles the memories the Triage proposed: those
// the policy lets through are stored, the others wait for the tester (status waiting_approval; the report is already
// written) and only the approved ones are stored. A memory failure is reported but does not fail the run.
func (p *pipeline) saveMemory(ctx agent.Context, _ any, emit emitFn) (any, error) {
	if p.d.Memory == nil {
		return nil, say(ctx, emit, PipelineName, "Pipeline xong.", map[string]any{StateStatus: StatusDone})
	}
	var problems []string
	if err := p.d.Memory.RefreshFlaky(ctx, memory.FlakyWindow); err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		problems = append(problems, fmt.Sprintf("chưa cập nhật được thống kê flow hay lỗi: %v", err))
	}
	proposals := p.d.Memory.Proposals(ctx.ReadonlyState())
	approved := map[string]bool{}
	var ask []memory.Proposal
	for _, pr := range proposals {
		if p.needsApproval(pr.Note) {
			ask = append(ask, pr)
		} else {
			approved[pr.Key] = true
		}
	}
	note := ""
	if len(ask) > 0 {
		id := MemoryInterruptID(ctx.InvocationID())
		raw, answered := ctx.ResumedInput(id)
		if !answered {
			text := fmt.Sprintf("Báo cáo đã xong. Triage đề xuất lưu %d mục vào trí nhớ QA; chọn mục được lưu.", len(ask))
			if err := say(ctx, emit, PipelineName, text, map[string]any{StateStatus: StatusWaitingApproval}); err != nil {
				return nil, err
			}
			req := session.RequestInput{InterruptID: id, Message: text, Payload: MemoryPayload{Memories: ask}, ResponseSchema: memorySchema}
			if err := emit(workflow.NewRequestInputEvent(ctx, req)); err != nil {
				return nil, err
			}
			return nil, workflow.ErrNodeInterrupted
		}
		reply, err := decode[MemoryReply](raw)
		if err != nil {
			return nil, fmt.Errorf("câu trả lời lưu trí nhớ không đọc được: %w", err)
		}
		for _, pr := range ask {
			if slices.Contains(reply.ApprovedMemories, pr.Key) {
				approved[pr.Key] = true
			}
		}
		note = strings.TrimSpace(reply.Note)
	}

	delta := map[string]any{StateStatus: StatusDone}
	saved, skipped := 0, 0
	for _, pr := range proposals {
		delta[memory.ProposalPrefix+pr.Key] = ""
		if !approved[pr.Key] {
			skipped++
			continue
		}
		if _, err := p.d.Memory.Remember(ctx, pr.Note); err != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			problems = append(problems, fmt.Sprintf("không lưu được một mục: %v", err))
			continue
		}
		saved++
	}
	text := "Pipeline xong."
	if len(proposals) > 0 {
		text += fmt.Sprintf(" Đã lưu %d mục vào trí nhớ QA, bỏ %d.", saved, skipped)
	}
	if note != "" {
		text += " Ghi chú: " + note
	}
	if len(problems) > 0 {
		text += " Lưu ý: " + strings.Join(problems, "; ")
	}
	return nil, say(ctx, emit, PipelineName, text, delta)
}
