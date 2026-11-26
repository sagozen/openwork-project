package tools

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/google/jsonschema-go/jsonschema"
	"google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/tool"
	"google.golang.org/adk/v2/tool/functiontool"

	"chatqa/internal/testengine"
	"deskcore/apperr"
)

// ADKOptions tunes how registry tools are exposed to ADK agents.
type ADKOptions struct {
	// Confirm decides whether a call needs a person's approval before it runs. nil = never ask.
	// ADK runs the tool calls of one model turn in parallel, so Confirm, SaveImage and Registry.Journal must be safe
	// for concurrent use.
	Confirm func(name string, args map[string]any, risk Risk) bool
	// SaveImage stores a screenshot and returns a short reference for the model. nil = the image is dropped.
	// Base64 never goes into the model context.
	SaveImage func(ctx context.Context, tool string, data []byte, mime string) (ref string, err error)
	// Guard runs before Registry.Call; an error refuses the call and the model reads it as an ErrorCard. It runs after
	// the person approved, so an approval never lifts a safety rule. nil = no extra check. Must be concurrency-safe.
	// It applies to agent calls only: MCP and the other callers do not go through this adapter.
	Guard func(ctx context.Context, name string, args json.RawMessage) error
}

// ADKTools wraps every registry tool as an ADK function tool. Calls go through Registry.Call, so permission, budget,
// journal and redaction run exactly as they do for MCP and the legacy chat; the journal source is "agent".
func (r *Registry) ADKTools(opts ADKOptions) ([]tool.Tool, error) {
	list := r.List()
	out := make([]tool.Tool, 0, len(list))
	for _, t := range list {
		at, err := r.adkTool(t, opts)
		if err != nil {
			return nil, fmt.Errorf("tool %s: %w", t.Name, err)
		}
		out = append(out, at)
	}
	return out, nil
}

// ADKToolset is ADKTools as one toolset. Give each agent tool.FilterToolset(set, Allow(...)) over it.
func (r *Registry) ADKToolset(opts ADKOptions) (tool.Toolset, error) {
	ts, err := r.ADKTools(opts)
	if err != nil {
		return nil, err
	}
	return &staticToolset{tools: ts}, nil
}

// Allow keeps only the named tools, for tool.FilterToolset.
func Allow(names ...string) tool.Predicate { return tool.AllowedToolsPredicate(names) }

type staticToolset struct{ tools []tool.Tool }

func (s *staticToolset) Name() string { return "chatqa_tools" }

func (s *staticToolset) Tools(agent.ReadonlyContext) ([]tool.Tool, error) { return s.tools, nil }

func (r *Registry) adkTool(t Tool, opts ADKOptions) (tool.Tool, error) {
	schema, err := toJSONSchema(t.Schema)
	if err != nil {
		return nil, err
	}
	risk := RiskOf(t)
	cfg := functiontool.Config{Name: t.Name, Description: t.Description, InputSchema: schema}
	if opts.Confirm != nil {
		cfg.RequireConfirmationProvider = func(args map[string]any) bool { return opts.Confirm(t.Name, args, risk) }
	}
	return functiontool.New(cfg, func(ctx agent.Context, args map[string]any) (map[string]any, error) {
		raw, err := json.Marshal(args)
		if err != nil {
			return nil, err
		}
		if opts.Guard != nil {
			if err := opts.Guard(ctx, t.Name, raw); err != nil {
				return r.errorResult(err), nil
			}
		}
		res, err := r.Call(WithSource(ctx, testengine.ToolSourceAgent), t.Name, raw)
		if err != nil {
			if ctx.Err() != nil {
				return nil, err // cancelled run: stop, do not hand the model an error card
			}
			return r.errorResult(err), nil
		}
		return r.adkResult(ctx, t.Name, res, opts), nil
	})
}

// errorResult is the ErrorCard the model reads when a tool fails (permission, budget, bad arguments, device).
// The message is redacted here because Registry.Call only redacts successful results and the journal copy.
func (r *Registry) errorResult(err error) map[string]any {
	code := apperr.CodeOf(err)
	if code == "" {
		code = "error"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		code = "timeout"
	}
	msg := ForModel(err)
	if r.Secrets != nil {
		msg = testengine.Redact(msg, r.Secrets())
	}
	return map[string]any{"kind": "ErrorCard", "isError": true, "data": map[string]any{"code": code, "message": msg}}
}

// adkResult shapes a result like MCP structuredContent: {kind, data}. A screenshot's bytes are saved through
// SaveImage and replaced by a reference.
func (r *Registry) adkResult(ctx context.Context, name string, res *Result, opts ADKOptions) map[string]any {
	shown := res
	var ref string
	if s, ok := res.Data.(screen); ok && s.PNG != "" {
		png, mime := s.PNG, s.Mime
		s.PNG = ""
		shown = &Result{Kind: res.Kind, Data: s}
		ref = "omitted"
		if opts.SaveImage != nil {
			if data, err := base64.StdEncoding.DecodeString(png); err == nil {
				if mime == "" {
					mime = mimePNG
				}
				if got, err := opts.SaveImage(ctx, name, data, mime); err == nil {
					ref = got
				}
			}
		}
	}
	body, _ := json.Marshal(shown)
	var out map[string]any
	_ = json.Unmarshal(body, &out)
	if name == "test_flows" {
		slimFlowList(out)
	}
	if ref != "" {
		if d, ok := out["data"].(map[string]any); ok {
			d["image"] = ref
		}
	}
	return out
}

// toJSONSchema converts a registry schema (map) into the type ADK expects. additionalProperties:false and required
// survive the round trip, which Claude's strict tool use needs.
func toJSONSchema(m map[string]any) (*jsonschema.Schema, error) {
	raw, err := json.Marshal(m)
	if err != nil {
		return nil, err
	}
	var s jsonschema.Schema
	if err := json.Unmarshal(raw, &s); err != nil {
		return nil, err
	}
	return &s, nil
}

// slimFlowList drops what an agent cannot use from each flow of a test_flows result: content hashes, the save time and
// an empty dependency list. They make up about half of every entry and stay in the context for every later model call.
// Only the agent path is trimmed; MCP and the UI still get the full list.
func slimFlowList(out map[string]any) {
	data, _ := out["data"].(map[string]any)
	flows, _ := data["flows"].([]any)
	for _, f := range flows {
		flow, ok := f.(map[string]any)
		if !ok {
			continue
		}
		for _, k := range []string{"hash", "savedHash", "sourceHash", "savedAt"} {
			delete(flow, k)
		}
		if deps, ok := flow["deps"]; ok && (deps == nil || len(fmt.Sprint(deps)) <= 2) {
			delete(flow, "deps")
		}
	}
}
