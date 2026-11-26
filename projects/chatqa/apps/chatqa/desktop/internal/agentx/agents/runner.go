package agents

import (
	"context"
	"encoding/json"
	"fmt"
	"iter"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	"google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/agent/workflowagents/sequentialagent"
	"google.golang.org/adk/v2/session"
	"google.golang.org/genai"

	"chatqa/internal/testengine"
	"chatqa/internal/tools"
)

// Caller runs a registry tool. *tools.Registry is the real one; the call goes through permission, budget, journal
// and redaction like every other caller.
type Caller interface {
	Call(ctx context.Context, name string, args json.RawMessage) (*tools.Result, error)
}

// RunnerName is the Runner agent's name; its partial events are progress lines.
const RunnerName = "runner"

// Plan is what the Planner returns and the Runner reads.
type Plan struct {
	Flows     []PlanFlow `json:"flows"`
	Platforms []string   `json:"platforms"`
	Error     string     `json:"error,omitempty"`
}

type PlanFlow struct {
	App    string `json:"app"`
	Flow   string `json:"flow"`
	Reason string `json:"reason,omitempty"`
}

// ParsePlan reads the Planner's reply. It accepts a JSON object with or without a code fence.
func ParsePlan(text string) (Plan, error) {
	s := strings.TrimSpace(text)
	if i := strings.Index(s, "{"); i >= 0 {
		if j := strings.LastIndex(s, "}"); j > i {
			s = s[i : j+1]
		}
	}
	var p Plan
	if err := json.Unmarshal([]byte(s), &p); err != nil {
		return Plan{}, fmt.Errorf("kế hoạch của Planner không phải JSON hợp lệ: %w", err)
	}
	return p, nil
}

// RunnerOptions tunes the Runner.
type RunnerOptions struct {
	// WaitSec is how long one test_run call waits before the run is followed with tower_wait_task. 0 = 60.
	WaitSec int
	// MaxRun bounds one run in total. 0 = 30 minutes.
	MaxRun time.Duration
	// Confirm decides, per test_run the Runner is about to make, whether a person must approve first, and why. When any
	// job needs it the Runner asks once for the whole run (an adk_request_confirmation call) and stops; the answer
	// resumes it. nil = never ask. The pipeline has its own approval step and leaves this nil.
	Confirm func(req testengine.RunRequest) (need bool, reasons []string)
}

// NewPlanAndRun is Planner then Runner as one sub-agent for the Coordinator to transfer to.
func NewPlanAndRun(planner agent.Agent, runner agent.Agent) (agent.Agent, error) {
	return sequentialagent.New(sequentialagent.Config{AgentConfig: agent.Config{
		Name:        "plan_and_run",
		Description: "Chọn flow rồi chạy trên thiết bị Android/iOS, trả kết quả đạt/lỗi từng flow.",
		SubAgents:   []agent.Agent{planner, runner},
	}})
}

// NewRunner runs the plan on devices. It uses no model: it reads the plan, resolves devices through tower_fleet,
// calls test_run once per platform (in parallel), follows long runs with tower_wait_task and reads test_report.
// It never guesses: a plan with an error or no flows, or a platform with no free device, is reported as is.
func NewRunner(c Caller, opts RunnerOptions) (agent.Agent, error) {
	r := &runner{NewFlowRunner(c, opts)}
	return agent.New(agent.Config{
		Name:        RunnerName,
		Description: "Chạy kế hoạch trên thiết bị, theo dõi tiến độ và trả kết quả.",
		Run:         r.run,
	})
}

type runner struct{ *FlowRunner }

// FlowRunner is the device side of the Runner: it finds free devices and runs flows through test_run, following
// long runs with tower_wait_task and test_report. The Runner agent and the post-deploy pipeline share it.
type FlowRunner struct {
	c    Caller
	opts RunnerOptions
}

// NewFlowRunner applies the RunnerOptions defaults.
func NewFlowRunner(c Caller, opts RunnerOptions) *FlowRunner {
	if opts.WaitSec <= 0 {
		opts.WaitSec = 60
	}
	if opts.MaxRun <= 0 {
		opts.MaxRun = 30 * time.Minute
	}
	return &FlowRunner{c: c, opts: opts}
}

