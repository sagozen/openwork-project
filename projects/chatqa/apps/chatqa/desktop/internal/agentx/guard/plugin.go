package guard

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"slices"
	"sync"
	"time"

	"google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/model"
	"google.golang.org/adk/v2/model/anthropicmodel"
	"google.golang.org/adk/v2/plugin"
	"google.golang.org/adk/v2/session"
	"google.golang.org/adk/v2/tool"
	"google.golang.org/genai"

	"chatqa/internal/agentx/config"
	"chatqa/internal/agentx/models"
	"chatqa/internal/testengine"
)

// PluginName is the name of the run guard plugin in runner.PluginConfig.
const PluginName = "chatqa_guard"

// ErrRunLimit marks a run the guard stopped because it would go over limits.max_cost_usd, limits.max_tokens_per_run
// or the machine's AI budget (the tower budget gate the legacy chat also uses).
var ErrRunLimit = errors.New("lượt agent bị dừng vì chạm trần chi phí")

// PluginOptions configures NewPlugin.
type PluginOptions struct {
	Limits config.Limits
	// Allow lists, per agent name, the tools the agent may call. An agent that is not listed may call none. This is a
	// second line behind each agent's own tool filter: it also stops a tool name the model made up.
	Allow map[string][]string
	// Secrets returns the stored secret values to mask in tool results and stored events. nil = nothing to mask.
	Secrets func() []string
	// Prices and ModelOf price a model call: ModelOf gives the Worker alias an agent runs on. Prices nil = the cost
	// ceiling cannot be estimated and only the token ceiling applies.
	Prices  *models.Prices
	ModelOf func(agentName string) string
	// Budget is the machine's AI budget gate (the tower guard), shared with the legacy chat. nil = none.
	Budget testengine.BudgetGate
	// Logf writes the structured run log. nil = log.Printf (the app log).
	Logf func(format string, args ...any)
}

// NewPlugin builds the guard every agent run goes through, for every runner (chat, pipeline, HTTP):
//   - a tool an agent is not allowed to call is refused (ErrorCard tool_not_allowed);
//   - model calls are counted per invocation; the call after limits.max_steps stops the run;
//   - each tool call gets ToolTimeout; when it runs out the model reads an ErrorCard "timeout";
//   - before each model call the cost is estimated and the run is stopped when the run total would pass
//     limits.max_cost_usd or limits.max_tokens_per_run, or when the machine's AI budget gate refuses it;
//   - tool results and stored events are passed through the registry's secret masking;
//   - each tool call, each model call and the whole run are written to the app log.
//
// Its callbacks run concurrently (ADK runs one turn's tool calls in parallel) and are safe for that.
func NewPlugin(o PluginOptions) (*plugin.Plugin, error) {
	if o.Limits.MaxSteps <= 0 || o.Limits.ToolTimeout <= 0 || o.Limits.MaxCostUSD <= 0 || o.Limits.MaxTokensPerRun <= 0 {
		return nil, errors.New("guard plugin needs positive limits")
	}
	if o.Logf == nil {
		o.Logf = log.Printf
	}
	g := &runGuard{o: o, runs: map[string]*runStats{}}
	return plugin.New(plugin.Config{
		Name:                PluginName,
		BeforeRunCallback:   g.beforeRun,
		AfterRunCallback:    g.afterRun,
		BeforeModelCallback: g.beforeModel,
		AfterModelCallback:  g.afterModel,
		BeforeToolCallback:  g.beforeTool,
		AfterToolCallback:   g.afterTool,
		OnEventCallback:     g.onEvent,
	})
}

// toolGrace is added to a tool's own wait (wait_sec, timeout_sec) so the tool can answer before the guard gives up.
const toolGrace = 30 * time.Second

// ToolTimeout is how long one tool call may take. It is limits.tool_timeout, except for the tools that wait for a
// run themselves: test_run, test_save_flow and test_save_result wait up to wait_sec (default 60 s) and
// tower_wait_task up to timeout_sec (default 600 s), then return on their own. For those the longer of tool_timeout
// and their own wait plus 30 s wins. A run's per-flow timeout (test_run timeout_sec, RunRequest.Timeout) does not
// bound the call: test_run returns the task id after wait_sec and the run carries on.
func ToolTimeout(name string, args map[string]any, base time.Duration) time.Duration {
	own := time.Duration(0)
	switch name {
	case "test_run", "test_save_flow", "test_save_result":
		own = secondsArg(args, "wait_sec", 60)
	case "tower_wait_task":
		own = secondsArg(args, "timeout_sec", 600)
	}
	if own > 0 && own+toolGrace > base {
		return own + toolGrace
	}
	return base
}

