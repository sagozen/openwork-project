// Package guard holds the safety rules for agent tool calls: which calls a person must confirm, and which post offices
// a data-changing flow may use. It applies to calls made by agents only; MCP, the legacy chat and the UI call the
// registry directly and are not affected.
package guard

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/devicelab-dev/maestro-runner/pkg/flow"

	"chatqa/internal/agentx/config"
	"chatqa/internal/testengine"
	"chatqa/internal/tools"
)

// FlowSource is the flow store as the guard reads it. *testengine.FlowStore satisfies it.
type FlowSource interface {
	List(app string) ([]testengine.FlowInfo, error)
	Load(app string, names ...string) ([]flow.Flow, error)
	Env(app string) (testengine.EnvDefaults, error)
}

// Guard applies safety.* from agent.yaml. It is safe for concurrent use: ADK runs the tool calls of one model turn
// in parallel.
type Guard struct {
	safety config.Safety
	flows  FlowSource // nil = only the flow names and env of the call itself are known
}

// New builds a Guard. flows may be nil (tests); then a call without a flow list counts as touching every flow.
func New(s config.Safety, flows FlowSource) *Guard { return &Guard{safety: s, flows: flows} }

// runTools are the tools that start flows on devices.
var runTools = map[string]bool{"test_run": true, "tower_dispatch": true}

// IsRunTool reports whether the tool starts flows (test_run, tower_dispatch).
func IsRunTool(name string) bool { return runTools[name] }

// runArgs is the part of the test_run / tower_dispatch arguments the guard reads.
type runArgs struct {
	App   string   `json:"app"`
	Flows []string `json:"flows"`
	Env   []struct {
		Name  string `json:"name"`
		Value string `json:"value"`
	} `json:"env"`
	Record string `json:"record"`
	Label  string `json:"label"`
}

// RunRequestFrom reads test_run / tower_dispatch arguments (JSON) into the RunRequest fields the guard checks.
func RunRequestFrom(raw json.RawMessage) (testengine.RunRequest, error) {
	var a runArgs
	if err := json.Unmarshal(raw, &a); err != nil {
		return testengine.RunRequest{}, err
	}
	req := testengine.RunRequest{App: strings.TrimSpace(a.App), Flows: a.Flows, Env: map[string]string{}, Record: a.Record, Label: a.Label}
	for _, kv := range a.Env {
		req.Env[kv.Name] = kv.Value
	}
	return req, nil
}

func runRequestFromMap(args map[string]any) (testengine.RunRequest, error) {
	raw, err := json.Marshal(args)
	if err != nil {
		return testengine.RunRequest{}, err
	}
	return RunRequestFrom(raw)
}

// CheckCall is the guard in front of an agent's registry call: for test_run and tower_dispatch it runs
// CheckPostOffices; every other tool passes.
func (g *Guard) CheckCall(_ context.Context, name string, args json.RawMessage) error {
	if !IsRunTool(name) {
		return nil
	}
	req, err := RunRequestFrom(args)
	if err != nil {
		return blocked("không đọc được tham số của " + name + ", nên không kiểm được bưu cục")
	}
	return g.CheckPostOffices(req)
}

// Caller is what agents call tools through (the registry). agents.Caller has the same shape.
type Caller interface {
	Call(ctx context.Context, name string, args json.RawMessage) (*tools.Result, error)
}

// Wrap returns a Caller that runs CheckCall before every call. Use it for agent code that calls the registry
// directly (the Runner, the pipeline); ADK function tools get the same check through tools.ADKOptions.Guard.
func (g *Guard) Wrap(next Caller) Caller { return guarded{g: g, next: next} }

type guarded struct {
	g    *Guard
	next Caller
}

func (c guarded) Call(ctx context.Context, name string, args json.RawMessage) (*tools.Result, error) {
	if err := c.g.CheckCall(ctx, name, args); err != nil {
		return nil, err
	}
	return c.next.Call(ctx, name, args)
}

// targetFlows is the flow list a run touches. An empty list means every flow of the app; known is false when that
// list cannot be read.
func (g *Guard) targetFlows(app string, flows []string) (out []string, known bool) {
	if len(flows) > 0 {
		return flows, true
	}
	if g.flows == nil || app == "" {
		return nil, false
	}
	infos, err := g.flows.List(app)
	if err != nil {
		return nil, false
	}
	for _, f := range infos {
		out = append(out, f.Name)
	}
	return out, true
}

func (g *Guard) dataChanging(app string, flows []string) []string {
	var out []string
	for _, f := range flows {
		if g.safety.IsDataChanging(app, f) {
			out = append(out, f)
		}
	}
	return out
}

// envValues lists, per variable, the values a run can see: the run's own value when it sets one, else every saved
// default of the app (all, ios, android, web). The run's platform is not known from the arguments, so every scope
// counts; that can only make the guard stricter.
func (g *Guard) envValues(req testengine.RunRequest) map[string][]string {
	out := map[string][]string{}
	add := func(k, v string) {
		for _, have := range out[k] {
			if have == v {
				return
			}
		}
		out[k] = append(out[k], v)
	}
	if g.flows != nil && req.App != "" {
		if defs, err := g.flows.Env(req.App); err == nil {
			for _, vars := range defs {
				for k, v := range vars {
					if _, set := req.Env[k]; !set {
						add(k, v)
					}
				}
			}
		}
	}
	for k, v := range req.Env {
		add(k, v)
	}
	return out
}
