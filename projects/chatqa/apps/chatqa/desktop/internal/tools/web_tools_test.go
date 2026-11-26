package tools

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"chatqa/internal/pw"
	"chatqa/internal/testengine"
	"chatqa/internal/tower/pool"
	"deskcore/apperr"
	"deskcore/modules"
)

var webToolNames = []string{"web_navigate", "web_back", "web_click", "web_fill", "web_press", "web_select", "web_wait"}

const webSecret = "S3cret-Pa55 w/x&y"

// fakeWebDriver: trang giả của một hồ sơ trình duyệt. Ghi lại mọi thao tác (kể cả Vars) và trả lại như sidecar:
// snapshotId đổi sau mỗi lần đọc/thao tác, ref cũ thì web_stale_ref, fill để giá trị hiện lại trong snapshot.
// pageURL/pageLocator (nếu đặt) là URL và locator trang trả về, để thử bí mật nằm trong URL hay tên phần tử.
type fakeWebDriver struct {
	mu          sync.Mutex
	acts        []testengine.WebAction
	snap        int
	pageURL     string
	pageLocator string
}

var fakeVar = regexp.MustCompile(`\$\{([A-Z_][A-Z0-9_]*)\}`)

func (f *fakeWebDriver) Screenshot() ([]byte, error) {
	img := image.NewRGBA(image.Rect(0, 0, 64, 40))
	img.Set(1, 1, color.White)
	var buf bytes.Buffer
	err := png.Encode(&buf, img)
	return buf.Bytes(), err
}

func (f *fakeWebDriver) Hierarchy() ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.snap++
	return fmt.Appendf(nil, "# url: http://app.test/login | title: \"Đăng nhập\" | viewport: 1280x800 | snapshotId: 1-%d\n"+
		"- button \"Đăng nhập\" [ref=e1] [box=0.1,0.2,0.3,0.05]", f.snap), nil
}

func (f *fakeWebDriver) Tap(context.Context, float64, float64) error { return nil }
func (f *fakeWebDriver) Swipe(context.Context, float64, float64, float64, float64, int) error {
	return nil
}

func (f *fakeWebDriver) Act(_ context.Context, a testengine.WebAction) (testengine.WebResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.acts = append(f.acts, a)
	if a.Ref != "" && a.SnapshotID != fmt.Sprintf("1-%d", f.snap) {
		return testengine.WebResult{}, apperr.New(pw.CodeStaleRef, "snapshotId "+a.SnapshotID+" đã cũ")
	}
	locator := a.Locator
	if a.Ref != "" {
		locator = "getByRole('button', { name: 'Đăng nhập' })"
	}
	if f.pageLocator != "" {
		locator = f.pageLocator
	}
	value := fakeVar.ReplaceAllStringFunc(a.Text, func(m string) string { return a.Vars[m[2:len(m)-1]] })
	u := "http://app.test/home"
	if f.pageURL != "" {
		u = f.pageURL
	}
	f.snap++
	return testengine.WebResult{Locator: locator, URL: u, SnapshotID: fmt.Sprintf("1-%d", f.snap),
		Tree: fmt.Sprintf("- textbox \"Mật khẩu\" [ref=e2]: %s\n- button \"Đăng nhập\" [ref=e1]", value)}, nil
}

func (f *fakeWebDriver) actions() []testengine.WebAction {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]testengine.WebAction(nil), f.acts...)
}

// plainDriver: driver không có thao tác web (chỉ DeviceDriver).
type plainDriver struct{}

func (plainDriver) Screenshot() ([]byte, error)                                          { return nil, nil }
func (plainDriver) Hierarchy() ([]byte, error)                                           { return nil, nil }
func (plainDriver) Tap(context.Context, float64, float64) error                          { return nil }
func (plainDriver) Swipe(context.Context, float64, float64, float64, float64, int) error { return nil }