func secondsArg(args map[string]any, key string, def int) time.Duration {
	n := def
	switch v := args[key].(type) {
	case float64:
		n = int(v)
	case int:
		n = v
	case json.Number:
		if i, err := v.Int64(); err == nil {
			n = int(i)
		}
	}
	if n <= 0 {
		n = def
	}
	const maxWait = 3600 // a tool asking to wait longer than an hour is still cut there
	return time.Duration(min(n, maxWait)) * time.Second
}

// runStats is what the guard knows of one invocation.
type runStats struct {
	start      time.Time
	session    string
	modelCalls int
	toolCalls  int
	tokensIn   int
	tokensOut  int
	costUSD    float64
}

type runGuard struct {
	o    PluginOptions
	mu   sync.Mutex
	runs map[string]*runStats // by invocation id
}

// maxTrackedRuns bounds the per-invocation table in case a run ends without AfterRun (a crash in a callback).
const maxTrackedRuns = 512

func (g *runGuard) stats(invocationID, sessionID string) *runStats {
	g.mu.Lock()
	defer g.mu.Unlock()
	if st, ok := g.runs[invocationID]; ok {
		return st
	}
	if len(g.runs) >= maxTrackedRuns {
		for id, st := range g.runs {
			if time.Since(st.start) > time.Hour {
				delete(g.runs, id)
			}
		}
	}
	st := &runStats{start: time.Now(), session: sessionID}
	g.runs[invocationID] = st
	return st
}

// sessionOf reads the session id of an invocation context (run and event callbacks).
func sessionOf(ctx agent.InvocationContext) string {
	if s := ctx.Session(); s != nil {
		return s.ID()
	}
	return ""
}

func (g *runGuard) beforeRun(ctx agent.InvocationContext) (*genai.Content, error) {
	g.stats(ctx.InvocationID(), sessionOf(ctx))
	return nil, nil
}

func (g *runGuard) afterRun(ctx agent.InvocationContext) {
	g.mu.Lock()
	st, ok := g.runs[ctx.InvocationID()]
	delete(g.runs, ctx.InvocationID())
	var snap runStats
	if ok {
		snap = *st
	}
	g.mu.Unlock()
	if !ok {
		return
	}
	g.o.Logf("agent run: session=%s invocation=%s model_calls=%d tool_calls=%d tokens_in=%d tokens_out=%d cost_usd=%.4f duration_ms=%d",
		snap.session, ctx.InvocationID(), snap.modelCalls, snap.toolCalls, snap.tokensIn, snap.tokensOut, snap.costUSD, time.Since(snap.start).Milliseconds())
}

// estimateOutTokens is the reply size assumed when a request does not cap it; capped at maxEstimateOut.
const (
	estimateOutTokens = 1024
	maxEstimateOut    = 4096
)

func (g *runGuard) beforeModel(ctx agent.Context, req *model.LLMRequest) (*model.LLMResponse, error) {
	lim := g.o.Limits
	st := g.stats(ctx.InvocationID(), ctx.SessionID())
	in := estimateTokens(req)
	out := estimateOutTokens
	if req != nil && req.Config != nil && req.Config.MaxOutputTokens > 0 {
		out = int(req.Config.MaxOutputTokens)
	}
	out = min(out, maxEstimateOut)
	var est models.Cost
	if g.o.Prices != nil && g.o.ModelOf != nil {
		c, err := g.o.Prices.Cost(g.o.ModelOf(ctx.AgentName()), &genai.GenerateContentResponseUsageMetadata{PromptTokenCount: int32(in), CandidatesTokenCount: int32(out)}, 0)
		if err == nil {
			est = c
		}
	}

	g.mu.Lock()
	st.modelCalls++
	calls, tokens, cost := st.modelCalls, st.tokensIn+st.tokensOut, st.costUSD
	g.mu.Unlock()

	if calls > lim.MaxSteps {
		return nil, fmt.Errorf("agent đã gọi mô hình quá %d lần trong một lượt (limits.max_steps): %w", lim.MaxSteps, agent.ErrLLMCallsLimitExceeded)
	}
	if tokens+in+out > lim.MaxTokensPerRun {
		return nil, fmt.Errorf("%w: lần gọi mô hình tiếp theo sẽ vượt trần %d token cho một lượt (đã dùng %d, ước thêm %d)", ErrRunLimit, lim.MaxTokensPerRun, tokens, in+out)
	}
	if cost+est.USD > lim.MaxCostUSD {
		return nil, fmt.Errorf("%w: lần gọi mô hình tiếp theo sẽ vượt trần chi phí %.2f USD cho một lượt (đã dùng %.4f, ước thêm %.4f)", ErrRunLimit, lim.MaxCostUSD, cost, est.USD)
	}
	if g.o.Budget != nil {
		op := testengine.PaidOp{Kind: "llm.agent", Subject: ctx.SessionID(), CostVnd: est.VND}
		if err := g.o.Budget.Allow(op, ""); err != nil {
			return nil, fmt.Errorf("%w: ngân sách AI của máy không cho gọi thêm (%v)", ErrRunLimit, err)
		}
	}
	return nil, nil
}

