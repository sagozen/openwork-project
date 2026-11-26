package tools

import (
	"context"
	"encoding/json"
	"iter"
	"slices"
	"strings"
	"sync"
	"testing"

	"google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/agent/llmagent"
	"google.golang.org/adk/v2/model"
	"google.golang.org/adk/v2/runner"
	"google.golang.org/adk/v2/session"
	"google.golang.org/adk/v2/tool"
	"google.golang.org/genai"

	"chatqa/internal/testengine"
	"deskcore/apperr"
	"deskcore/modules"
)

// scriptedLLM answers the first call with the given function calls and every later call with plain text.
type scriptedLLM struct {
	calls []*genai.FunctionCall
	n     int
}

func (s *scriptedLLM) Name() string { return "scripted" }

func (s *scriptedLLM) GenerateContent(_ context.Context, _ *model.LLMRequest, _ bool) iter.Seq2[*model.LLMResponse, error] {
	return func(yield func(*model.LLMResponse, error) bool) {
		s.n++
		parts := []*genai.Part{{Text: "xong"}}
		if s.n == 1 {
			parts = nil
			for _, c := range s.calls {
				parts = append(parts, &genai.Part{FunctionCall: c})
			}
		}
		yield(&model.LLMResponse{Content: &genai.Content{Role: genai.RoleModel, Parts: parts}, TurnComplete: true}, nil)
	}
}

// runAgent runs one user turn with the registry's tools and returns the function responses the model received.
func runAgent(t *testing.T, ts tool.Toolset, calls ...*genai.FunctionCall) []map[string]any {
	t.Helper()
	a, err := llmagent.New(llmagent.Config{Name: "tester", Model: &scriptedLLM{calls: calls}, Toolsets: []tool.Toolset{ts}})
	if err != nil {
		t.Fatal(err)
	}
	var out []map[string]any
	r, err := runner.New(runner.Config{AppName: "test", Agent: a, SessionService: session.InMemoryService(), AutoCreateSession: true})
	if err != nil {
		t.Fatal(err)
	}
	for ev, err := range r.Run(context.Background(), "u", "s1", genai.NewContentFromText("làm đi", genai.RoleUser), agent.RunConfig{}) {
		if err != nil {
			t.Fatal(err)
		}
		if ev.Content == nil {
			continue
		}
		for _, p := range ev.Content.Parts {
			if p.FunctionResponse != nil {
				out = append(out, p.FunctionResponse.Response)
			}
		}
	}
	return out
}

func TestADKToolsRunThroughRegistryAndJournalAsAgent(t *testing.T) {
	const pw = "Agent-S3cret-7"
	schema := map[string]any{"type": "object", "properties": map[string]any{"q": map[string]any{"type": "string"}}, "required": []string{"q"}, "additionalProperties": false}
	r := NewRegistry(
		Raw("shot", "ảnh", "", "LiveScreen", schema, func(context.Context, json.RawMessage) (any, error) {
			return screen{DeviceID: "emu-1", PNG: "aGVsbG8=", Mime: "image/jpeg", Tree: "ô nhập " + pw}, nil
		}),
		Raw("boom", "lỗi", "", "ErrorCard", schema, func(context.Context, json.RawMessage) (any, error) {
			return nil, apperr.New("confirm_required", "costVnd=1,token=abc123 "+pw)
		}),
	)
	r.Secrets = func() []string { return []string{pw} }
	var journal []testengine.ToolCall
	var mu sync.Mutex // ADK runs the tool calls of one model turn in parallel
	r.Journal = func(c testengine.ToolCall) {
		mu.Lock()
		defer mu.Unlock()
		journal = append(journal, c)
	}
	var savedMime string
	var saved []byte
	ts, err := r.ADKToolset(ADKOptions{SaveImage: func(_ context.Context, _ string, data []byte, mime string) (string, error) {
		saved, savedMime = data, mime
		return "artifact://shots/1", nil
	}})
	if err != nil {
		t.Fatal(err)
	}

	resp := runAgent(t, tool.FilterToolset(ts, Allow("shot", "boom")),
		&genai.FunctionCall{ID: "c1", Name: "shot", Args: map[string]any{"q": pw}},
		&genai.FunctionCall{ID: "c2", Name: "boom", Args: map[string]any{"q": "x"}})
	if len(resp) != 2 {
		t.Fatalf("function responses = %d", len(resp))
	}
	body, _ := json.Marshal(resp)
	if strings.Contains(string(body), pw) || strings.Contains(string(body), "aGVsbG8") || strings.Contains(string(body), "abc123") {
		t.Fatalf("a secret, base64 image or confirm token reached the model: %s", body)
	}
	if string(saved) != "hello" || savedMime != "image/jpeg" {
		t.Fatalf("saved image = %q %q", saved, savedMime)
	}
	var shotResp, boomResp map[string]any
	for _, m := range resp {
		if m["kind"] == "ErrorCard" {
			boomResp = m
		} else {
			shotResp = m
		}
	}
	if shotResp["data"].(map[string]any)["image"] != "artifact://shots/1" {
		t.Fatalf("image ref missing: %v", shotResp)
	}
	if boomResp == nil || boomResp["isError"] != true || boomResp["data"].(map[string]any)["code"] != "confirm_required" {
		t.Fatalf("error card = %v", boomResp)
	}

	if len(journal) != 2 {
		t.Fatalf("journal rows = %d", len(journal))
	}
	for _, c := range journal {
		if c.Source != testengine.ToolSourceAgent || strings.Contains(c.Args+c.Result+c.Error, pw) {
			t.Fatalf("journal row %+v", c)
		}
	}
}