func event(ctx agent.InvocationContext, text string, partial bool) *session.Event {
	ev := session.NewEvent(ctx, ctx.InvocationID())
	ev.Author = ctx.Agent().Name()
	ev.Branch = ctx.Branch()
	ev.Content = genai.NewContentFromText(text, genai.RoleModel)
	ev.Partial = partial // progress lines are forwarded to the UI but not kept in the model's history
	return ev
}

func (r *runner) run(ctx agent.InvocationContext) iter.Seq2[*session.Event, error] {
	return func(yield func(*session.Event, error) bool) {
		say := func(text string, partial bool) bool { return yield(event(ctx, text, partial), nil) }

		// A turn that answers the Runner's approval request runs (or drops) exactly the jobs that were approved.
		if answer, ok := confirmationAnswer(ctx.UserContent()); ok {
			req, err := findRunRequest(ctx, answer.callID)
			switch {
			case err != nil:
				say("Không chạy: "+err.Error(), false)
			case !answer.confirmed:
				say("Đã từ chối, không chạy flow nào.", false)
			default:
				r.runJobs(ctx, yield, req.Jobs, req.Problems)
			}
			return
		}

		plan, err := readPlan(ctx)
		if err != nil {
			say("Không đọc được kế hoạch: "+err.Error(), false)
			return
		}
		if plan.Error != "" || len(plan.Flows) == 0 {
			reason := plan.Error
			if reason == "" {
				reason = "Planner không chọn được flow nào"
			}
			say("Chưa chạy gì: "+reason, false)
			return
		}
		jobs, problems, err := r.assign(ctx, plan)
		if err != nil {
			say("Không đọc được danh sách thiết bị: "+err.Error(), false)
			return
		}
		for _, p := range problems {
			if !say(p, true) {
				return
			}
		}
		if len(jobs) == 0 {
			say("Chưa chạy gì: "+strings.Join(problems, "; "), false)
			return
		}
		if reasons := r.confirmReasons(jobs); len(reasons) > 0 {
			ev, err := confirmationRequest(ctx, runRequest{Jobs: jobs, Problems: problems}, reasons)
			if err != nil {
				say("Không tạo được yêu cầu duyệt: "+err.Error(), false)
				return
			}
			yield(ev, nil)
			return
		}
		r.runJobs(ctx, yield, jobs, problems)
	}
}

// runJobs runs the jobs in parallel, streams their progress and ends with the summary.
func (r *runner) runJobs(ctx agent.InvocationContext, yield func(*session.Event, error) bool, jobs []Job, problems []string) {
	say := func(text string, partial bool) bool { return yield(event(ctx, text, partial), nil) }
	progress := make(chan string, 16)
	results := make([]JobResult, len(jobs))
	var wg sync.WaitGroup
	for i := range jobs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results[i] = r.RunJob(ctx, jobs[i], func(s string) {
				select {
				case progress <- s:
				case <-ctx.Done():
				}
			})
		}()
	}
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	for waiting := true; waiting; {
		select {
		case s := <-progress:
			if !say(s, true) {
				return
			}
		case <-done:
			waiting = false
		case <-ctx.Done():
			return
		}
	}
	for len(progress) > 0 {
		if !say(<-progress, true) {
			return
		}
	}

	final := event(ctx, Summarize(results, problems), false)
	if raw, err := json.Marshal(results); err == nil {
		final.Actions.StateDelta["last_run"] = string(raw)
	}
	yield(final, nil)
}

func readPlan(ctx agent.InvocationContext) (Plan, error) {
	v, err := ctx.Session().State().Get(PlanKey)
	if err != nil {
		return Plan{}, fmt.Errorf("Planner chưa trả kế hoạch")
	}
	text, _ := v.(string)
	return ParsePlan(text)
}

// Job is one test_run call: the flows of one app on one device.
type Job struct {
	App      string   `json:"app"`
	Platform string   `json:"platform"`
	Device   string   `json:"device"`
	Flows    []string `json:"flows"`
}