// estimateTokens guesses a request's prompt size: about 4 bytes per token over the system instruction, the contents
// and the tool declarations. It only needs to be close enough to stop a run before a call, not to bill it.
func estimateTokens(req *model.LLMRequest) int {
	if req == nil {
		return 0
	}
	n := 0
	add := func(v any) {
		if raw, err := json.Marshal(v); err == nil {
			n += len(raw)
		}
	}
	add(req.Contents)
	if req.Config != nil {
		if req.Config.SystemInstruction != nil {
			add(req.Config.SystemInstruction)
		}
		add(req.Config.Tools)
	}
	return (n + 3) / 4
}

func (g *runGuard) afterModel(ctx agent.Context, resp *model.LLMResponse, respErr error) (*model.LLMResponse, error) {
	if resp == nil || resp.Partial || resp.UsageMetadata == nil {
		return nil, nil
	}
	u := resp.UsageMetadata
	in, out := int(u.PromptTokenCount), int(u.CandidatesTokenCount)+int(u.ThoughtsTokenCount)
	var cost models.Cost
	alias := ""
	if g.o.Prices != nil && g.o.ModelOf != nil {
		alias = g.o.ModelOf(ctx.AgentName())
		var write int64
		if v, ok := resp.CustomMetadata[anthropicmodel.CacheCreationInputTokensMetadataKey].(int64); ok {
			write = v
		}
		if c, err := g.o.Prices.Cost(alias, u, write); err == nil {
			cost = c
		}
	}
	st := g.stats(ctx.InvocationID(), ctx.SessionID())
	g.mu.Lock()
	st.tokensIn += in
	st.tokensOut += out
	st.costUSD += cost.USD
	g.mu.Unlock()
	g.o.Logf("agent model: session=%s invocation=%s agent=%s model=%s tokens_in=%d tokens_out=%d cost_usd=%.4f",
		ctx.SessionID(), ctx.InvocationID(), ctx.AgentName(), alias, in, out, cost.USD)
	return nil, nil
}

// runnable is the part of an ADK function tool the guard calls to run it under a deadline.
type runnable interface {
	Run(ctx agent.Context, args any) (map[string]any, error)
}

func (g *runGuard) beforeTool(ctx agent.Context, t tool.Tool, args map[string]any) (map[string]any, error) {
	name := t.Name()
	if !slices.Contains(g.o.Allow[ctx.AgentName()], name) {
		g.o.Logf("agent tool: session=%s invocation=%s agent=%s tool=%s status=refused reason=not_allowed",
			ctx.SessionID(), ctx.InvocationID(), ctx.AgentName(), name)
		return errorCard("tool_not_allowed", fmt.Sprintf("agent %s không được gọi tool %s; chỉ dùng các tool đã liệt kê", ctx.AgentName(), name)), nil
	}
	rt, ok := t.(runnable)
	if !ok || t.IsLongRunning() {
		return nil, nil // not a plain function tool (or it answers later): ADK runs it as usual
	}
	st := g.stats(ctx.InvocationID(), ctx.SessionID())
	g.mu.Lock()
	st.toolCalls++
	g.mu.Unlock()

	limit := ToolTimeout(name, args, g.o.Limits.ToolTimeout)
	tctx, cancel := context.WithTimeout(ctx, limit)
	defer cancel()
	type outcome struct {
		res map[string]any
		err error
	}
	done := make(chan outcome, 1)
	start := time.Now()
	go func() {
		res, err := rt.Run(timedContext{Context: ctx, ctx: tctx}, args)
		done <- outcome{res, err}
	}()
	var res map[string]any
	var err error
	status := "ok"
	select {
	case o := <-done:
		res, err = o.res, o.err
		if err != nil {
			status = "error"
		}
	case <-tctx.Done():
		if ctx.Err() != nil { // the run was cancelled, not timed out
			return nil, ctx.Err()
		}
		// The registry handlers do not all stop on a cancelled context; the call may finish in the background
		// (a dispatched run keeps running, as it does when test_run returns its task id).
		status = "timeout"
		res = errorCard("timeout", fmt.Sprintf("tool %s chưa xong sau %s (limits.tool_timeout); thử lại hoặc chia nhỏ việc", name, limit))
	}
	g.o.Logf("agent tool: session=%s invocation=%s agent=%s tool=%s duration_ms=%d status=%s",
		ctx.SessionID(), ctx.InvocationID(), ctx.AgentName(), name, time.Since(start).Milliseconds(), status)
	if res == nil && err == nil {
		res = map[string]any{"result": nil} // what ADK sends for a tool that returned nothing
	}
	return res, err
}

