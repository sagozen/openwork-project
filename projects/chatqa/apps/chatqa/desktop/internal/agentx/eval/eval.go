// Package eval scores the agents on golden scenarios: which flows the Planner picks for a diff, how the Triage
// classifies a failure, what the chat team runs for a request and how a pipeline ends. ADK Go has no evaluation, so
// this is a plain harness for go test and cmd/agenteval.
//
// A scenario (Case) holds the input, the tool world (what the app's tools answer in that scenario) and the expected
// outcome. The model replies come from a Recording: by default the replies recorded once from a real run through the
// Worker (testdata/recorded), replayed in order per agent, so a run is deterministic and needs no network. With a live
// model source the same scenario runs against the Worker and a Recorder captures new recordings.
//
// The package is test tooling: it is not linked into the app.
package eval

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"iter"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	"google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/model"
	"google.golang.org/adk/v2/runner"
	"google.golang.org/adk/v2/session"
	"google.golang.org/genai"

	"chatqa/internal/agentx/agents"
	"chatqa/internal/agentx/config"
	"chatqa/internal/agentx/models"
	agentrt "chatqa/internal/agentx/runtime"
	"chatqa/internal/agentx/workflows"
	"chatqa/internal/testengine"
	"chatqa/internal/tools"
)

// Kinds of scenario.
const (
	KindPlanner  = "planner"  // Input is a git-impact JSON; Expect.Flows is the flow set
	KindTriage   = "triage"   // Input is a failing run report; Expect.Category is the failure category
	KindChat     = "chat"     // Input is a chat message to the team; Expect.Runs are the test_run calls
	KindPipeline = "pipeline" // Input is a pipeline request JSON; Expect.Status / Failed / Category
)

// Case is one golden scenario.
type Case struct {
	Name   string `json:"name"`
	Kind   string `json:"kind"`
	Input  string `json:"input"`
	World  World  `json:"world"`
	Expect Expect `json:"expect"`
}

// World is what the app looks like in a scenario: its flows and devices, and what its tools answer.
type World struct {
	Flows   map[string][]string        `json:"flows,omitempty"`   // app -> flow names
	Devices []Device                   `json:"devices,omitempty"` // tower_fleet
	Results map[string]FlowResult      `json:"results,omitempty"` // test_run outcome per flow; unlisted = passed
	Tools   map[string]json.RawMessage `json:"tools,omitempty"`   // fixed answer of any other read tool
}

// Device is one tower_fleet row.
type Device struct {
	ID       string `json:"id"`
	Platform string `json:"platform"`
	State    string `json:"state"`
}

// FlowResult is how a flow ends in a scenario.
type FlowResult struct {
	Passed       bool   `json:"passed"`
	FailureClass string `json:"failureClass,omitempty"`
	Error        string `json:"error,omitempty"`
}

// Expect is the scenario's golden outcome.
type Expect struct {
	Flows    []string `json:"flows,omitempty"`    // "app/flow"
	Category string   `json:"category,omitempty"` // triage category of the first finding
	Runs     []Run    `json:"runs,omitempty"`     // test_run calls, any order
	Status   string   `json:"status,omitempty"`   // pipeline status at the end
	Failed   *bool    `json:"failed,omitempty"`   // pipeline: some flow failed
}

// Run is one test_run call: app, flows and devices.
type Run struct {
	App     string   `json:"app"`
	Flows   []string `json:"flows"`
	Devices []string `json:"devices"`
}

// Outcome is what a scenario run produced.
type Outcome struct {
	Flows    []string // planner: the planned "app/flow" set
	Category string   // triage: category of the first finding
	Runs     []Run    // test_run calls
	Status   string   // pipeline status
	Failed   *bool    // pipeline: a flow failed
	Text     string   // the last agent text
}