func TestADKToolsetDropsImageWithoutSaver(t *testing.T) {
	r := NewRegistry(Raw("shot", "ảnh", "", "LiveScreen", map[string]any{"type": "object"}, func(context.Context, json.RawMessage) (any, error) {
		return screen{DeviceID: "emu-1", PNG: "aGVsbG8="}, nil
	}))
	ts, _ := r.ADKToolset(ADKOptions{})
	resp := runAgent(t, ts, &genai.FunctionCall{ID: "c1", Name: "shot", Args: map[string]any{}})
	body, _ := json.Marshal(resp)
	if strings.Contains(string(body), "aGVsbG8") || !strings.Contains(string(body), `"image":"omitted"`) {
		t.Fatalf("response = %s", body)
	}
}

func TestADKAllowListHidesOtherTools(t *testing.T) {
	e := newEnv(t, &fakeHost{})
	ts, err := e.registry.ADKToolset(ADKOptions{})
	if err != nil {
		t.Fatal(err)
	}
	all, _ := ts.Tools(nil)
	if len(all) != len(e.registry.List()) {
		t.Fatalf("toolset has %d tools, registry %d", len(all), len(e.registry.List()))
	}
	only, _ := tool.FilterToolset(ts, Allow("tower_fleet", "test_run")).Tools(nil)
	if len(only) != 2 {
		t.Fatalf("allow list kept %d tools", len(only))
	}
}

// Claude's strict tool use needs additionalProperties:false and every property required; the conversion must keep both.
func TestADKSchemasStayStrict(t *testing.T) {
	e := newEnv(t, &fakeHost{})
	all, err := e.registry.ADKTools(ADKOptions{})
	if err != nil {
		t.Fatal(err)
	}
	for _, at := range all {
		d, ok := at.(interface {
			Declaration() *genai.FunctionDeclaration
		})
		if !ok {
			t.Fatalf("%s has no Declaration", at.Name())
		}
		raw, _ := json.Marshal(d.Declaration().ParametersJsonSchema)
		var got map[string]any
		json.Unmarshal(raw, &got)
		reg, _ := e.registry.Get(at.Name())
		if got["additionalProperties"] != false {
			t.Errorf("%s: additionalProperties lost: %s", at.Name(), raw)
		}
		props, _ := got["properties"].(map[string]any)
		req, _ := got["required"].([]any)
		wantProps, _ := reg.Schema["properties"].(map[string]any)
		if len(props) != len(wantProps) || len(req) != len(wantProps) {
			t.Errorf("%s: %d properties, %d required, want %d", at.Name(), len(props), len(req), len(wantProps))
		}
	}
}

// A logged-out or unlicensed app refuses agent calls: the host check inside the service runs for the agent too.
type deniedHost struct{ fakeHost }

func (deniedHost) RequireApp(modules.Code) error {
	return apperr.New(apperr.CodePermissionDenied, "app")
}

func TestADKRefusesWhenAppNotAllowed(t *testing.T) {
	e := newEnv(t, &deniedHost{})
	ts, _ := e.registry.ADKToolset(ADKOptions{})
	resp := runAgent(t, tool.FilterToolset(ts, Allow("tower_fleet")), &genai.FunctionCall{ID: "c1", Name: "tower_fleet", Args: map[string]any{}})
	if len(resp) != 1 || resp[0]["isError"] != true || resp[0]["data"].(map[string]any)["code"] != apperr.CodePermissionDenied {
		t.Fatalf("response = %v", resp)
	}
}

func TestADKConfirmationProviderGetsRisk(t *testing.T) {
	var asked []string
	var mu sync.Mutex
	r := NewRegistry(
		Raw("peek", "xem", "", "FlowList", map[string]any{"type": "object"}, func(context.Context, json.RawMessage) (any, error) { return map[string]any{}, nil }),
		Raw("delete_flow_x", "xoá", "cqs.run", "FlowList", map[string]any{"type": "object"}, func(context.Context, json.RawMessage) (any, error) { return map[string]any{}, nil }),
	)
	ts, _ := r.ADKToolset(ADKOptions{Confirm: func(name string, _ map[string]any, risk Risk) bool {
		mu.Lock()
		defer mu.Unlock()
		asked = append(asked, name+":"+string(risk))
		return risk == RiskWrite
	}})
	resp := runAgent(t, ts,
		&genai.FunctionCall{ID: "c1", Name: "peek", Args: map[string]any{}},
		&genai.FunctionCall{ID: "c2", Name: "delete_flow_x", Args: map[string]any{}})
	slices.Sort(asked) // parallel calls arrive in any order
	if strings.Join(asked, ",") != "delete_flow_x:write,peek:read" {
		t.Fatalf("asked = %v", asked)
	}
	if len(resp) < 1 {
		t.Fatalf("responses = %v", resp)
	}
}

