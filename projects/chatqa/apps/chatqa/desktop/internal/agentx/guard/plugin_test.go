package guard

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"iter"
	"strings"
	"sync"
	"testing"
	"time"

	"google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/agent/llmagent"
	"google.golang.org/adk/v2/model"
	"google.golang.org/adk/v2/plugin"
	"google.golang.org/adk/v2/runner"
	"google.golang.org/adk/v2/session"
	"google.golang.org/adk/v2/tool"
	"google.golang.org/adk/v2/tool/functiontool"
	"google.golang.org/genai"

	"chatqa/internal/agentx/config"
	"chatqa/internal/agentx/models"
	"chatqa/internal/testengine"
)

// stepModel answers each call with the next scripted parts; after the script it answers "xong". It records the
// requests it received.
type stepModel struct {
	mu    sync.Mutex
	steps [][]*genai.Part
	n     int
	reqs  []string
	usage int32 // prompt tokens reported per call; 0 = 100
}

func (m *stepModel) Name() string { return "step" }

func (m *stepModel) GenerateContent(_ context.Context, req *model.LLMRequest, _ bool) iter.Seq2[*model.LLMResponse, error] {
	return func(yield func(*model.LLMResponse, error) bool) {
		m.mu.Lock()
		raw, _ := json.Marshal(req.Contents)
		m.reqs = append(m.reqs, string(raw))
		parts := []*genai.Part{{Text: "xong"}}
		if m.n < len(m.steps) {
			parts = m.steps[m.n]
		}
		m.n++
		prompt := m.usage
		if prompt == 0 {
			prompt = 100
		}
		m.mu.Unlock()
		yield(&model.LLMResponse{Content: &genai.Content{Role: genai.RoleModel, Parts: parts},
			UsageMetadata: &genai.GenerateContentResponseUsageMetadata{PromptTokenCount: prompt, CandidatesTokenCount: 10}, TurnComplete: true}, nil)
	}
}

func (m *stepModel) calls() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.n
}

func call(id, name string, args map[string]any) *genai.Part {
	return &genai.Part{FunctionCall: &genai.FunctionCall{ID: id, Name: name, Args: args}}
}

type noArgs struct{}

func newTool(t *testing.T, name string, fn func(agent.Context) (map[string]any, error)) tool.Tool {
	t.Helper()
	tl, err := functiontool.New(functiontool.Config{Name: name, Description: name},
		func(ctx agent.Context, _ map[string]any) (map[string]any, error) { return fn(ctx) })
	if err != nil {
		t.Fatal(err)
	}
	return tl
}

// logBuf collects the plugin's log lines.
type logBuf struct {
	mu    sync.Mutex
	lines []string
}

func (l *logBuf) logf(format string, args ...any) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.lines = append(l.lines, fmt.Sprintf(format, args...))
}

func (l *logBuf) all() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return strings.Join(l.lines, "\n")
}

type harness struct {
	m        *stepModel
	sessions session.Service
	r        *runner.Runner
	log      *logBuf
}

var testLimits = config.Limits{MaxSteps: 10, ToolTimeout: 5 * time.Second, MaxCostUSD: 1, MaxTokensPerRun: 100000}

func newHarness(t *testing.T, o PluginOptions, m *stepModel, tools ...tool.Tool) *harness {
	t.Helper()
	h := &harness{m: m, sessions: session.InMemoryService(), log: &logBuf{}}
	if o.Logf == nil {
		o.Logf = h.log.logf
	}
	p, err := NewPlugin(o)
	if err != nil {
		t.Fatal(err)
	}
	a, err := llmagent.New(llmagent.Config{Name: "worker", Model: m, Tools: tools,
		InstructionProvider: func(agent.ReadonlyContext) (string, error) { return "làm việc", nil }})
	if err != nil {
		t.Fatal(err)
	}
	h.r, err = runner.New(runner.Config{AppName: "app", Agent: a, SessionService: h.sessions, AutoCreateSession: true,
		PluginConfig: runner.PluginConfig{Plugins: []*plugin.Plugin{p}}})
	if err != nil {
		t.Fatal(err)
	}
	return h
}