// readyWebRuntime dựng bố cục bộ chạy đã cài (Node, gói npm, Chromium, Firefox) để Ready qua; không có gì chạy được trong đó,
// driver do OpenWeb giả trả.
func readyWebRuntime(t *testing.T) *pw.Runtime {
	t.Helper()
	dir := t.TempDir()
	pins := pw.DefaultPins
	nodeDir, modDir := "node-"+pins.Node, "modules-"+pins.Playwright+"-"+pins.TypeScript
	for name, body := range map[string]string{
		filepath.Join(nodeDir, "bin", "node"):                                                           "",
		filepath.Join(modDir, "node_modules", "playwright-core", "package.json"):                        "{}",
		filepath.Join(modDir, "node_modules", "@playwright", "test", "cli.js"):                          "",
		filepath.Join(modDir, "node_modules", "typescript", "package.json"):                             "{}",
		filepath.Join("browsers", pins.Artifacts["darwin/arm64/chromium"].Dir, "INSTALLATION_COMPLETE"): "",
		filepath.Join("browsers", pins.Artifacts["darwin/arm64/firefox"].Dir, "INSTALLATION_COMPLETE"):  "",
		"current.json": fmt.Sprintf(`{"node":%q,"modules":%q}`, nodeDir, modDir),
	} {
		p := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return &pw.Runtime{Dir: dir, Platform: "darwin/arm64"}
}

type webEnv struct {
	env
	drv     *fakeWebDriver
	journal func() []testengine.ToolCall
}

// newWebEnv: môi trường tool thật (Service, tháp, Local, engine) có thêm hồ sơ web-a (Chromium) và web-ff (Firefox)
// trên trang giả, kho bí mật có PASSWORD, kết quả được che như main.go và mọi lần gọi được ghi sổ.
func newWebEnv(t *testing.T, host modules.Host) webEnv {
	t.Helper()
	e := newEnv(t, host)
	eng := e.tower.Engine
	if err := eng.Secrets.Set("PASSWORD", webSecret); err != nil {
		t.Fatal(err)
	}
	for _, p := range []pw.Profile{
		{ID: "web-a", Name: "Staging", Browser: "chromium", Width: 1280, Height: 800, BaseURL: "http://app.test", Headless: true},
		{ID: "web-ff", Name: "Firefox", Browser: "firefox", Width: 1280, Height: 800, BaseURL: "http://app.test", Headless: true},
	} {
		if _, err := e.store.SaveBrowserProfile(p, time.Now()); err != nil {
			t.Fatal(err)
		}
	}
	rt := readyWebRuntime(t)
	eng.Web = &testengine.Web{RT: rt, Profile: e.store.BrowserProfile}
	drv := &fakeWebDriver{}
	eng.Pool.OpenWeb = func(context.Context, testengine.Device) (testengine.DeviceDriver, func(), error) {
		return drv, nil, nil
	}
	local := e.tower.Pool.(*pool.Local)
	local.Profiles, local.WebReady = e.store, eng.WebReady
	if _, err := local.Poll(context.Background()); err != nil {
		t.Fatal(err)
	}
	e.registry.Secrets = func() []string {
		v, _ := eng.Secrets.Get("PASSWORD")
		return []string{v}
	}
	var mu sync.Mutex
	var calls []testengine.ToolCall
	e.registry.Journal = func(c testengine.ToolCall) { mu.Lock(); calls = append(calls, c); mu.Unlock() }
	return webEnv{env: e, drv: drv, journal: func() []testengine.ToolCall {
		mu.Lock()
		defer mu.Unlock()
		return append([]testengine.ToolCall(nil), calls...)
	}}
}

func (w webEnv) call(t *testing.T, name string, args map[string]any) (screen, error) {
	t.Helper()
	raw, _ := json.Marshal(args)
	res, err := w.registry.Call(context.Background(), name, raw)
	if err != nil {
		return screen{}, err
	}
	switch d := res.Data.(type) {
	case screen:
		return d, nil
	default:
		t.Fatalf("%s trả %T, muốn screen", name, res.Data)
	}
	return screen{}, nil
}

func snapshotIDOf(t *testing.T, tree string) string {
	t.Helper()
	m := regexp.MustCompile(`snapshotId: (\d+-\d+)`).FindStringSubmatch(tree)
	if m == nil {
		t.Fatalf("không có snapshotId trong:\n%s", tree)
	}
	return m[1]
}

func TestWebToolsListedWithSchemaAndPerm(t *testing.T) {
	r := Catalog(nil, nil, nil, nil)
	want := map[string][]string{
		"web_navigate": {"device_id", "url", "screenshot"},
		"web_back":     {"device_id", "screenshot"},
		"web_click":    {"device_id", "ref", "snapshot_id", "locator", "double", "screenshot"},
		"web_fill":     {"device_id", "ref", "snapshot_id", "locator", "text", "submit", "screenshot"},
		"web_press":    {"device_id", "key"},
		"web_select":   {"device_id", "ref", "snapshot_id", "locator", "values"},
		"web_wait":     {"device_id", "text", "text_gone", "sec"},
	}
	for _, name := range webToolNames {
		tl, ok := r.Get(name)
		if !ok {
			t.Fatalf("thiếu tool %s", name)
		}
		if tl.Perm != modules.PermCQRun || tl.Kind != "LiveScreen" || tl.App != appTower || tl.Cost != CostFree {
			t.Errorf("%s: perm=%q kind=%q app=%q cost=%q", name, tl.Perm, tl.Kind, tl.App, tl.Cost)
		}
		props := tl.Schema["properties"].(map[string]any)
		if len(props) != len(want[name]) {
			t.Errorf("%s: tham số %v, muốn %v", name, props, want[name])
		}
		for _, p := range want[name] {
			if _, ok := props[p]; !ok {
				t.Errorf("%s thiếu tham số %s", name, p)
			}
		}
	}
	// Bộ lọc nền tảng và phạm vi biến môi trường nhận web.
	for _, name := range []string{"tower_dispatch", "test_set_env"} {
		tl, _ := r.Get(name)
		if raw, _ := json.Marshal(tl.Schema); !strings.Contains(string(raw), `"web"`) {
			t.Errorf("%s phải quảng cáo platform web: %s", name, raw)
		}
	}
	for _, name := range []string{"tower_fleet", "device_screenshot", "device_ui_state", "device_tap", "device_swipe"} {
		if tl, _ := r.Get(name); !strings.Contains(strings.ToLower(tl.Description), "web") {
			t.Errorf("mô tả %s phải nói về thiết bị web", name)
		}
	}
}

func TestWebClickByRefReturnsLocatorSnapshotAndTree(t *testing.T) {
	w := newWebEnv(t, &fakeHost{})
	ui, err := w.call(t, "device_ui_state", map[string]any{"id": "web-a"})
	if err != nil {
		t.Fatal(err)
	}
	snap := snapshotIDOf(t, ui.Tree)
	if !strings.Contains(ui.Tree, "[ref=e1]") || !strings.Contains(ui.Tree, "[box=") {
		t.Fatalf("ui_state web:\n%s", ui.Tree)
	}
	res, err := w.call(t, "web_click", map[string]any{"device_id": "web-a", "ref": "e1", "snapshot_id": snap, "locator": "", "double": false, "screenshot": false})
	if err != nil {
		t.Fatal(err)
	}
	if res.DeviceID != "web-a" || res.Locator != "getByRole('button', { name: 'Đăng nhập' })" || res.URL != "http://app.test/home" ||
		res.SnapshotID == "" || res.SnapshotID == snap || !strings.Contains(res.Tree, "[ref=e1]") || res.PNG != "" {
		t.Fatalf("web_click: %+v", res)
	}
	if a := w.drv.actions(); len(a) != 1 || a[0].Kind != "click" || a[0].Ref != "e1" || a[0].SnapshotID != snap {
		t.Fatalf("driver nhận %+v", a)
	}
	// ref của snapshot cũ: web_stale_ref
	if _, err := w.call(t, "web_click", map[string]any{"device_id": "web-a", "ref": "e1", "snapshot_id": snap}); apperr.CodeOf(err) != pw.CodeStaleRef {
		t.Fatalf("snapshot cũ: %v", err)
	}
	// Ảnh chỉ khi screenshot true, nén như device_screenshot.
	res, err = w.call(t, "web_navigate", map[string]any{"device_id": "web-a", "url": "/login", "screenshot": true})
	if err != nil || res.PNG == "" || res.Mime != mimeJPEG {
		t.Fatalf("web_navigate kèm ảnh: mime=%q png=%d %v", res.Mime, len(res.PNG), err)
	}
	for name, args := range map[string]map[string]any{
		"web_back":   {"device_id": "web-a"},
		"web_press":  {"device_id": "web-a", "key": "Enter"},
		"web_select": {"device_id": "web-a", "locator": "getByLabel('Tỉnh')", "values": []string{"HN"}},
		"web_wait":   {"device_id": "web-a", "text": "Xin chào", "sec": 5},
		"web_fill":   {"device_id": "web-a", "locator": "getByLabel('Email')", "text": "a@b.vn", "submit": true},
	} {
		if res, err := w.call(t, name, args); err != nil || res.SnapshotID == "" {
			t.Errorf("%s: %+v %v", name, res, err)
		}
	}
}

func TestWebTargetMustBeExactlyOne(t *testing.T) {
	w := newWebEnv(t, &fakeHost{})
	for name, args := range map[string]map[string]any{
		"cả hai":             {"device_id": "web-a", "ref": "e1", "snapshot_id": "1-1", "locator": "getByText('x')"},
		"không có":           {"device_id": "web-a"},
		"ref thiếu snapshot": {"device_id": "web-a", "ref": "e1"},
	} {
		if _, err := w.call(t, "web_click", args); apperr.CodeOf(err) != apperr.CodeInvalid {
			t.Errorf("%s: %v", name, err)
		}
	}
	if _, err := w.call(t, "web_wait", map[string]any{"device_id": "web-a", "sec": 11}); apperr.CodeOf(err) != apperr.CodeInvalid {
		t.Errorf("sec > 10: %v", err)
	}
	if n := len(w.drv.actions()); n != 0 {
		t.Fatalf("tham số sai không được tới driver (%d lần)", n)
	}
}

func TestWebFillSecretTemplateNeverLeavesTheApp(t *testing.T) {
	w := newWebEnv(t, &fakeHost{})
	res, err := w.call(t, "web_fill", map[string]any{"device_id": "web-a", "locator": "getByLabel('Mật khẩu')", "text": "${PASSWORD}", "submit": false})
	if err != nil {
		t.Fatal(err)
	}
	acts := w.drv.actions()
	if len(acts) != 1 || acts[0].Text != "${PASSWORD}" || acts[0].Vars["PASSWORD"] != webSecret {
		t.Fatalf("driver phải nhận mẫu và giá trị từ kho: %+v", acts)
	}
	if strings.Contains(res.Tree, webSecret) || !strings.Contains(res.Tree, `"Mật khẩu" [ref=e2]: ***`) {
		t.Fatalf("snapshot sau khi điền chưa che: %s", res.Tree)
	}
	j := w.journal()
	last := j[len(j)-1]
	if last.Tool != "web_fill" || !strings.Contains(last.Args, "${PASSWORD}") || strings.Contains(last.Args+last.Result, webSecret) {
		t.Fatalf("sổ tool: %+v", last)
	}
	calls, err := w.store.Calls(time.Time{}, 10)
	if err != nil || len(calls) == 0 || calls[0].Tool != "web_fill" || calls[0].DeviceID != "web-a" {
		t.Fatalf("nhật ký lệnh của tháp: %+v %v", calls, err)
	}
	if raw, _ := json.Marshal(calls); strings.Contains(string(raw), webSecret) || strings.Contains(string(raw), "${PASSWORD}") {
		t.Fatalf("nhật ký lệnh không được ghi tham số: %s", raw)
	}

	for name, c := range map[string]struct {
		device, text, code string
	}{
		"tên dành riêng":      {"web-a", "${WEBHOOK_SIGNING}", apperr.CodeInvalid},
		"chưa có trong kho":   {"web-a", "${OTP_CODE}", testengine.CodeSecretMissing},
		"bí mật trên Firefox": {"web-ff", "${PASSWORD}", apperr.CodeInvalid},
	} {
		_, err := w.call(t, "web_fill", map[string]any{"device_id": c.device, "locator": "getByLabel('Mật khẩu')", "text": c.text})
		if apperr.CodeOf(err) != c.code {
			t.Errorf("%s: %v", name, err)
		}
	}
	if n := len(w.drv.actions()); n != 1 {
		t.Fatalf("lần điền bị từ chối không được tới driver (%d lần)", n)
	}
}

func TestWebToolsRedactSecretInURLAndLocator(t *testing.T) {
	w := newWebEnv(t, &fakeHost{})
	for _, u := range []string{
		"http://app.test/search?q=" + webSecret,
		"http://app.test/search?q=" + url.QueryEscape(webSecret),
		"http://app.test/a/" + strings.ReplaceAll(url.PathEscape(webSecret), "%2F", "%2f"), // trình duyệt có thể viết hex thường
	} {
		w.drv.mu.Lock()
		w.drv.pageURL, w.drv.pageLocator = u, "getByRole('cell', { name: '"+webSecret+"' })"
		w.drv.mu.Unlock()
		res, err := w.call(t, "web_navigate", map[string]any{"device_id": "web-a", "url": "/search"})
		if err != nil {
			t.Fatal(err)
		}
		all := res.URL + res.Locator + res.Tree
		if strings.Contains(all, webSecret) || strings.Contains(all, url.QueryEscape(webSecret)) ||
			strings.Contains(all, strings.ReplaceAll(url.PathEscape(webSecret), "%2F", "%2f")) || !strings.Contains(res.URL, "***") ||
			res.Locator != "getByRole('cell', { name: '***' })" {
			t.Fatalf("kết quả chưa che (%s): %+v", u, res)
		}
		last := w.journal()[len(w.journal())-1]
		if strings.Contains(last.Result, webSecret) || strings.Contains(last.Result, url.QueryEscape(webSecret)) || !strings.Contains(last.Result, "***") {
			t.Fatalf("sổ tool chưa che: %s", last.Result)
		}
	}
}

func TestWebToolsRefuseNonWebDevice(t *testing.T) {
	w := newWebEnv(t, &fakeHost{})
	_, err := w.call(t, "web_click", map[string]any{"device_id": "emu-1", "locator": "getByText('OK')"})
	if apperr.CodeOf(err) != apperr.CodeInvalid || !strings.Contains(err.Error(), "chỉ dùng cho thiết bị web") {
		t.Fatalf("android: %v", err)
	}
	// Thiết bị web mà driver không có thao tác web: cũng invalid.
	w.tower.Engine.Pool.OpenWeb = func(context.Context, testengine.Device) (testengine.DeviceDriver, func(), error) {
		return plainDriver{}, nil, nil
	}
	if _, err := w.call(t, "web_back", map[string]any{"device_id": "web-ff"}); apperr.CodeOf(err) != apperr.CodeInvalid {
		t.Fatalf("driver không có Act: %v", err)
	}
}

func TestWebToolsNeedRunPermissionButUIStateIsFree(t *testing.T) {
	w := newWebEnv(t, &fakeHost{perms: []string{}})
	for _, name := range webToolNames {
		_, err := w.call(t, name, map[string]any{"device_id": "web-a"})
		if apperr.CodeOf(err) != apperr.CodePermissionDenied {
			t.Errorf("%s không có cqs.run: %v", name, err)
		}
	}
	if res, err := w.call(t, "device_ui_state", map[string]any{"id": "web-a"}); err != nil || !strings.Contains(res.Tree, "snapshotId: ") {
		t.Fatalf("device_ui_state không cần quyền: %+v %v", res, err)
	}
	if n := len(w.drv.actions()); n != 0 {
		t.Fatalf("thiếu quyền mà driver vẫn nhận %d thao tác", n)
	}
}

func TestWebActionOnHeldDeviceUsesTheHold(t *testing.T) {
	w := newWebEnv(t, &fakeHost{})
	eng := w.tower.Engine
	dev, err := w.tower.Pool.EngineDevice("web-a")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := eng.TakeOver(context.Background(), dev, 2*time.Second); err != nil {
		t.Fatal(err)
	}
	defer eng.HandBack(dev.ID)
	if _, err := w.call(t, "web_back", map[string]any{"device_id": "Staging"}); err != nil { // tên máy cũng được
		t.Fatalf("web_back khi đang giữ máy: %v", err)
	}
	if a := w.drv.actions(); len(a) != 1 || a[0].Kind != "back" {
		t.Fatalf("driver của lần giữ nhận %+v", a)
	}
}

func TestWebToolResultsMatchLiveScreenContract(t *testing.T) {
	c := loadContract(t)
	w := newWebEnv(t, &fakeHost{})
	for name, args := range map[string]map[string]any{
		"device_ui_state":   {"id": "web-a"},
		"device_screenshot": {"id": "web-a"},
		"web_navigate":      {"device_id": "web-a", "url": "/", "screenshot": true},
		"web_fill":          {"device_id": "web-a", "locator": "getByLabel('Email')", "text": "${PASSWORD}"},
	} {
		raw, _ := json.Marshal(args)
		res, err := w.registry.Call(context.Background(), name, raw)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if err := c.Validate(res.Kind, res.Data); err != nil {
			t.Errorf("%s (%s): %v", name, res.Kind, err)
		}
	}
}