// LoadCases reads the scenarios of a JSON file (a list of Case).
func LoadCases(path string) ([]Case, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var cases []Case
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&cases); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	seen := map[string]bool{}
	for _, c := range cases {
		if c.Name == "" || seen[c.Name] || strings.ContainsAny(c.Name, `/\. `) {
			return nil, fmt.Errorf("%s: case name %q is empty, repeated or not a plain file name", path, c.Name)
		}
		seen[c.Name] = true
		switch c.Kind {
		case KindPlanner, KindTriage, KindChat, KindPipeline:
		default:
			return nil, fmt.Errorf("%s: case %s has unknown kind %q", path, c.Name, c.Kind)
		}
	}
	return cases, nil
}

// LLMSource gives the model an agent runs on in a scenario: a Replay, or a Recorder over the live Worker.
type LLMSource func(ctx context.Context, agentName string) (model.LLM, error)

// evalAgents are the agents a scenario may reach. Each runs on a model named after it, so the replies of one agent
// never go to another.
var evalAgents = []string{"coordinator", "planner", agents.TriageName, agents.ReporterName, agents.FlowFixerName, "summarizer"}

// RunCase runs one scenario with the given models. dataDir holds the scenario's agent.db; use a fresh folder.
func RunCase(ctx context.Context, c Case, llm LLMSource, dataDir string) (Outcome, error) {
	w := newWorld(c.World)
	switch c.Kind {
	case KindPlanner:
		return runPlanner(ctx, c, w, llm)
	case KindTriage:
		return runTriage(ctx, c, w, llm)
	case KindChat, KindPipeline:
		return runTeam(ctx, c, w, llm, dataDir)
	}
	return Outcome{}, fmt.Errorf("unknown kind %q", c.Kind)
}

// hostPath makes a POSIX path of a scenario (/Users/qa/...) absolute on this OS: on Windows it gains the current
// drive, elsewhere it is returned as is.
func hostPath(p string) string {
	if p == "" || filepath.IsAbs(p) || !strings.HasPrefix(p, "/") {
		return p
	}
	return filepath.Join(filepath.VolumeName(os.TempDir())+string(filepath.Separator), filepath.FromSlash(p))
}

// world answers the tools of a scenario and records the test_run calls.
type world struct {
	w    World
	mu   sync.Mutex
	runs []Run
	n    int
}

func newWorld(w World) *world { return &world{w: w} }

func (w *world) registry() *tools.Registry {
	schema := map[string]any{"type": "object"}
	fixed := func(name string) tools.Tool {
		return tools.Raw(name, name, "", "ReportCard", schema, func(context.Context, json.RawMessage) (any, error) {
			raw, ok := w.w.Tools[name]
			if !ok {
				return nil, fmt.Errorf("kịch bản không có dữ liệu cho %s", name)
			}
			var v any
			err := json.Unmarshal(raw, &v)
			return v, err
		})
	}
	list := []tools.Tool{
		tools.Raw("tower_fleet", "máy", "", "DeviceGrid", schema, func(context.Context, json.RawMessage) (any, error) { return w.w.Devices, nil }),
		tools.Raw("test_flows", "flow", "", "FlowList", schema, func(_ context.Context, raw json.RawMessage) (any, error) {
			var a struct {
				App string `json:"app"`
			}
			_ = json.Unmarshal(raw, &a)
			return map[string]any{"app": a.App, "flows": w.w.Flows[a.App]}, nil
		}),
		tools.Raw("test_run", "chạy", "cqs.run", "RunProgress", schema, w.testRun),
	}
	names := make([]string, 0, len(w.w.Tools))
	for name := range w.w.Tools {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		if name != "tower_fleet" && name != "test_flows" && name != "test_run" {
			list = append(list, fixed(name))
		}
	}
	return tools.NewRegistry(list...)
}