// run sends one message and returns the events and the first error.
func (h *harness) run(t *testing.T, text string) ([]*session.Event, error) {
	t.Helper()
	var evs []*session.Event
	for ev, err := range h.r.Run(context.Background(), "u1", "s1", genai.NewContentFromText(text, genai.RoleUser), agent.RunConfig{}) {
		if err != nil {
			return evs, err
		}
		evs = append(evs, ev)
	}
	return evs, nil
}

func (h *harness) stored(t *testing.T) string {
	t.Helper()
	resp, err := h.sessions.Get(context.Background(), &session.GetRequest{AppName: "app", UserID: "u1", SessionID: "s1"})
	if err != nil {
		t.Fatal(err)
	}
	var b strings.Builder
	for ev := range resp.Session.Events().All() {
		raw, _ := json.Marshal(ev.Content)
		b.Write(raw)
		b.WriteString(ev.ErrorMessage)
	}
	return b.String()
}

func responses(evs []*session.Event) map[string]map[string]any {
	out := map[string]map[string]any{}
	for _, ev := range evs {
		if ev.Content == nil {
			continue
		}
		for _, p := range ev.Content.Parts {
			if p.FunctionResponse != nil {
				out[p.FunctionResponse.Name] = p.FunctionResponse.Response
			}
		}
	}
	return out
}

func errorCode(resp map[string]any) string {
	d, _ := resp["data"].(map[string]any)
	s, _ := d["code"].(string)
	return s
}

