//go:build pwintegration

package tools

import (
	"archive/zip"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"chatqa/internal/pw"
	"chatqa/internal/testengine"
	"chatqa/internal/tower/pool"
)

// Client MCP (như Claude Code) lưu một spec tự viết bằng test_save_flow script rồi xuất bằng test_export_spec, qua máy
// chủ MCP HTTP, sidecar thật (kiểm tra spec) và bộ chạy thật (chạy xác nhận):
//
//	go test -tags pwintegration ./internal/tools/ -run WebAuthoringOverMCP -count=1
func TestWebAuthoringOverMCPSaveScriptThenExport(t *testing.T) {
	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, `<!doctype html><title>Đăng nhập</title><label>Mật khẩu <input type=password></label>
<button onclick="document.querySelector('h1').textContent='Xin chào'">Đăng nhập</button><h1>Chưa vào</h1>`)
	}))
	defer site.Close()
	base := strings.Replace(site.URL, "127.0.0.1", "localhost", 1)
	rt := realWebRuntime(t)
	if err := rt.Ready("chromium", ""); err != nil {
		t.Skipf("bộ chạy chưa đủ: %v", err)
	}
	w := newWebEnv(t, &fakeHost{})
	eng := w.tower.Engine
	if _, err := w.store.SaveBrowserProfile(pw.Profile{ID: "web-mcp", Name: "MCP", Browser: "chromium", Width: 1000, Height: 700,
		BaseURL: base, Headless: true}, time.Now()); err != nil {
		t.Fatal(err)
	}
	sc := &pw.Sidecar{RT: rt, Log: t.Logf}
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
	srv := &Server{Handler: &Handler{Registry: w.registry, Version: "test"}, Store: w.store}
	token, _, err := srv.Enable("u-anh")
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Disable()
	ts := httptest.NewServer(srv)
	defer ts.Close()
	call := func(id int, name string, args map[string]any) map[string]any {
		t.Helper()
		body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "method": "tools/call", "params": map[string]any{"name": name, "arguments": args}})
		_, out := rpc(t, ts.URL, token, "", string(body))
		r, _ := out["result"].(map[string]any)
		if r["isError"] == true {
			t.Fatalf("%s: %v", name, out)
		}
		data, _ := r["structuredContent"].(map[string]any)["data"].(map[string]any)
		return data
	}
	spec := `import { test, expect, step } from './chatqa';

test('đăng nhập', async ({ page }) => {
  await step('mở trang', async () => {
    await page.goto('/');
  });
  await step('đăng nhập', async () => {
    await page.getByLabel('Mật khẩu').fill(process.env.PASSWORD);
    await page.getByRole('button', { name: 'Đăng nhập' }).click();
    await expect(page.getByText('Xin chào')).toBeVisible();
  });
});
`
	save := func(id int, name, script string) map[string]any {
		data := call(id, "test_save_flow", map[string]any{"app": "demo", "name": name, "yaml": "", "script": script, "device_id": "web-mcp",
			"env": []any{}, "secrets": []string{"PASSWORD"}, "replace": false, "typing_frequency": 0, "wait_sec": 60})
		return data["cases"].([]any)[0].(map[string]any)
	}
	bad := strings.Replace(spec, "page.goto('/')", "page.goto(`/${process.env.PASSWORD}`)", 1)
	if c := save(1, "02_hong.spec.ts", bad); c["status"] != "invalid" || !strings.Contains(fmt.Sprint(c["error"]), "02_hong.spec.ts:5:") {
		t.Fatalf("script không an toàn: %v", c)
	}
	if c := save(2, "03_dang_nhap.spec.ts", spec); c["status"] != "saved" || c["runId"] == "" {
		t.Fatalf("script hợp lệ: %v", c)
	}
	out := call(3, "test_export_spec", map[string]any{"app": "demo", "name": "03_dang_nhap.spec.ts", "device_id": "web-mcp"})
	zr, err := zip.OpenReader(fmt.Sprint(out["path"]))
	if err != nil {
		t.Fatalf("test_export_spec: %v (%v)", err, out)
	}
	defer zr.Close()
	if len(zr.File) != 5 {
		t.Fatalf("zip có %d file", len(zr.File))
	}
}