func (w *world) testRun(_ context.Context, raw json.RawMessage) (any, error) {
	var a Run
	if err := json.Unmarshal(raw, &a); err != nil {
		return nil, err
	}
	w.mu.Lock()
	w.runs = append(w.runs, a)
	w.n++
	id := fmt.Sprintf("run-%d", w.n)
	w.mu.Unlock()
	platform := ""
	for _, d := range w.w.Devices {
		if len(a.Devices) > 0 && d.ID == a.Devices[0] {
			platform = d.Platform
		}
	}
	flows := make([]testengine.FlowRun, 0, len(a.Flows))
	for _, f := range a.Flows {
		res, ok := w.w.Results[a.App+"/"+f]
		if !ok {
			res = FlowResult{Passed: true}
		}
		device := ""
		if len(a.Devices) > 0 {
			device = a.Devices[0]
		}
		flows = append(flows, testengine.FlowRun{Flow: f, DeviceID: device, Platform: platform, Passed: res.Passed, FailureClass: res.FailureClass, Error: res.Error})
	}
	return testengine.RunSummary{Run: testengine.RunRecord{ID: id, App: a.App}, Flows: flows}, nil
}

func (w *world) recordedRuns() []Run {
	w.mu.Lock()
	defer w.mu.Unlock()
	return append([]Run(nil), w.runs...)
}

func (w *world) live() agents.Context {
	c := agents.Context{Flows: w.w.Flows}
	for _, d := range w.w.Devices {
		if d.State == "ready" || d.State == "connected" {
			c.Devices = append(c.Devices, fmt.Sprintf("%s (%s)", d.ID, d.Platform))
		}
	}
	return c
}

// runAlone runs a single agent on one message in a throwaway session and returns its last text.
func runAlone(ctx context.Context, a agent.Agent, input string) (string, error) {
	r, err := runner.New(runner.Config{AppName: "eval", Agent: a, SessionService: session.InMemoryService(), AutoCreateSession: true})
	if err != nil {
		return "", err
	}
	last := ""
	for ev, err := range r.Run(ctx, "eval", "eval", genai.NewContentFromText(input, genai.RoleUser), agent.RunConfig{MaxLLMCalls: 10}) {
		if err != nil {
			return last, err
		}
		if ev.Content != nil && !ev.Partial {
			for _, p := range ev.Content.Parts {
				if p.Text != "" && !p.Thought {
					last = p.Text
				}
			}
		}
	}
	return last, nil
}

func runPlanner(ctx context.Context, c Case, w *world, llm LLMSource) (Outcome, error) {
	m, err := llm(ctx, "planner")
	if err != nil {
		return Outcome{}, err
	}
	ts, err := w.registry().ADKToolset(tools.ADKOptions{})
	if err != nil {
		return Outcome{}, err
	}
	p, err := agents.NewPipelinePlanner(m, ts, w.live, agents.Memory{})
	if err != nil {
		return Outcome{}, err
	}
	text, err := runAlone(ctx, p, c.Input)
	if err != nil {
		return Outcome{}, err
	}
	plan, err := agents.ParsePlan(text)
	if err != nil {
		return Outcome{Text: text}, err
	}
	out := Outcome{Text: text}
	for _, f := range plan.Flows {
		out.Flows = append(out.Flows, f.App+"/"+f.Flow)
	}
	return out, nil
}

func runTriage(ctx context.Context, c Case, w *world, llm LLMSource) (Outcome, error) {
	m, err := llm(ctx, agents.TriageName)
	if err != nil {
		return Outcome{}, err
	}
	ts, err := w.registry().ADKToolset(tools.ADKOptions{})
	if err != nil {
		return Outcome{}, err
	}
	a, err := agents.NewTriage(m, ts, agents.Memory{})
	if err != nil {
		return Outcome{}, err
	}
	text, err := runAlone(ctx, a, c.Input)
	if err != nil {
		return Outcome{}, err
	}
	out := Outcome{Text: text}
	findings, err := agents.ParseTriage(text)
	if err != nil {
		return out, err
	}
	if len(findings) > 0 {
		out.Category = findings[0].Category
	}
	return out, nil
}