// confirmTurns runs a write tool that needs approval, then answers the confirmation; it returns how many times the
// tool ran and the function responses of the second turn.
func confirmTurns(t *testing.T, approved bool) (int, []*genai.FunctionResponse) {
	t.Helper()
	var mu sync.Mutex
	ran := 0
	r := NewRegistry(Raw("save_x", "lưu", "cqs.run", "FlowList", map[string]any{"type": "object"}, func(context.Context, json.RawMessage) (any, error) {
		mu.Lock()
		defer mu.Unlock()
		ran++
		return map[string]any{"saved": true}, nil
	}))
	ts, err := r.ADKToolset(ADKOptions{Confirm: func(_ string, _ map[string]any, risk Risk) bool { return risk == RiskWrite }})
	if err != nil {
		t.Fatal(err)
	}
	a, err := llmagent.New(llmagent.Config{Name: "tester", Model: &scriptedLLM{calls: []*genai.FunctionCall{{ID: "c1", Name: "save_x", Args: map[string]any{}}}}, Toolsets: []tool.Toolset{ts}})
	if err != nil {
		t.Fatal(err)
	}
	rn, err := runner.New(runner.Config{AppName: "test", Agent: a, SessionService: session.InMemoryService(), AutoCreateSession: true})
	if err != nil {
		t.Fatal(err)
	}
	var confirmID string
	for ev, err := range rn.Run(context.Background(), "u", "s1", genai.NewContentFromText("lưu đi", genai.RoleUser), agent.RunConfig{}) {
		if err != nil {
			t.Fatal(err)
		}
		if ev.Content == nil {
			continue
		}
		for _, p := range ev.Content.Parts {
			if p.FunctionCall != nil && p.FunctionCall.Name == "adk_request_confirmation" && slices.Contains(ev.LongRunningToolIDs, p.FunctionCall.ID) {
				confirmID = p.FunctionCall.ID
			}
		}
	}
	if confirmID == "" || ran != 0 {
		t.Fatalf("turn 1 must ask before running: confirm=%q ran=%d", confirmID, ran)
	}
	answer := &genai.Content{Role: genai.RoleUser, Parts: []*genai.Part{{FunctionResponse: &genai.FunctionResponse{
		ID: confirmID, Name: "adk_request_confirmation", Response: map[string]any{"confirmed": approved},
	}}}}
	var resp []*genai.FunctionResponse
	for ev, err := range rn.Run(context.Background(), "u", "s1", answer, agent.RunConfig{}) {
		if err != nil {
			t.Fatal(err)
		}
		if ev.Content == nil {
			continue
		}
		for _, p := range ev.Content.Parts {
			if p.FunctionResponse != nil && ev.Author != "user" {
				resp = append(resp, p.FunctionResponse)
			}
		}
	}
	return ran, resp
}

func TestADKConfirmationApproveRunsTheTool(t *testing.T) {
	ran, resp := confirmTurns(t, true)
	if ran != 1 || len(resp) != 1 || resp[0].Name != "save_x" || resp[0].Response["kind"] != "FlowList" {
		t.Fatalf("ran=%d responses=%+v", ran, resp)
	}
}

func TestADKConfirmationRejectSkipsTheTool(t *testing.T) {
	ran, resp := confirmTurns(t, false)
	if ran != 0 || len(resp) != 1 || resp[0].Name != "save_x" {
		t.Fatalf("ran=%d responses=%+v", ran, resp)
	}
	if body, _ := json.Marshal(resp[0].Response); !strings.Contains(string(body), "rejected") {
		t.Fatalf("the model must read that the call was rejected: %s", body)
	}
}

func TestADKGuardRefusesBeforeTheRegistry(t *testing.T) {
	called := false
	r := NewRegistry(Raw("test_run", "chạy", "cqs.run", "RunProgress", map[string]any{"type": "object"}, func(context.Context, json.RawMessage) (any, error) {
		called = true
		return map[string]any{}, nil
	}))
	var journal []testengine.ToolCall
	r.Journal = func(c testengine.ToolCall) { journal = append(journal, c) }
	ts, _ := r.ADKToolset(ADKOptions{Guard: func(_ context.Context, name string, args json.RawMessage) error {
		if name == "test_run" && strings.Contains(string(args), "HCM01") {
			return apperr.New("forbidden", "bưu cục HCM01 không được phép")
		}
		return nil
	}})
	resp := runAgent(t, ts, &genai.FunctionCall{ID: "c1", Name: "test_run", Args: map[string]any{"env": []any{map[string]any{"name": "BRANCH", "value": "HCM01"}}}})
	if called || len(resp) != 1 || resp[0]["isError"] != true || resp[0]["data"].(map[string]any)["code"] != "forbidden" {
		t.Fatalf("called=%v response=%v", called, resp)
	}
	if len(journal) != 0 {
		t.Fatalf("a refused call never reaches the registry: %+v", journal)
	}
}