func TestPluginRefusesToolsOutsideTheAgentsAllowlist(t *testing.T) {
	var ranHidden bool
	var mu sync.Mutex
	m := &stepModel{steps: [][]*genai.Part{{call("1", "ok_tool", nil), call("2", "hidden_tool", nil), call("3", "ghost_tool", nil)}}}
	h := newHarness(t, PluginOptions{Limits: testLimits, Allow: map[string][]string{"worker": {"ok_tool"}}}, m,
		newTool(t, "ok_tool", func(agent.Context) (map[string]any, error) { return map[string]any{"ok": true}, nil }),
		newTool(t, "hidden_tool", func(agent.Context) (map[string]any, error) {
			mu.Lock()
			ranHidden = true
			mu.Unlock()
			return map[string]any{"ok": true}, nil
		}))
	evs, err := h.run(t, "đi")
	if err != nil {
		t.Fatal(err)
	}
	res := responses(evs)
	if res["ok_tool"]["ok"] != true {
		t.Fatalf("allowed tool: %v", res["ok_tool"])
	}
	for _, name := range []string{"hidden_tool", "ghost_tool"} {
		if errorCode(res[name]) != "tool_not_allowed" {
			t.Fatalf("%s: %v", name, res[name])
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if ranHidden {
		t.Fatal("a tool outside the allowlist ran")
	}
	if !strings.Contains(h.log.all(), "tool=hidden_tool status=refused") {
		t.Fatalf("refusal not logged:\n%s", h.log.all())
	}
}

func TestPluginStopsAtMaxSteps(t *testing.T) {
	loop := []*genai.Part{call("x", "ok_tool", nil)}
	m := &stepModel{steps: [][]*genai.Part{loop, loop, loop, loop, loop}}
	lim := testLimits
	lim.MaxSteps = 2
	h := newHarness(t, PluginOptions{Limits: lim, Allow: map[string][]string{"worker": {"ok_tool"}}}, m,
		newTool(t, "ok_tool", func(agent.Context) (map[string]any, error) { return map[string]any{}, nil }))
	_, err := h.run(t, "lặp")
	if !errors.Is(err, agent.ErrLLMCallsLimitExceeded) || !strings.Contains(err.Error(), "quá 2 lần") {
		t.Fatalf("err = %v", err)
	}
	if n := m.calls(); n != 2 {
		t.Fatalf("model calls = %d, want 2", n)
	}
}

func TestPluginTimesOutASlowTool(t *testing.T) {
	release := make(chan struct{})
	t.Cleanup(func() { close(release) })
	m := &stepModel{steps: [][]*genai.Part{{call("1", "slow_tool", nil), call("2", "ok_tool", nil)}}}
	lim := testLimits
	lim.ToolTimeout = 50 * time.Millisecond
	h := newHarness(t, PluginOptions{Limits: lim, Allow: map[string][]string{"worker": {"slow_tool", "ok_tool"}}}, m,
		newTool(t, "slow_tool", func(agent.Context) (map[string]any, error) {
			<-release // ignores its context, as some registry handlers do
			return map[string]any{"late": true}, nil
		}),
		newTool(t, "ok_tool", func(agent.Context) (map[string]any, error) { return map[string]any{"ok": true}, nil }))
	begin := time.Now()
	evs, err := h.run(t, "chạy")
	if err != nil {
		t.Fatal(err)
	}
	if d := time.Since(begin); d > 2*time.Second {
		t.Fatalf("run took %v", d)
	}
	res := responses(evs)
	if errorCode(res["slow_tool"]) != "timeout" || res["ok_tool"]["ok"] != true {
		t.Fatalf("results: %v", res)
	}
	if !strings.Contains(h.log.all(), "tool=slow_tool") || !strings.Contains(h.log.all(), "status=timeout") {
		t.Fatalf("timeout not logged:\n%s", h.log.all())
	}
}

func TestToolTimeoutLetsRunToolsWaitTheirOwnTime(t *testing.T) {
	base := 120 * time.Second
	cases := []struct {
		name string
		args map[string]any
		want time.Duration
	}{
		{"device_screenshot", nil, base},
		{"test_run", nil, base}, // default wait 60 s + 30 s is under tool_timeout
		{"test_run", map[string]any{"wait_sec": float64(300)}, 330 * time.Second},
		{"tower_wait_task", nil, 630 * time.Second},
		{"tower_wait_task", map[string]any{"timeout_sec": float64(30)}, base},
		{"test_save_result", map[string]any{"wait_sec": float64(99999)}, 3630 * time.Second},
	}
	for _, c := range cases {
		if got := ToolTimeout(c.name, c.args, base); got != c.want {
			t.Errorf("%s %v: %v, want %v", c.name, c.args, got, c.want)
		}
	}
}

type gate struct {
	mu  sync.Mutex
	ops []testengine.PaidOp
	err error
}

func (g *gate) Allow(op testengine.PaidOp, _ string) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.ops = append(g.ops, op)
	return g.err
}

func TestPluginRefusesAModelCallOverTheRunBudget(t *testing.T) {
	prices := models.NewStaticPrices([]models.Price{{Alias: "m", InUsdPerM: 1000, OutUsdPerM: 1000}}, "m", 26500)
	modelOf := func(string) string { return "m" }

	t.Run("cost", func(t *testing.T) {
		m := &stepModel{}
		lim := testLimits
		lim.MaxCostUSD = 0.5 // the first call alone is estimated over 1 USD (1024 output tokens at 1000 USD/M)
		h := newHarness(t, PluginOptions{Limits: lim, Prices: prices, ModelOf: modelOf}, m)
		_, err := h.run(t, "hỏi")
		if !errors.Is(err, ErrRunLimit) || !strings.Contains(err.Error(), "vượt trần chi phí") {
			t.Fatalf("err = %v", err)
		}
		if m.calls() != 0 {
			t.Fatal("the model was called over the budget")
		}
	})
	t.Run("tokens", func(t *testing.T) {
		m := &stepModel{}
		lim := testLimits
		lim.MaxTokensPerRun = 500
		h := newHarness(t, PluginOptions{Limits: lim}, m)
		if _, err := h.run(t, "hỏi"); !errors.Is(err, ErrRunLimit) || !strings.Contains(err.Error(), "500 token") {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("run total", func(t *testing.T) {
		// The first call fits; its reported usage (50 000 prompt tokens) leaves no room for the next one.
		loop := []*genai.Part{call("x", "ok_tool", nil)}
		m := &stepModel{steps: [][]*genai.Part{loop, loop}, usage: 50000}
		lim := testLimits
		lim.MaxTokensPerRun = 20000
		h := newHarness(t, PluginOptions{Limits: lim, Allow: map[string][]string{"worker": {"ok_tool"}}}, m,
			newTool(t, "ok_tool", func(agent.Context) (map[string]any, error) { return map[string]any{}, nil }))
		if _, err := h.run(t, "a"); !errors.Is(err, ErrRunLimit) {
			t.Fatalf("err = %v", err)
		}
		if n := m.calls(); n != 1 {
			t.Fatalf("model calls = %d, want 1", n)
		}
	})
	t.Run("machine budget gate", func(t *testing.T) {
		m := &stepModel{}
		g := &gate{err: errors.New("budget_ceiling")}
		h := newHarness(t, PluginOptions{Limits: testLimits, Prices: models.NewStaticPrices([]models.Price{{Alias: "m", InUsdPerM: 1, OutUsdPerM: 1}}, "m", 26500),
			ModelOf: modelOf, Budget: g}, m)
		if _, err := h.run(t, "hỏi"); !errors.Is(err, ErrRunLimit) || !strings.Contains(err.Error(), "budget_ceiling") {
			t.Fatalf("err = %v", err)
		}
		g.mu.Lock()
		defer g.mu.Unlock()
		if len(g.ops) != 1 || g.ops[0].Kind != "llm.agent" || g.ops[0].Subject != "s1" || g.ops[0].CostVnd <= 0 {
			t.Fatalf("gate ops = %+v", g.ops)
		}
		if m.calls() != 0 {
			t.Fatal("the model was called after the gate refused")
		}
	})
}

func TestPluginRedactsToolResultsAndStoredEvents(t *testing.T) {
	const secret = "S3cret-Value-42"
	m := &stepModel{steps: [][]*genai.Part{
		{call("1", "echo_env", map[string]any{"note": "dùng " + secret})},
		{{Text: "giá trị là " + secret}},
	}}
	h := newHarness(t, PluginOptions{Limits: testLimits, Allow: map[string][]string{"worker": {"echo_env"}},
		Secrets: func() []string { return []string{secret} }}, m,
		newTool(t, "echo_env", func(agent.Context) (map[string]any, error) {
			// A tool whose result echoes the value of a stored secret (e.g. a flow env dump).
			return map[string]any{"env": map[string]any{"PASSWORD": secret}, "lines": []any{"login with " + secret}}, nil
		}))
	evs, err := h.run(t, "in biến")
	if err != nil {
		t.Fatal(err)
	}
	for _, ev := range evs {
		raw, _ := json.Marshal(ev.Content)
		if strings.Contains(string(raw), secret) {
			t.Fatalf("event streamed with the secret: %s", raw)
		}
	}
	if s := h.stored(t); strings.Contains(s, secret) || !strings.Contains(s, "PASSWORD") {
		t.Fatalf("stored events: %s", s)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.reqs) < 2 || strings.Contains(m.reqs[1], secret) {
		t.Fatalf("the model read the secret in the tool result: %v", m.reqs)
	}
}

func TestPluginLogsEachRun(t *testing.T) {
	m := &stepModel{steps: [][]*genai.Part{{call("1", "ok_tool", nil)}}}
	h := newHarness(t, PluginOptions{Limits: testLimits, Allow: map[string][]string{"worker": {"ok_tool"}},
		Prices: models.NewStaticPrices([]models.Price{{Alias: "m", InUsdPerM: 1, OutUsdPerM: 1}}, "m", 26500), ModelOf: func(string) string { return "m" }}, m,
		newTool(t, "ok_tool", func(agent.Context) (map[string]any, error) { return map[string]any{}, nil }))
	if _, err := h.run(t, "đi"); err != nil {
		t.Fatal(err)
	}
	logs := h.log.all()
	for _, want := range []string{"agent tool: session=s1", "agent=worker tool=ok_tool", "status=ok",
		"agent model: session=s1", "model=m tokens_in=100 tokens_out=10",
		"agent run: session=s1", "model_calls=2 tool_calls=1 tokens_in=200 tokens_out=20"} {
		if !strings.Contains(logs, want) {
			t.Fatalf("log misses %q:\n%s", want, logs)
		}
	}
}

func TestNewPluginNeedsLimits(t *testing.T) {
	if _, err := NewPlugin(PluginOptions{}); err == nil {
		t.Fatal("zero limits must be refused")
	}
}
