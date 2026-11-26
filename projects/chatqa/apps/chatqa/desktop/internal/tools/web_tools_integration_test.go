//go:build pwintegration

package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	goruntime "runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"chatqa/internal/pw"
	"chatqa/internal/testengine"
	"chatqa/internal/tower/pool"
	"deskcore/apperr"
)

// Tool web_* qua danh mục thật, Service, tháp, Local, engine và sidecar Node + Playwright + Chromium thật:
//
//	go test -tags pwintegration ./internal/tools/ -run WebTools -count=1 -v
//
// Bộ chạy: CQS_PW_DIR trỏ tới bộ chạy đã cài bằng Ensure thì dùng nguyên. Không thì dựng cùng bố cục bằng symlink:
// node trong PATH, node_modules gốc của repo (đúng Playwright ghim) và thư mục trình duyệt của Playwright trên máy.
func realWebRuntime(t *testing.T) *pw.Runtime {
	t.Helper()
	if d := os.Getenv("CQS_PW_DIR"); d != "" {
		return &pw.Runtime{Dir: d}
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("không có node trong PATH và không đặt CQS_PW_DIR")
	}
	modules := rootModules(t)
	browsers := os.Getenv("PLAYWRIGHT_BROWSERS_PATH")
	if browsers == "" {
		switch goruntime.GOOS {
		case "darwin":
			browsers = filepath.Join(os.Getenv("HOME"), "Library", "Caches", "ms-playwright")
		case "windows":
			browsers = filepath.Join(os.Getenv("LOCALAPPDATA"), "ms-playwright")
		default:
			browsers = filepath.Join(os.Getenv("HOME"), ".cache", "ms-playwright")
		}
	}
	pins := pw.DefaultPins
	dir := t.TempDir()
	nodeDir, modDir := "node-"+pins.Node, "modules-"+pins.Playwright+"-"+pins.TypeScript
	nodeBin := filepath.Join(dir, nodeDir, "bin", "node")
	if goruntime.GOOS == "windows" {
		nodeBin = filepath.Join(dir, nodeDir, "node.exe")
	}
	for _, d := range []string{filepath.Dir(nodeBin), filepath.Join(dir, modDir, "work")} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for link, target := range map[string]string{
		nodeBin: node,
		filepath.Join(dir, modDir, "node_modules"): modules,
		filepath.Join(dir, "browsers"):             browsers,
	} {
		if err := os.Symlink(target, link); err != nil {
			t.Fatal(err)
		}
	}
	ptr := fmt.Sprintf(`{"node":%q,"modules":%q}`, nodeDir, modDir)
	if err := os.WriteFile(filepath.Join(dir, "current.json"), []byte(ptr), 0o644); err != nil {
		t.Fatal(err)
	}
	return &pw.Runtime{Dir: dir}
}

func rootModules(t *testing.T) string {
	t.Helper()
	dir, _ := os.Getwd()
	for {
		m := filepath.Join(dir, "node_modules")
		if b, err := os.ReadFile(filepath.Join(m, "playwright-core", "package.json")); err == nil {
			var p struct{ Version string }
			_ = json.Unmarshal(b, &p)
			if p.Version != pw.DefaultPins.Playwright {
				t.Skipf("playwright-core ở %s là %s, khác bản ghim %s", m, p.Version, pw.DefaultPins.Playwright)
			}
			return m
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Skip("không tìm thấy node_modules có playwright-core (chạy npm ci ở gốc repo)")
		}
		dir = parent
	}
}