// FlowOutcome is the result of one flow. Flaky means it failed, then passed when it was run again.
type FlowOutcome struct {
	Flow         string `json:"flow"`
	Passed       bool   `json:"passed"`
	Flaky        bool   `json:"flaky,omitempty"`
	FailureClass string `json:"failureClass,omitempty"`
	Error        string `json:"error,omitempty"`
}

// JobResult is a Job with its run and per-flow outcome. Error means the run did not produce flow results.
type JobResult struct {
	Job
	RunID      string        `json:"runId,omitempty"`
	RetryRunID string        `json:"retryRunId,omitempty"` // the re-run of the failed flows, when there was one
	Outcome    []FlowOutcome `json:"outcome,omitempty"`
	Error      string        `json:"error,omitempty"`
}

type fleetDevice struct {
	ID       string `json:"id"`
	Platform string `json:"platform"`
	State    string `json:"state"`
}

// assign picks one free device per platform and groups the flows by app. Platforms with no free device become
// problems, never a silent substitute.
func (r *runner) assign(ctx context.Context, plan Plan) ([]Job, []string, error) {
	free, err := r.FreeDevices(ctx)
	if err != nil {
		return nil, nil, err
	}
	platforms := slices.Clone(plan.Platforms)
	if len(platforms) == 0 {
		for p := range free {
			if p == "android" || p == "ios" {
				platforms = append(platforms, p)
			}
		}
	}
	sort.Strings(platforms)

	var jobs []Job
	var problems []string
	for _, p := range platforms {
		ids := free[p]
		if len(ids) == 0 {
			problems = append(problems, fmt.Sprintf("Không có máy %s rảnh", p))
			continue
		}
		jobs = append(jobs, JobsFor(plan, p, ids[0])...)
	}
	if len(platforms) == 0 {
		problems = append(problems, "Không có máy Android/iOS nào rảnh")
	}
	return jobs, problems, nil
}

// FreeDevices lists the usable devices by platform (android, ios, web), from tower_fleet.
func (r *FlowRunner) FreeDevices(ctx context.Context) (map[string][]string, error) {
	var fleet []fleetDevice
	if err := r.callInto(ctx, "tower_fleet", map[string]any{}, &fleet); err != nil {
		return nil, err
	}
	free := map[string][]string{}
	for _, d := range fleet {
		if d.State == "connected" || d.State == "ready" {
			free[d.Platform] = append(free[d.Platform], d.ID)
		}
	}
	return free, nil
}

// JobsFor groups the plan's flows by app into one Job per app on the given device, apps sorted.
func JobsFor(plan Plan, platform, device string) []Job {
	byApp := map[string][]string{}
	for _, f := range plan.Flows {
		if f.App != "" && f.Flow != "" && !slices.Contains(byApp[f.App], f.Flow) {
			byApp[f.App] = append(byApp[f.App], f.Flow)
		}
	}
	apps := make([]string, 0, len(byApp))
	for a := range byApp {
		apps = append(apps, a)
	}
	sort.Strings(apps)
	jobs := make([]Job, 0, len(apps))
	for _, app := range apps {
		jobs = append(jobs, Job{App: app, Platform: platform, Device: device, Flows: byApp[app]})
	}
	return jobs
}

