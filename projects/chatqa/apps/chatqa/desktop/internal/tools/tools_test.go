package tools

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strconv"
	"strings"
	"testing"

	"github.com/devicelab-dev/maestro-runner/pkg/cli"
	"github.com/devicelab-dev/maestro-runner/pkg/core"
	"github.com/devicelab-dev/maestro-runner/pkg/driver/mock"

	cqmod "chatqa/internal/modules"
	cqmonitor "chatqa/internal/modules/monitor"
	cqtest "chatqa/internal/modules/test"
	cqtower "chatqa/internal/modules/tower"
	"chatqa/internal/testengine"
	tw "chatqa/internal/tower"
	"chatqa/internal/tower/pool"
	"deskcore/apperr"
	"deskcore/modules"
	"deskcore/offline"
)

type fakeHost struct {
	perms []string // nil = đủ quyền
}

func (h *fakeHost) Context() context.Context { return context.Background() }
func (h *fakeHost) WorkingActor() (offline.Actor, error) {
	return offline.Actor{UserID: "u1", DeviceID: "PC1", At: 1_794_000_000}, nil
}
func (h *fakeHost) RequirePerm(p string) error {
	if h.perms == nil || slices.Contains(h.perms, p) {
		return nil
	}
	return apperr.New(apperr.CodePermissionDenied, p)
}
func (h *fakeHost) RequireApp(modules.Code) error { return nil }

type memSecrets struct{ m map[string]string }

func (s *memSecrets) Get(n string) (string, error) {
	if v, ok := s.m[n]; ok {
		return v, nil
	}
	return "", apperr.New(testengine.CodeSecretMissing, n)
}
func (s *memSecrets) Set(n, v string) error { s.m[n] = v; return nil }
func (s *memSecrets) Delete(n string) error { delete(s.m, n); return nil }
func (s *memSecrets) Names() ([]string, error) {
	var out []string
	for k := range s.m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out, nil
}

type env struct {
	registry *Registry
	tower    *tw.Tower
	store    *tw.Store
}

