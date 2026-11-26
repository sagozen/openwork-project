package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"iter"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"google.golang.org/adk/v2/model"
	"google.golang.org/genai"

	"chatqa/internal/agentx/config"
	"chatqa/internal/agentx/models"
	agentrt "chatqa/internal/agentx/runtime"
	"chatqa/internal/tools"
)

// scripted answers each call with the next text; after the list it answers "xong".
type scripted struct {
	mu    sync.Mutex
	texts []string
	n     int
}

func (s *scripted) Name() string { return "scripted" }

func (s *scripted) GenerateContent(context.Context, *model.LLMRequest, bool) iter.Seq2[*model.LLMResponse, error] {
	return func(yield func(*model.LLMResponse, error) bool) {
		s.mu.Lock()
		text := "xong"
		if s.n < len(s.texts) {
			text = s.texts[s.n]
		}
		s.n++
		s.mu.Unlock()
		yield(&model.LLMResponse{Content: &genai.Content{Role: genai.RoleModel, Parts: []*genai.Part{{Text: text}}},
			UsageMetadata: &genai.GenerateContentResponseUsageMetadata{PromptTokenCount: 100, CandidatesTokenCount: 10}, TurnComplete: true}, nil)
	}
}

// memStore is the MCP token store.
type memStore struct {
	mu sync.Mutex
	m  map[string]string
}

func (s *memStore) Setting(k string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.m[k]
}

func (s *memStore) SetSetting(k, v string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.m[k] = v
	return nil
}

type fixedRuntime struct{ rt *agentrt.Runtime }

func (f fixedRuntime) Get(context.Context) (*agentrt.Runtime, error) { return f.rt, nil }

type env struct {
	rt      *agentrt.Runtime
	base    string // http://127.0.0.1:port
	token   string
	cfg     config.Config
	mu      sync.Mutex
	runs    []map[string]any // test_run arguments
	events  []agentrt.Event
	httpOff bool
}

const owner = "u1"

const loginPlan = `{"flows":[{"app":"mexpress","flow":"01_login.yaml","reason":"diff đụng auth"}],"platforms":["android"]}`

const orderPlan = `{"flows":[{"app":"mexpress","flow":"02_order/001_tao.yaml","reason":"diff đụng tạo đơn"}],"platforms":["android"]}`