// evalConfig is agent.yaml for a scenario: every agent on its own model name (see evalAgents).
func evalConfig() config.Config {
	cfg := config.Defaults()
	cfg.Agent.Enabled, cfg.Agent.Engine, cfg.Agent.DefaultModel = true, "adk", "coordinator"
	cfg.Agent.Agents = map[string]config.AgentModel{}
	for _, a := range evalAgents {
		cfg.Agent.Agents[a] = config.AgentModel{Model: a}
	}
	return cfg
}

func runTeam(ctx context.Context, c Case, w *world, llm LLMSource, dataDir string) (Outcome, error) {
	cfg := evalConfig()
	prices := make([]models.Price, 0, len(evalAgents))
	for _, a := range evalAgents {
		prices = append(prices, models.Price{Alias: a, InUsdPerM: 1, OutUsdPerM: 1})
	}
	noDelay := time.Duration(0)
	rt, err := agentrt.New(ctx, agentrt.Deps{Registry: w.registry(), Config: cfg, DataDir: dataDir,
		Prices: models.NewStaticPrices(prices, "coordinator", 26500), PipelineRetryDelay: &noDelay,
		LLM:  func(ctx context.Context, alias string) (model.LLM, error) { return llm(ctx, alias) },
		Live: w.live})
	if err != nil {
		return Outcome{}, err
	}
	defer rt.Close()

	var mu sync.Mutex
	var evs []agentrt.Event
	done := make(chan struct{})
	onEvent := func(e agentrt.Event) {
		mu.Lock()
		defer mu.Unlock()
		evs = append(evs, e)
		if e.Kind == agentrt.KindDone {
			select {
			case <-done:
			default:
				close(done)
			}
		}
	}
	const user = "eval"
	var sessionID string
	if c.Kind == KindChat {
		if sessionID, err = rt.Send(ctx, user, "", c.Input, onEvent); err != nil {
			return Outcome{}, err
		}
	} else {
		var req workflows.Request
		if err := json.Unmarshal([]byte(c.Input), &req); err != nil {
			return Outcome{}, fmt.Errorf("pipeline input: %w", err)
		}
		req.Repo = hostPath(req.Repo)
		if sessionID, err = rt.StartPipeline(ctx, user, req, onEvent); err != nil {
			return Outcome{}, err
		}
		select {
		case <-done:
		case <-ctx.Done():
			return Outcome{}, ctx.Err()
		}
	}

	out := Outcome{Runs: w.recordedRuns()}
	mu.Lock()
	for _, e := range evs {
		if e.Kind == agentrt.KindText && e.Author != "user" {
			out.Text = e.Text
			if e.Author == agents.TriageName {
				if f, err := agents.ParseTriage(e.Text); err == nil && len(f) > 0 {
					out.Category = f[0].Category
				}
			}
		}
	}
	mu.Unlock()
	if c.Kind == KindPipeline {
		st, err := waitSettled(ctx, rt, user, sessionID)
		if err != nil {
			return out, err
		}
		out.Status, out.Failed = st.Status, st.Failed
	}
	return out, nil
}

// waitSettled waits until the pipeline session is released (its status is final once the run let go of it).
func waitSettled(ctx context.Context, rt *agentrt.Runtime, user, id string) (agentrt.PipelineStatus, error) {
	for {
		st, err := rt.PipelineStatus(ctx, user, id)
		if err != nil || !st.Running {
			return st, err
		}
		select {
		case <-ctx.Done():
			return st, ctx.Err()
		case <-time.After(5 * time.Millisecond):
		}
	}
}

// Score is how a scenario's outcome compares with its golden outcome.
type Score struct {
	Precision, Recall float64 // planner flow sets (1 when both are empty)
	Correct           bool    // the outcome matches Expect
	Notes             []string
}