func newEnv(t *testing.T, host modules.Host) env {
	t.Helper()
	dir := t.TempDir()
	p := testengine.NewPool()
	p.Create = func(cfg *cli.RunConfig) (core.Driver, func(), error) {
		return mock.New(mock.Config{Platform: cfg.Platform, DeviceID: cfg.Devices[0]}), func() {}, nil
	}
	m, err := testengine.OpenMetrics(filepath.Join(dir, "testengine.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { m.Close() })
	e := testengine.NewEngine(dir, p, m, &memSecrets{m: map[string]string{"PASSWORD": "x"}})
	e.Home, e.Preflight = nil, nil
	store, err := tw.OpenStore(filepath.Join(dir, "tower.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	local := pool.NewLocal(e, &pool.Discoverer{}, store)
	local.Discover = func(context.Context) ([]pool.Found, error) {
		return []pool.Found{{ID: "emu-1", Platform: testengine.PlatformAndroid, Model: "Pixel", Online: true}}, nil
	}
	local.Facts = nil
	tower := tw.New(e, store, local)
	if _, err := local.Poll(context.Background()); err != nil {
		t.Fatal(err)
	}
	flows := filepath.Join(dir, "flows", "demo")
	os.MkdirAll(flows, 0o755)
	os.WriteFile(filepath.Join(flows, "01_home.yaml"), []byte("appId: com.example\n---\n- launchApp\n"), 0o644)
	reg := Catalog(cqtower.New(host, tower), cqtest.New(host, e, cqtest.SyncDeps{}), cqmonitor.New(host, nil), tower.Pool)
	return env{registry: reg, tower: tower, store: store}
}

func contractPerms(t *testing.T) []string {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "..", "contracts", "permissions.json"))
	if err != nil {
		t.Fatal(err)
	}
	var c struct {
		Permissions []struct{ Code, Product string }
	}
	json.Unmarshal(raw, &c)
	var out []string
	for _, p := range c.Permissions {
		if p.Product == "chatqa" {
			out = append(out, p.Code)
		}
	}
	return out
}

// checkStrict: mọi object đều additionalProperties false và mọi thuộc tính đều bắt buộc (luật strict tool của Claude).
func checkStrict(t *testing.T, where string, s map[string]any) {
	switch s["type"] {
	case "object":
		if s["additionalProperties"] != false {
			t.Errorf("%s: thiếu additionalProperties false", where)
		}
		props, _ := s["properties"].(map[string]any)
		req, _ := s["required"].([]string)
		if len(req) != len(props) {
			t.Errorf("%s: required %v không đủ %d thuộc tính", where, req, len(props))
		}
		for k, v := range props {
			checkStrict(t, where+"."+k, v.(map[string]any))
		}
	case "array":
		checkStrict(t, where+"[]", s["items"].(map[string]any))
	}
}

func TestEveryToolHasSchemaPermissionCostAndKind(t *testing.T) {
	e := newEnv(t, &fakeHost{})
	perms := contractPerms(t)
	apps := []string{string(cqmod.Tower), string(cqmod.Test), string(cqmod.Monitor)}
	tools := e.registry.List()
	if len(tools) < 25 {
		t.Fatalf("chỉ có %d tool", len(tools))
	}
	for _, tl := range tools {
		if tl.Description == "" || tl.Schema["type"] != "object" {
			t.Errorf("%s: thiếu mô tả hoặc schema", tl.Name)
		}
		checkStrict(t, tl.Name, tl.Schema)
		if tl.Perm != "" && !slices.Contains(perms, tl.Perm) {
			t.Errorf("%s: quyền %q không có trong contracts/permissions.json", tl.Name, tl.Perm)
		}
		if !slices.Contains([]string{CostFree, CostPaid, CostLLM}, tl.Cost) || !slices.Contains(Kinds, tl.Kind) || !slices.Contains(apps, tl.App) {
			t.Errorf("%s: cost=%q kind=%q app=%q", tl.Name, tl.Cost, tl.Kind, tl.App)
		}
		if strings.Contains(tl.Name, "secret") && tl.Perm != "" {
			t.Errorf("%s: không được có tool ghi biến bí mật", tl.Name)
		}
	}
	for _, need := range []string{"tower_fleet", "tower_tasks", "tower_health", "tower_budget", "tower_alerts", "tower_deliveries", "tower_device_report",
		"tower_dispatch", "tower_replay_failed", "tower_pause_all", "tower_report", "device_screenshot", "device_ui_state", "device_tap",
		"device_swipe", "test_flows", "test_validate", "test_run", "test_stop", "test_metrics", "test_report", "test_compile", "test_repair", "test_save_flow", "test_export_spec"} {
		if _, ok := e.registry.Get(need); !ok {
			t.Errorf("thiếu tool %s", need)
		}
	}
}

// Quyền khai trong danh mục phải đúng quyền Service thật sự kiểm: người không có quyền nào bị từ chối ở mọi tool có quyền,
// và không bao giờ bị từ chối vì quyền ở tool chỉ đọc.
func TestDeclaredPermissionsMatchServiceChecks(t *testing.T) {
	e := newEnv(t, &fakeHost{perms: []string{}})
	for _, tl := range e.registry.List() {
		_, err := e.registry.Call(context.Background(), tl.Name, json.RawMessage("{}"))
		denied := apperr.CodeOf(err) == apperr.CodePermissionDenied
		if tl.Perm != "" && !denied {
			t.Errorf("%s khai quyền %s nhưng gọi không có quyền vẫn qua: %v", tl.Name, tl.Perm, err)
		}
		if tl.Perm == "" && denied {
			t.Errorf("%s là tool chỉ đọc nhưng bị từ chối vì quyền: %v", tl.Name, err)
		}
	}
}

func TestArgumentsAreDecodedStrictly(t *testing.T) {
	e := newEnv(t, &fakeHost{})
	if _, err := e.registry.Call(context.Background(), "tower_tasks", json.RawMessage(`{"status":"","limit":5,"extra":1}`)); apperr.CodeOf(err) != apperr.CodeInvalid {
		t.Fatalf("trường lạ phải bị từ chối: %v", err)
	}
	if _, err := e.registry.Call(context.Background(), "nope", nil); apperr.CodeOf(err) != apperr.CodeNotFound {
		t.Fatalf("tool lạ: %v", err)
	}
}

// Thiếu tham số device phải báo thiếu tham số, không được thành "không thấy thiết bị" với mã trống; mã sai thì nêu đúng mã đó.
func TestSaveFlowReportsMissingAndUnknownDevice(t *testing.T) {
	e := newEnv(t, &fakeHost{})
	call := func(device string) error {
		args, _ := json.Marshal(map[string]any{"app": "demo", "name": "02_x.yaml", "yaml": "appId: com.example\n---\n- launchApp\n",
			"device_id": device, "env": []any{}, "secrets": []string{}, "replace": true})
		_, err := e.registry.Call(context.Background(), "test_save_flow", args)
		return err
	}
	if err := call(""); apperr.CodeOf(err) != apperr.CodeInvalid || !strings.Contains(err.Error(), "thiếu mã thiết bị") {
		t.Fatalf("device rỗng: %v", err)
	}
	if _, err := e.registry.Call(context.Background(), "test_save_flow",
		json.RawMessage(`{"app":"demo","name":"02_x.yaml","yaml":"appId: a\n---\n- launchApp\n","env":[],"secrets":[],"replace":true}`)); apperr.CodeOf(err) != apperr.CodeInvalid {
		t.Fatalf("bỏ hẳn trường device: %v", err)
	}
	if err := call("ZZZ"); apperr.CodeOf(err) != apperr.CodeNotFound || !strings.Contains(err.Error(), `"ZZZ"`) {
		t.Fatalf("device lạ: %v", err)
	}
	if err := call("emu-1"); err != nil {
		t.Fatalf("device có thật: %v", err)
	}
}

func rpc(t *testing.T, url, token, origin, body string) (int, map[string]any) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPost, url, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var out map[string]any
	b, _ := io.ReadAll(res.Body)
	json.Unmarshal(b, &out)
	return res.StatusCode, out
}

func newMCP(t *testing.T, host modules.Host) (env, string, *httptest.Server) {
	e := newEnv(t, host)
	srv := &Server{Handler: &Handler{Registry: e.registry, Version: "test"}, Store: e.store}
	token, _, err := srv.Enable("u-anh")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { srv.Disable() })
	ts := httptest.NewServer(srv)
	t.Cleanup(ts.Close)
	return e, token, ts
}