// newEnv starts a runtime with scripted models and fake tools, mounted on the real MCP server with its gate.
func newEnv(t *testing.T, plannerReply string) *env {
	t.Helper()
	e := &env{}
	schema := map[string]any{"type": "object"}
	reg := tools.NewRegistry(
		tools.Raw("tower_fleet", "máy", "", "DeviceGrid", schema, func(context.Context, json.RawMessage) (any, error) {
			return []map[string]any{{"id": "emu-1", "platform": "android", "state": "ready"}}, nil
		}),
		tools.Raw("test_git_diff", "diff", "", "ReportCard", schema, func(context.Context, json.RawMessage) (any, error) {
			return map[string]any{"files": []map[string]any{{"path": "auth/login.go"}}}, nil
		}),
		tools.Raw("test_run", "chạy", "cqs.run", "RunProgress", schema, func(_ context.Context, raw json.RawMessage) (any, error) {
			var a map[string]any
			_ = json.Unmarshal(raw, &a)
			e.mu.Lock()
			e.runs = append(e.runs, a)
			e.mu.Unlock()
			return map[string]any{"run": map[string]any{"id": "run-1", "app": "mexpress", "passed": 1},
				"flows": []map[string]any{{"flow": "01_login.yaml", "deviceId": "emu-1", "platform": "android", "passed": true}}}, nil
		}),
	)
	cfg := config.Defaults()
	cfg.Agent.Enabled, cfg.Agent.Engine, cfg.Agent.HTTP.Enabled = true, "adk", true
	cfg.Agent.DefaultModel = "c"
	cfg.Agent.Agents = map[string]config.AgentModel{"coordinator": {Model: "c"}, "planner": {Model: "p"}, "summarizer": {Model: "s"},
		"triage": {Model: "t"}, "reporter": {Model: "r"}, "flowfixer": {Model: "f"}}
	e.cfg = cfg
	var list []models.Price
	for _, a := range []string{"c", "p", "s", "t", "r", "f"} {
		list = append(list, models.Price{Alias: a, InUsdPerM: 1, OutUsdPerM: 1})
	}
	llms := map[string]*scripted{"p": {texts: []string{plannerReply}}, "r": {texts: []string{"Báo cáo: đăng nhập đạt"}}, "c": {texts: []string{"Chào bạn"}}}
	noDelay := time.Duration(0)
	rt, err := agentrt.New(context.Background(), agentrt.Deps{Registry: reg, Config: cfg, DataDir: t.TempDir(),
		Prices: models.NewStaticPrices(list, "c", 26500), PipelineRetryDelay: &noDelay,
		LLM: func(_ context.Context, alias string) (model.LLM, error) {
			if m, ok := llms[alias]; ok {
				return m, nil
			}
			return &scripted{}, nil
		}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(rt.Close)
	e.rt = rt

	h, err := New(Options{
		Runtime: fixedRuntime{rt},
		Config: func() (config.Config, error) {
			c := e.cfg
			e.mu.Lock()
			c.Agent.HTTP.Enabled = !e.httpOff
			e.mu.Unlock()
			return c, nil
		},
		User: func() (string, error) { return owner, nil },
		OnEvent: func(ev agentrt.Event) {
			e.mu.Lock()
			e.events = append(e.events, ev)
			e.mu.Unlock()
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	store := &memStore{m: map[string]string{"mcp.port": fmt.Sprint(port)}}
	srv := &tools.Server{Handler: &tools.Handler{Registry: reg, Version: "test"}, Store: store, Owner: func() (string, error) { return owner, nil }}
	srv.SetAgent(h)
	if e.token, _, err = srv.Enable(owner); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = srv.Disable() })
	e.base = fmt.Sprintf("http://127.0.0.1:%d", port)
	return e
}

type reply struct {
	code int
	body []byte
}

func (r reply) json(t *testing.T, v any) {
	t.Helper()
	if err := json.Unmarshal(r.body, v); err != nil {
		t.Fatalf("decode %s: %v", r.body, err)
	}
}

func (e *env) do(t *testing.T, method, path, token, origin, body string) reply {
	t.Helper()
	var rd io.Reader
	if body != "" {
		rd = strings.NewReader(body)
	}
	req, _ := http.NewRequest(method, e.base+path, rd)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return reply{res.StatusCode, b}
}

func (e *env) waitStatus(t *testing.T, id string, want ...string) agentrt.PipelineStatus {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		var st agentrt.PipelineStatus
		r := e.do(t, http.MethodGet, "/agent/pipeline/"+id, e.token, "", "")
		if r.code != http.StatusOK {
			t.Fatalf("status: %d %s", r.code, r.body)
		}
		r.json(t, &st)
		for _, w := range want {
			if st.Status == w && !st.Running {
				return st
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("status stayed %+v, want %v", st, want)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

var repoMexpress = absPath("Users/me/code/mexpress")

var repoBody = `{"repo":` + quoted(repoMexpress) + `,"from":"abc","to":"def"}`

func absPath(rel string) string {
	return filepath.Join(filepath.VolumeName(os.TempDir())+string(filepath.Separator), filepath.FromSlash(rel))
}

func quoted(s string) string { b, _ := json.Marshal(s); return string(b) }

func TestAgentHTTPRefusesMissingTokenWrongTokenAndForeignOrigin(t *testing.T) {
	e := newEnv(t, loginPlan)
	routes := []struct{ method, path, body string }{
		{http.MethodPost, "/agent/pipeline", repoBody},
		{http.MethodGet, "/agent/pipeline/x", ""},
		{http.MethodPost, "/agent/run_sse", `{"appName":"chatqa","userId":"u1","sessionId":"s","newMessage":{"role":"user","parts":[{"text":"hi"}]}}`},
		{http.MethodGet, "/agent/apps/chatqa/users/u1/sessions", ""},
		{http.MethodGet, "/agent/list-apps", ""},
	}
	for _, rt := range routes {
		if r := e.do(t, rt.method, rt.path, "", "", rt.body); r.code != http.StatusUnauthorized {
			t.Errorf("%s %s without token: %d", rt.method, rt.path, r.code)
		}
		if r := e.do(t, rt.method, rt.path, "cqs_wrong", "", rt.body); r.code != http.StatusUnauthorized {
			t.Errorf("%s %s wrong token: %d", rt.method, rt.path, r.code)
		}
		if r := e.do(t, rt.method, rt.path, e.token, "https://evil.example", rt.body); r.code != http.StatusForbidden {
			t.Errorf("%s %s foreign origin: %d", rt.method, rt.path, r.code)
		}
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if len(e.runs) != 0 {
		t.Fatalf("a refused request ran flows: %v", e.runs)
	}
	if list, _ := e.rt.Sessions(context.Background(), owner); len(list) != 0 {
		t.Fatalf("a refused request created sessions: %+v", list)
	}
}

func TestAgentHTTPAnswersOnlyWhenEnabled(t *testing.T) {
	e := newEnv(t, loginPlan)
	e.mu.Lock()
	e.httpOff = true
	e.mu.Unlock()
	if r := e.do(t, http.MethodPost, "/agent/pipeline", e.token, "", repoBody); r.code != http.StatusNotFound || !strings.Contains(string(r.body), "agent.http.enabled") {
		t.Fatalf("disabled: %d %s", r.code, r.body)
	}
}

func TestPipelineTriggerOverHTTPEndToEnd(t *testing.T) {
	e := newEnv(t, loginPlan)
	r := e.do(t, http.MethodPost, "/agent/pipeline", e.token, "", repoBody)
	if r.code != http.StatusAccepted {
		t.Fatalf("start: %d %s", r.code, r.body)
	}
	var started startResponse
	r.json(t, &started)
	if started.SessionID == "" || started.StatusURL != "/agent/pipeline/"+started.SessionID {
		t.Fatalf("start = %+v", started)
	}
	st := e.waitStatus(t, started.SessionID, "done", "failed")
	if st.Status != "done" || st.Trigger != "http" || st.Failed == nil || *st.Failed || !strings.Contains(st.Report, "đăng nhập đạt") {
		t.Fatalf("final status = %+v", st)
	}
	if st.Request == nil || st.Request.Repo != repoMexpress || st.Request.From != "abc" {
		t.Fatalf("request = %+v", st.Request)
	}
	e.mu.Lock()
	runs, events := append([]map[string]any(nil), e.runs...), append([]agentrt.Event(nil), e.events...)
	e.mu.Unlock()
	if len(runs) != 1 || runs[0]["app"] != "mexpress" {
		t.Fatalf("test_run calls = %v", runs)
	}
	sawDone := false
	for _, ev := range events {
		sawDone = sawDone || (ev.SessionID == started.SessionID && ev.Kind == agentrt.KindDone)
	}
	if !sawDone {
		t.Fatal("the app did not receive the run's events")
	}

	// Bad requests are refused before anything starts.
	for _, body := range []string{`{"repo":"relative","from":"a"}`, `{"repo":"/x","from":"a","trigger":"ui"}`, `{"repo":"/x","from":"a","extra":1}`, `nope`} {
		if r := e.do(t, http.MethodPost, "/agent/pipeline", e.token, "", body); r.code != http.StatusBadRequest {
			t.Errorf("%s: %d %s", body, r.code, r.body)
		}
	}
	if r := e.do(t, http.MethodGet, "/agent/pipeline/nope", e.token, "", ""); r.code != http.StatusNotFound {
		t.Fatalf("unknown run: %d", r.code)
	}
}

func TestPipelineWaitingApprovalCannotBeApprovedOverHTTP(t *testing.T) {
	e := newEnv(t, orderPlan)
	var started startResponse
	r := e.do(t, http.MethodPost, "/agent/pipeline", e.token, "", repoBody)
	if r.code != http.StatusAccepted {
		t.Fatalf("start: %d %s", r.code, r.body)
	}
	r.json(t, &started)
	st := e.waitStatus(t, started.SessionID, "waiting_approval", "done", "failed")
	if st.Status != "waiting_approval" || len(st.Pending) != 1 || st.Pending[0].Kind != agentrt.KindRequestInput {
		t.Fatalf("status = %+v", st)
	}
	// Answering the approval as an HTTP caller is refused, as is planting state.
	answer := fmt.Sprintf(`{"appName":"chatqa","userId":"u1","sessionId":%q,"newMessage":{"role":"user","parts":[{"functionResponse":{"id":%q,"name":"adk_request_input","response":{"approved_flows":["02_order/001_tao.yaml"]}}}]}}`,
		started.SessionID, st.Pending[0].CallID)
	if r := e.do(t, http.MethodPost, "/agent/run", e.token, "", answer); r.code != http.StatusForbidden {
		t.Fatalf("self-approval: %d %s", r.code, r.body)
	}
	delta := fmt.Sprintf(`{"appName":"chatqa","userId":"u1","sessionId":%q,"newMessage":{"role":"user","parts":[{"text":"ok"}]},"stateDelta":{"pipeline.status":"done"}}`, started.SessionID)
	if r := e.do(t, http.MethodPost, "/agent/run", e.token, "", delta); r.code != http.StatusForbidden {
		t.Fatalf("state delta: %d %s", r.code, r.body)
	}
	if st := e.waitStatus(t, started.SessionID, "waiting_approval"); len(st.Pending) != 1 {
		t.Fatalf("still waiting: %+v", st)
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if len(e.runs) != 0 {
		t.Fatalf("a data-changing flow ran without approval: %v", e.runs)
	}
}

func TestADKRestChatTurnAndRefusedRoutes(t *testing.T) {
	e := newEnv(t, loginPlan)
	r := e.do(t, http.MethodPost, "/agent/apps/chatqa/users/u1/sessions", e.token, "", "")
	if r.code != http.StatusOK {
		t.Fatalf("create session: %d %s", r.code, r.body)
	}
	var sess struct {
		ID string `json:"id"`
	}
	r.json(t, &sess)
	if sess.ID == "" {
		t.Fatalf("session = %s", r.body)
	}
	run := fmt.Sprintf(`{"appName":"chatqa","userId":"u1","sessionId":%q,"newMessage":{"role":"user","parts":[{"text":"xin chào"}]}}`, sess.ID)
	r = e.do(t, http.MethodPost, "/agent/run", e.token, "", run)
	if r.code != http.StatusOK || !bytes.Contains(r.body, []byte("Chào bạn")) {
		t.Fatalf("run: %d %s", r.code, r.body)
	}
	if r := e.do(t, http.MethodGet, "/agent/apps/chatqa/users/u1/sessions/"+sess.ID, e.token, "", ""); r.code != http.StatusOK || !bytes.Contains(r.body, []byte("xin chào")) {
		t.Fatalf("get session: %d %s", r.code, r.body)
	}
	// The turn went through the runtime: the session is in the chat history.
	if list, _ := e.rt.Sessions(context.Background(), owner); len(list) != 1 || list[0].ID != sess.ID {
		t.Fatalf("history = %+v", list)
	}

	refused := []struct {
		method, path, body string
		want               int
	}{
		{http.MethodGet, "/agent/apps/chatqa/users/someone/sessions", "", http.StatusForbidden},
		{http.MethodGet, "/agent/apps/other/users/u1/sessions", "", http.StatusForbidden},
		{http.MethodPost, "/agent/apps/chatqa/users/u1/sessions", `{"state":{"pipeline.status":"done"}}`, http.StatusForbidden},
		{http.MethodPost, "/agent/apps/chatqa/users/u1/sessions", `{"events":[{"author":"user"}]}`, http.StatusForbidden},
		{http.MethodDelete, "/agent/apps/chatqa/users/u1/sessions/" + sess.ID, "", http.StatusMethodNotAllowed},
		{http.MethodPatch, "/agent/apps/chatqa/users/u1/sessions/" + sess.ID, `{"stateDelta":{"a":1}}`, http.StatusMethodNotAllowed},
		{http.MethodGet, "/agent/run_live", "", http.StatusNotFound},
		{http.MethodGet, "/agent/debug/trace/x", "", http.StatusNotFound},
		{http.MethodGet, "/agent/apps/chatqa/users/u1/sessions/" + sess.ID + "/artifacts", "", http.StatusNotFound},
		{http.MethodGet, "/agent/eval_sets", "", http.StatusNotFound},
		{http.MethodPost, "/agent/run", strings.Replace(run, `"userId":"u1"`, `"userId":"u2"`, 1), http.StatusForbidden},
		{http.MethodPost, "/agent/run", strings.Replace(run, `"appName":"chatqa"`, `"appName":"x"`, 1), http.StatusBadRequest},
		{http.MethodPost, "/agent/run", strings.Replace(run, `"text":"xin chào"`, `"inlineData":{"mimeType":"image/png","data":"AA=="}`, 1), http.StatusForbidden},
		{http.MethodGet, "/agent/run", "", http.StatusMethodNotAllowed},
	}
	for _, c := range refused {
		if r := e.do(t, c.method, c.path, e.token, "", c.body); r.code != c.want {
			t.Errorf("%s %s %s: %d %s, want %d", c.method, c.path, c.body, r.code, r.body, c.want)
		}
	}
	if r := e.do(t, http.MethodGet, "/agent/list-apps", e.token, "", ""); r.code != http.StatusOK || !bytes.Contains(r.body, []byte("chatqa")) {
		t.Fatalf("list-apps: %d %s", r.code, r.body)
	}
}