// Grade compares an outcome with the case's expectations.
func Grade(c Case, o Outcome) Score {
	s := Score{Correct: true}
	miss := func(format string, args ...any) {
		s.Correct = false
		s.Notes = append(s.Notes, fmt.Sprintf(format, args...))
	}
	switch c.Kind {
	case KindPlanner:
		s.Precision, s.Recall = setScores(o.Flows, c.Expect.Flows)
		if s.Precision < 1 || s.Recall < 1 {
			miss("flows %v, want %v", o.Flows, c.Expect.Flows)
		}
	case KindTriage:
		if o.Category != c.Expect.Category {
			miss("category %q, want %q", o.Category, c.Expect.Category)
		}
	}
	if len(c.Expect.Runs) > 0 || c.Kind == KindChat {
		if !sameRuns(o.Runs, c.Expect.Runs) {
			miss("test_run calls %+v, want %+v", o.Runs, c.Expect.Runs)
		}
	}
	if c.Expect.Status != "" && o.Status != c.Expect.Status {
		miss("status %q, want %q", o.Status, c.Expect.Status)
	}
	if c.Expect.Failed != nil && (o.Failed == nil || *o.Failed != *c.Expect.Failed) {
		miss("failed %v, want %v", deref(o.Failed), *c.Expect.Failed)
	}
	if c.Kind == KindPipeline && c.Expect.Category != "" && o.Category != c.Expect.Category {
		miss("triage category %q, want %q", o.Category, c.Expect.Category)
	}
	return s
}

func deref(b *bool) any {
	if b == nil {
		return nil
	}
	return *b
}

// setScores is precision and recall of got against want, as sets.
func setScores(got, want []string) (precision, recall float64) {
	if len(got) == 0 && len(want) == 0 {
		return 1, 1
	}
	hit := 0
	for _, g := range dedupe(got) {
		if slices.Contains(want, g) {
			hit++
		}
	}
	if n := len(dedupe(got)); n > 0 {
		precision = float64(hit) / float64(n)
	}
	if n := len(dedupe(want)); n > 0 {
		recall = float64(hit) / float64(n)
	}
	return precision, recall
}

func dedupe(in []string) []string {
	out := slices.Clone(in)
	slices.Sort(out)
	return slices.Compact(out)
}

func runKey(r Run) string {
	return r.App + "|" + strings.Join(dedupe(r.Flows), ",") + "|" + strings.Join(dedupe(r.Devices), ",")
}

func sameRuns(got, want []Run) bool {
	if len(got) != len(want) {
		return false
	}
	a, b := make([]string, len(got)), make([]string, len(want))
	for i := range got {
		a[i] = runKey(got[i])
	}
	for i := range want {
		b[i] = runKey(want[i])
	}
	slices.Sort(a)
	slices.Sort(b)
	return slices.Equal(a, b)
}

// Recording holds the model replies of one scenario, per agent in call order.
type Recording struct {
	Case string `json:"case"`
	// Source says where the replies come from, e.g. "worker 2026-11-24 sonnet/haiku/opus" for a live capture.
	Source  string            `json:"source"`
	Replies map[string][]Turn `json:"replies"`
}

// Turn is one recorded model reply.
type Turn struct {
	Content *genai.Content                              `json:"content"`
	Usage   *genai.GenerateContentResponseUsageMetadata `json:"usage,omitempty"`
}

// RecordingPath is where a scenario's recording lives under dir.
func RecordingPath(dir, caseName string) string { return filepath.Join(dir, caseName+".json") }

// LoadRecording reads a scenario's recording.
func LoadRecording(dir, caseName string) (*Recording, error) {
	raw, err := os.ReadFile(RecordingPath(dir, caseName))
	if err != nil {
		return nil, err
	}
	var r Recording
	if err := json.Unmarshal(raw, &r); err != nil {
		return nil, fmt.Errorf("recording %s: %w", caseName, err)
	}
	if r.Case != caseName {
		return nil, fmt.Errorf("recording %s is for case %q", caseName, r.Case)
	}
	return &r, nil
}