func TestMCPListCallAndRefusals(t *testing.T) {
	_, token, ts := newMCP(t, &fakeHost{perms: []string{}})
	code, res := rpc(t, ts.URL, token, "", `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"inspector","version":"1"}}}`)
	if code != 200 || res["result"].(map[string]any)["protocolVersion"] != "2025-06-18" {
		t.Fatalf("initialize: %d %v", code, res)
	}
	if code, _ := rpc(t, ts.URL, token, "", `{"jsonrpc":"2.0","method":"notifications/initialized"}`); code != http.StatusAccepted {
		t.Fatalf("thông báo phải trả 202, got %d", code)
	}
	_, res = rpc(t, ts.URL, token, "", `{"jsonrpc":"2.0","id":2,"method":"tools/list"}`)
	if n := len(res["result"].(map[string]any)["tools"].([]any)); n < 25 {
		t.Fatalf("tools/list có %d tool", n)
	}
	_, res = rpc(t, ts.URL, token, "", `{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"tower_health","arguments":{}}}`)
	r := res["result"].(map[string]any)
	if r["isError"] == true || r["structuredContent"].(map[string]any)["kind"] != "MetricChart" {
		t.Fatalf("tower_health: %v", r)
	}
	// Không token, token sai, trang web lạ: từ chối.
	if code, _ := rpc(t, ts.URL, "", "", `{"jsonrpc":"2.0","id":4,"method":"tools/list"}`); code != http.StatusUnauthorized {
		t.Fatalf("không token: %d", code)
	}
	if code, _ := rpc(t, ts.URL, "cqs_sai", "", `{"jsonrpc":"2.0","id":4,"method":"tools/list"}`); code != http.StatusUnauthorized {
		t.Fatalf("token sai: %d", code)
	}
	if code, _ := rpc(t, ts.URL, token, "https://evil.example", `{"jsonrpc":"2.0","id":4,"method":"tools/list"}`); code != http.StatusForbidden {
		t.Fatalf("origin lạ: %d", code)
	}
	// Người dùng không có cqs.run: E-011 (permission_denied) trong kết quả lỗi của tool.
	_, res = rpc(t, ts.URL, token, "", `{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"tower_pause_all","arguments":{}}}`)
	r = res["result"].(map[string]any)
	text := r["content"].([]any)[0].(map[string]any)["text"].(string)
	if r["isError"] != true || !strings.Contains(text, "permission_denied") || !strings.Contains(text, "ErrorCard") {
		t.Fatalf("thiếu quyền: %v", r)
	}
}