// timedContext is the tool's ADK context with the guard's deadline.
type timedContext struct {
	agent.Context
	ctx context.Context
}

func (c timedContext) Deadline() (time.Time, bool) { return c.ctx.Deadline() }
func (c timedContext) Done() <-chan struct{}       { return c.ctx.Done() }
func (c timedContext) Err() error                  { return c.ctx.Err() }
func (c timedContext) Value(key any) any           { return c.ctx.Value(key) }

func errorCard(code, msg string) map[string]any {
	return map[string]any{"kind": "ErrorCard", "isError": true, "data": map[string]any{"code": code, "message": msg}}
}

// afterTool masks secret values in a tool's result before the model reads it.
func (g *runGuard) afterTool(_ agent.Context, _ tool.Tool, _, result map[string]any, _ error) (map[string]any, error) {
	secrets := g.secrets()
	if len(secrets) == 0 || result == nil {
		return nil, nil
	}
	if red, changed := redactValue(result, secrets); changed {
		return red.(map[string]any), nil
	}
	return nil, nil
}

func (g *runGuard) secrets() []string {
	if g.o.Secrets == nil {
		return nil
	}
	return g.o.Secrets()
}

// onEvent masks secret values in an event's text, tool arguments and tool results before it is stored and shown. It
// returns a copy: the agent that made the event may still read the original.
func (g *runGuard) onEvent(_ agent.InvocationContext, ev *session.Event) (*session.Event, error) {
	secrets := g.secrets()
	if ev == nil || len(secrets) == 0 {
		return nil, nil
	}
	var parts []*genai.Part
	changed := false
	if ev.Content != nil {
		parts = make([]*genai.Part, len(ev.Content.Parts))
		for i, p := range ev.Content.Parts {
			parts[i] = p
			if p == nil {
				continue
			}
			np, ok := redactPart(p, secrets)
			if ok {
				parts[i], changed = np, true
			}
		}
	}
	errMsg := testengine.Redact(ev.ErrorMessage, secrets)
	if !changed && errMsg == ev.ErrorMessage {
		return nil, nil
	}
	out := *ev
	out.ErrorMessage = errMsg
	if changed {
		c := *ev.Content
		c.Parts = parts
		out.Content = &c
	}
	return &out, nil
}

func redactPart(p *genai.Part, secrets []string) (*genai.Part, bool) {
	np := *p
	changed := false
	if p.Text != "" {
		if t := testengine.Redact(p.Text, secrets); t != p.Text {
			np.Text, changed = t, true
		}
	}
	if fc := p.FunctionCall; fc != nil {
		if v, ok := redactValue(fc.Args, secrets); ok {
			c := *fc
			c.Args, _ = v.(map[string]any)
			np.FunctionCall, changed = &c, true
		}
	}
	if fr := p.FunctionResponse; fr != nil {
		if v, ok := redactValue(fr.Response, secrets); ok {
			c := *fr
			c.Response, _ = v.(map[string]any)
			np.FunctionResponse, changed = &c, true
		}
	}
	return &np, changed
}

// redactValue masks secret values in the strings of a decoded JSON value. It copies only what changes.
func redactValue(v any, secrets []string) (any, bool) {
	switch t := v.(type) {
	case string:
		r := testengine.Redact(t, secrets)
		return r, r != t
	case map[string]any:
		var out map[string]any
		for k, e := range t {
			if r, ok := redactValue(e, secrets); ok {
				if out == nil {
					out = make(map[string]any, len(t))
					for k2, e2 := range t {
						out[k2] = e2
					}
				}
				out[k] = r
			}
		}
		if out == nil {
			return v, false
		}
		return out, true
	case []any:
		var out []any
		for i, e := range t {
			if r, ok := redactValue(e, secrets); ok {
				if out == nil {
					out = append([]any(nil), t...)
				}
				out[i] = r
			}
		}
		if out == nil {
			return v, false
		}
		return out, true
	case nil, bool, float64, int, int64, json.Number:
		return v, false
	default:
		// A typed value (a struct a tool returned as-is): mask through its JSON form.
		raw, err := json.Marshal(t)
		if err != nil {
			return v, false
		}
		var decoded any
		if json.Unmarshal(raw, &decoded) != nil {
			return v, false
		}
		if r, ok := redactValue(decoded, secrets); ok {
			return r, true
		}
		return v, false
	}
}