// Save writes the recording as indented JSON (mode 0644).
func (r *Recording) Save(dir string) error {
	raw, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	return os.WriteFile(RecordingPath(dir, r.Case), append(raw, '\n'), 0o644)
}

// ErrExhausted is returned when an agent asks for more replies than were recorded: the agents' behaviour changed
// since the capture, and the scenario must be recorded again.
var ErrExhausted = errors.New("recording has no more replies for this agent")

// Replay serves a recording: each agent gets its recorded replies in order.
type Replay struct {
	rec *Recording
	mu  sync.Mutex
	pos map[string]int
}

// NewReplay serves rec.
func NewReplay(rec *Recording) *Replay { return &Replay{rec: rec, pos: map[string]int{}} }

// LLM is the LLMSource of the replay.
func (r *Replay) LLM(_ context.Context, agentName string) (model.LLM, error) {
	return replayModel{r: r, agent: agentName}, nil
}

// Unused lists the agents whose recorded replies were not all used, which also means the behaviour changed.
func (r *Replay) Unused() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []string
	for a, turns := range r.rec.Replies {
		if r.pos[a] < len(turns) {
			out = append(out, fmt.Sprintf("%s (%d of %d used)", a, r.pos[a], len(turns)))
		}
	}
	sort.Strings(out)
	return out
}

type replayModel struct {
	r     *Replay
	agent string
}

func (m replayModel) Name() string { return "replay-" + m.agent }

func (m replayModel) GenerateContent(context.Context, *model.LLMRequest, bool) iter.Seq2[*model.LLMResponse, error] {
	return func(yield func(*model.LLMResponse, error) bool) {
		m.r.mu.Lock()
		turns := m.r.rec.Replies[m.agent]
		i := m.r.pos[m.agent]
		if i >= len(turns) {
			m.r.mu.Unlock()
			yield(nil, fmt.Errorf("%w: %s (call %d)", ErrExhausted, m.agent, i+1))
			return
		}
		m.r.pos[m.agent] = i + 1
		t := turns[i]
		m.r.mu.Unlock()
		yield(&model.LLMResponse{Content: t.Content, UsageMetadata: t.Usage, TurnComplete: true}, nil)
	}
}

// Recorder wraps live models and keeps their final replies per agent, to save as a Recording.
type Recorder struct {
	live LLMSource
	mu   sync.Mutex
	rec  Recording
}

// NewRecorder records the replies of the live models for one scenario.
func NewRecorder(caseName, source string, live LLMSource) *Recorder {
	return &Recorder{live: live, rec: Recording{Case: caseName, Source: source, Replies: map[string][]Turn{}}}
}

// LLM is the LLMSource that records.
func (r *Recorder) LLM(ctx context.Context, agentName string) (model.LLM, error) {
	m, err := r.live(ctx, agentName)
	if err != nil {
		return nil, err
	}
	return recordingModel{LLM: m, r: r, agent: agentName}, nil
}

// Recording returns what was recorded so far.
func (r *Recorder) Recording() *Recording {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := Recording{Case: r.rec.Case, Source: r.rec.Source, Replies: map[string][]Turn{}}
	for a, t := range r.rec.Replies {
		out.Replies[a] = slices.Clone(t)
	}
	return &out
}

type recordingModel struct {
	model.LLM
	r     *Recorder
	agent string
}

func (m recordingModel) GenerateContent(ctx context.Context, req *model.LLMRequest, stream bool) iter.Seq2[*model.LLMResponse, error] {
	return func(yield func(*model.LLMResponse, error) bool) {
		for resp, err := range m.LLM.GenerateContent(ctx, req, stream) {
			if err == nil && resp != nil && !resp.Partial && resp.Content != nil {
				m.r.mu.Lock()
				m.r.rec.Replies[m.agent] = append(m.r.rec.Replies[m.agent], Turn{Content: resp.Content, Usage: resp.UsageMetadata})
				m.r.mu.Unlock()
			}
			if !yield(resp, err) {
				return
			}
		}
	}
}