// Nghiệm thu 8: cùng một lệnh qua MCP và qua Wails trả JSON giống hệt.
func TestSameJSONThroughMCPAndWails(t *testing.T) {
	e, token, ts := newMCP(t, &fakeHost{})
	for _, call := range []struct{ name, args string }{
		{"tower_fleet", `{}`}, {"tower_budget", `{}`}, {"test_flows", `{"app":"demo"}`}, {"tower_tasks", `{"status":"","limit":5}`},
	} {
		direct, err := e.registry.Call(context.Background(), call.name, json.RawMessage(call.args))
		if err != nil {
			t.Fatal(err)
		}
		want, _ := json.Marshal(direct)
		_, res := rpc(t, ts.URL, token, "", `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"`+call.name+`","arguments":`+call.args+`}}`)
		got, _ := json.Marshal(res["result"].(map[string]any)["structuredContent"])
		var a, b any
		json.Unmarshal(want, &a)
		json.Unmarshal(got, &b)
		wa, _ := json.Marshal(a)
		wb, _ := json.Marshal(b)
		if !bytes.Equal(wa, wb) {
			t.Errorf("%s: Wails %s\nMCP %s", call.name, wa, wb)
		}
	}
}

func TestStdioBridge(t *testing.T) {
	_, token, ts := newMCP(t, &fakeHost{})
	in := strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25"}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"tower_fleet","arguments":{}}}
`)
	var out bytes.Buffer
	if err := RunStdio(in, &out, ts.URL, token); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) != 2 || !strings.Contains(lines[0], `"id":1`) || !strings.Contains(lines[1], "DeviceGrid") {
		t.Fatalf("stdout = %q", out.String())
	}
	var bad bytes.Buffer
	RunStdio(strings.NewReader(`{"jsonrpc":"2.0","id":7,"method":"tools/list"}`+"\n"), &bad, ts.URL, "cqs_sai")
	if !strings.Contains(bad.String(), `"id":7`) || !strings.Contains(bad.String(), "CHATQA_MCP_TOKEN") {
		t.Fatalf("token sai qua stdio: %q", bad.String())
	}
}

func TestEnableIssuesNewTokenAndStoresOnlyHash(t *testing.T) {
	e := newEnv(t, &fakeHost{})
	srv := &Server{Handler: &Handler{Registry: e.registry}, Store: e.store}
	// Cổng trống thật: port() coi 0 là không hợp lệ và dùng cổng mặc định, nên test chạy song song sẽ tranh cổng đó.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	free := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	srv.Store.SetSetting(settingMCPPort, strconv.Itoa(free))
	t1, st, err := srv.Enable("u-anh")
	if err != nil || !st.Enabled || !st.Running {
		t.Fatalf("enable: %v %+v", err, st)
	}
	defer srv.Disable()
	if e.store.Setting(settingMCPTokenHash) == t1 || !srv.authorized("Bearer "+t1) {
		t.Fatal("chỉ lưu băm; token vừa cấp phải dùng được")
	}
	srv.Stop()
	t2, _, err := srv.Enable("u-anh")
	if err != nil {
		t.Fatalf("bật lại: %v", err)
	}
	if srv.authorized("Bearer "+t1) || !srv.authorized("Bearer "+t2) {
		t.Fatal("bật lại cấp token mới, token cũ hết hiệu lực")
	}
	srv.Disable()
	if srv.Status().Enabled || srv.authorized("Bearer "+t2) {
		t.Fatal("tắt thì xoá token")
	}
}

func TestMCPTokenOnlyForTheUserWhoEnabledIt(t *testing.T) {
	_, token, ts := newMCP(t, &fakeHost{})
	srv := ts.Config.Handler.(*Server)
	current, curErr := "u-anh", error(nil)
	srv.Owner = func() (string, error) { return current, curErr }
	list := `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`
	if code, _ := rpc(t, ts.URL, token, "", list); code != http.StatusOK {
		t.Fatalf("người bật đang đăng nhập: %d", code)
	}
	current = "u-khac" // người khác đăng nhập máy này
	if code, _ := rpc(t, ts.URL, token, "", list); code != http.StatusForbidden {
		t.Fatalf("người khác đăng nhập: %d, muốn 403", code)
	}
	current, curErr = "", apperr.New(apperr.CodeUnauthorized, "") // không ai đăng nhập
	if code, _ := rpc(t, ts.URL, token, "", list); code != http.StatusForbidden {
		t.Fatalf("không ai đăng nhập: %d, muốn 403", code)
	}
}

func TestConfirmTokenNeverReachesModelOrMCP(t *testing.T) {
	err := apperr.New("confirm_required", "costVnd=30000,leftVnd=120000,token=0123abcdef")
	got := ForModel(err)
	if strings.Contains(got, "0123abcdef") || !strings.Contains(got, "costVnd=30000") || !strings.Contains(got, "xác nhận chi phí trên thẻ") {
		t.Fatalf("ForModel = %q", got)
	}
	body, _ := json.Marshal(CallResult(nil, err))
	if strings.Contains(string(body), "0123abcdef") {
		t.Fatalf("MCP lộ mã xác nhận: %s", body)
	}
}

func TestToolResultsRedactSecretValues(t *testing.T) {
	r := &Registry{Secrets: func() []string { return []string{"S3cret-Pa55"} }}
	got := r.redact(map[string]any{"error": "inputText S3cret-Pa55 failed", "n": 1})
	raw, _ := json.Marshal(got)
	if strings.Contains(string(raw), "S3cret-Pa55") || !strings.Contains(string(raw), "***") {
		t.Fatalf("kết quả chưa che: %s", raw)
	}
	s := r.redact(screen{DeviceID: "emu-1", PNG: "iVBORw0K", Tree: `{"text":"S3cret-Pa55"}`}).(screen)
	if strings.Contains(s.Tree, "S3cret-Pa55") || s.PNG != "iVBORw0K" {
		t.Fatalf("màn hình = %+v", s)
	}
	clean := map[string]any{"ok": true}
	if fmt.Sprint(r.redact(clean)) != fmt.Sprint(clean) {
		t.Fatal("kết quả không có bí mật phải giữ nguyên")
	}
}