func TestWebToolsRealSidecar(t *testing.T) {
	var offHits atomic.Int32 // máy chủ lạ (127.0.0.1) đếm mọi request
	off := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		offHits.Add(1)
		fmt.Fprint(w, "off-host")
	}))
	defer off.Close()
	allowed := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/redirect" {
			http.Redirect(w, r, off.URL+"/redirected", http.StatusFound)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, `<!doctype html><title>Đăng nhập</title>
<label>Email <input name="email"></label>
<button onclick="document.querySelector('h1').textContent='Đã bấm'">Đăng nhập</button><h1>Chưa bấm</h1>`)
	}))
	defer allowed.Close()
	base := strings.Replace(allowed.URL, "127.0.0.1", "localhost", 1) // host được phép: localhost; 127.0.0.1 là host lạ

	rt := realWebRuntime(t)
	if err := rt.Ready("chromium", ""); err != nil {
		t.Skipf("bộ chạy chưa đủ: %v", err)
	}
	w := newWebEnv(t, &fakeHost{}) // môi trường tool thật; driver giả được thay bằng sidecar thật dưới đây
	eng := w.tower.Engine
	profile := pw.Profile{ID: "web-it", Name: "IT", Browser: "chromium", Width: 1000, Height: 700, BaseURL: base, Headless: true}
	if _, err := w.store.SaveBrowserProfile(profile, time.Now()); err != nil {
		t.Fatal(err)
	}
	sc := &pw.Sidecar{RT: rt, Log: t.Logf}
	sc.OnDown = func(gen int) { eng.WebDown(gen) }
	eng.Web = &testengine.Web{RT: rt, Sidecar: sc, Profile: w.store.BrowserProfile}
	eng.Pool.OpenWeb = eng.OpenWeb
	local := w.tower.Pool.(*pool.Local)
	local.WebReady = eng.WebReady
	if _, err := local.Poll(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		eng.Pool.CloseAll(3 * time.Second)
		_ = sc.Close()
	})

	res, err := w.call(t, "web_navigate", map[string]any{"device_id": "web-it", "url": "/"})
	if err != nil {
		t.Fatal(err)
	}
	gen := sc.Gen()
	idRe := regexp.MustCompile(fmt.Sprintf(`^%d-\d+$`, gen))
	if !strings.HasPrefix(res.URL, base) || !idRe.MatchString(res.SnapshotID) || !strings.Contains(res.Tree, "Đăng nhập") {
		t.Fatalf("web_navigate: %+v", res)
	}

	// Điền theo locator: locator chuẩn hoá; ${PASSWORD} tới trang nhưng không bao giờ hiện trong kết quả hay sổ.
	res, err = w.call(t, "web_fill", map[string]any{"device_id": "web-it", "locator": "getByLabel('Email')", "text": "${PASSWORD}"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(res.Locator, "Email") || strings.Contains(res.Tree, webSecret) || !strings.Contains(res.Tree, "***") {
		t.Fatalf("web_fill ${PASSWORD}: %+v", res)
	}
	if last := w.journal()[len(w.journal())-1]; strings.Contains(last.Args+last.Result, webSecret) {
		t.Fatalf("sổ tool lộ bí mật: %+v", last)
	}

	ui, err := w.call(t, "device_ui_state", map[string]any{"id": "web-it"})
	if err != nil {
		t.Fatal(err)
	}
	snap := snapshotIDOf(t, ui.Tree)
	m := regexp.MustCompile(`button "Đăng nhập" \[ref=(\w+)\] \[box=[0-9.]+,[0-9.]+,[0-9.]+,[0-9.]+\]`).FindStringSubmatch(ui.Tree)
	if !idRe.MatchString(snap) || m == nil || strings.Contains(ui.Tree, webSecret) {
		t.Fatalf("device_ui_state:\n%s", ui.Tree)
	}
	res, err = w.call(t, "web_click", map[string]any{"device_id": "web-it", "ref": m[1], "snapshot_id": snap})
	if err != nil {
		t.Fatal(err)
	}
	if res.Locator != "getByRole('button', { name: 'Đăng nhập' })" || !strings.Contains(res.Tree, "Đã bấm") {
		t.Fatalf("web_click theo ref: %+v", res)
	}
	if _, err := w.call(t, "web_click", map[string]any{"device_id": "web-it", "ref": m[1], "snapshot_id": snap}); apperr.CodeOf(err) != pw.CodeStaleRef {
		t.Fatalf("snapshotId cũ: %v", err)
	}

	// Host lạ: trực tiếp và qua chuyển hướng từ host được phép; máy chủ lạ không nhận request nào.
	for _, u := range []string{off.URL + "/direct", "/redirect"} {
		if _, err := w.call(t, "web_navigate", map[string]any{"device_id": "web-it", "url": u}); apperr.CodeOf(err) != pw.CodeHostBlocked {
			t.Fatalf("điều hướng %s: %v", u, err)
		}
	}
	_, _ = w.call(t, "web_wait", map[string]any{"device_id": "web-it", "sec": 1}) // request muộn (nếu lọt) kịp tới
	if n := offHits.Load(); n != 0 {
		t.Fatalf("máy chủ lạ nhận %d request", n)
	}
	if res, err := w.call(t, "device_screenshot", map[string]any{"id": "web-it"}); err != nil || res.PNG == "" {
		t.Fatalf("device_screenshot: %v", err)
	}

	// Cùng các tool qua máy chủ MCP (HTTP, token) như Claude Code gọi.
	srv := &Server{Handler: &Handler{Registry: w.registry, Version: "test"}, Store: w.store}
	token, _, err := srv.Enable("u-anh")
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Disable()
	ts := httptest.NewServer(srv)
	defer ts.Close()
	_, list := rpc(t, ts.URL, token, "", `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
	if raw, _ := json.Marshal(list); !strings.Contains(string(raw), `"web_fill"`) || !strings.Contains(string(raw), `"snapshot_id"`) {
		t.Fatalf("tools/list thiếu tool web: %s", raw)
	}
	_, out := rpc(t, ts.URL, token, "", `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"web_navigate","arguments":{"device_id":"web-it","url":"/","screenshot":true}}}`)
	r, _ := out["result"].(map[string]any)
	sc2, _ := r["structuredContent"].(map[string]any)
	data, _ := sc2["data"].(map[string]any)
	content, _ := r["content"].([]any)
	if r["isError"] == true || sc2["kind"] != "LiveScreen" || !idRe.MatchString(fmt.Sprint(data["snapshotId"])) || len(content) != 2 {
		t.Fatalf("web_navigate qua MCP: %v", out)
	}
}