// RunJob runs one Job and waits for its flow results. Failures are in the result, never returned as an error.
func (r *FlowRunner) RunJob(ctx context.Context, j Job, progress func(string)) JobResult {
	res := JobResult{Job: j}
	name := fmt.Sprintf("%s trên %s (%s)", strings.Join(j.Flows, ", "), j.Platform, j.Device)
	progress("Đang chạy " + name)
	var out map[string]json.RawMessage
	err := r.callInto(ctx, "test_run", map[string]any{"app": j.App, "flows": j.Flows, "devices": []string{j.Device}, "wait_sec": r.opts.WaitSec}, &out)
	if err != nil {
		res.Error = err.Error()
		return res
	}
	deadline := time.Now().Add(r.opts.MaxRun)
	for isRunning(out) {
		var taskID string
		_ = json.Unmarshal(out["taskId"], &taskID)
		if taskID == "" {
			var task struct {
				ID string `json:"id"`
			}
			raw, _ := json.Marshal(out)
			_ = json.Unmarshal(raw, &task)
			taskID = task.ID
		}
		if taskID == "" || time.Now().After(deadline) || ctx.Err() != nil {
			res.Error = "lượt chạy chưa xong trong thời hạn cho phép"
			return res
		}
		progress("Vẫn đang chạy " + name)
		var task struct {
			Status string `json:"status"`
			RunID  string `json:"runId"`
			Error  string `json:"error"`
		}
		if err := r.callInto(ctx, "tower_wait_task", map[string]any{"id": taskID, "timeout_sec": 30}, &task); err != nil {
			res.Error = err.Error()
			return res
		}
		if task.Status == "running" {
			continue
		}
		if task.RunID == "" {
			res.Error = firstNonEmpty(task.Error, "task kết thúc nhưng không có lượt chạy ("+task.Status+")")
			return res
		}
		out = nil
		if err := r.callInto(ctx, "test_report", map[string]any{"id": task.RunID}, &out); err != nil {
			res.Error = err.Error()
			return res
		}
	}
	var summary struct {
		Run struct {
			ID string `json:"id"`
		} `json:"run"`
		Flows []testengine.FlowRun `json:"flows"`
		Error string               `json:"error"`
	}
	raw, _ := json.Marshal(out)
	_ = json.Unmarshal(raw, &summary)
	if len(summary.Flows) == 0 {
		res.Error = firstNonEmpty(summary.Error, "lượt chạy không trả kết quả flow nào")
		return res
	}
	res.RunID = summary.Run.ID
	for _, f := range summary.Flows {
		res.Outcome = append(res.Outcome, FlowOutcome{Flow: f.Flow, Passed: f.Passed, FailureClass: f.FailureClass, Error: f.Error})
	}
	return res
}

func isRunning(out map[string]json.RawMessage) bool {
	var s string
	_ = json.Unmarshal(out["status"], &s)
	return s == "running"
}

func firstNonEmpty(ss ...string) string {
	for _, s := range ss {
		if s != "" {
			return s
		}
	}
	return ""
}

func (r *FlowRunner) callInto(ctx context.Context, tool string, args map[string]any, out any) error {
	raw, _ := json.Marshal(args)
	res, err := r.c.Call(tools.WithSource(ctx, testengine.ToolSourceAgent), tool, raw)
	if err != nil {
		return err
	}
	body, err := json.Marshal(res.Data)
	if err != nil {
		return err
	}
	return json.Unmarshal(body, out)
}

// Summarize is the result text the tester reads: one line per flow, problems, then the totals.
func Summarize(results []JobResult, problems []string) string {
	var b strings.Builder
	passed, failed := 0, 0
	for _, r := range results {
		fmt.Fprintf(&b, "%s trên %s (%s):\n", r.App, r.Platform, r.Device)
		if r.Error != "" {
			fmt.Fprintf(&b, "  ⚠ không chạy được: %s\n", r.Error)
			failed++
			continue
		}
		for _, o := range r.Outcome {
			if o.Passed {
				passed++
				if o.Flaky {
					fmt.Fprintf(&b, "  ✓ %s đạt khi chạy lại (flaky)\n", o.Flow)
					continue
				}
				fmt.Fprintf(&b, "  ✓ %s đạt\n", o.Flow)
				continue
			}
			failed++
			fmt.Fprintf(&b, "  ✗ %s lỗi", o.Flow)
			if o.FailureClass != "" {
				fmt.Fprintf(&b, " [%s]", o.FailureClass)
			}
			if o.Error != "" {
				fmt.Fprintf(&b, ": %s", o.Error)
			}
			b.WriteString("\n")
		}
	}
	for _, p := range problems {
		fmt.Fprintf(&b, "⚠ %s\n", p)
	}
	fmt.Fprintf(&b, "Tổng: %d đạt, %d lỗi.", passed, failed)
	return b.String()
}
