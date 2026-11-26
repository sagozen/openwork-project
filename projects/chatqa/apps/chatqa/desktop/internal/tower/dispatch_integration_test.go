//go:build pwintegration

package tower

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	goruntime "runtime"
	"strings"
	"testing"
	"time"

	"chatqa/internal/pw"
	"chatqa/internal/testengine"
	"chatqa/internal/tower/pool"
)

// Task trộn qua tower thật: YAML trên điện thoại giả (maestro mock) và spec trên hồ sơ trình duyệt thật (Node +
// Playwright + Chromium), count áp theo loại:
//
//	go test -tags pwintegration ./internal/tower/ -run MixedDispatch -count=1 -timeout 10m
//
// Bộ chạy: CQS_PW_DIR, hoặc cùng bố cục dựng bằng symlink như test tích hợp của testengine (node trong PATH,
// node_modules gốc của repo, thư mục trình duyệt của Playwright trên máy).
func linkedWebRuntime(t *testing.T) *pw.Runtime {
	t.Helper()
	if d := os.Getenv("CQS_PW_DIR"); d != "" {
		return &pw.Runtime{Dir: d}
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("không có node trong PATH")
	}
	modules := ""
	for dir, _ := os.Getwd(); ; dir = filepath.Dir(dir) {
		m := filepath.Join(dir, "node_modules")
		if b, err := os.ReadFile(filepath.Join(m, "playwright-core", "package.json")); err == nil {
			var p struct{ Version string }
			_ = json.Unmarshal(b, &p)
			if p.Version != pw.DefaultPins.Playwright {
				t.Skipf("playwright-core %s khác bản ghim", p.Version)
			}
			modules = m
			break
		}
		if filepath.Dir(dir) == dir {
			t.Skip("không tìm thấy node_modules có playwright-core")
		}
	}
	if goruntime.GOOS != "darwin" {
		t.Skip("bố cục symlink chỉ dựng trên macOS")
	}
	pins := pw.DefaultPins
	dir := t.TempDir()
	nodeDir, modDir := "node-"+pins.Node, "modules-"+pins.Playwright+"-"+pins.TypeScript
	for _, d := range []string{filepath.Join(dir, nodeDir, "bin"), filepath.Join(dir, modDir, "work")} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for link, target := range map[string]string{
		filepath.Join(dir, nodeDir, "bin", "node"): node,
		filepath.Join(dir, modDir, "node_modules"): modules,
		filepath.Join(dir, "browsers"):             filepath.Join(os.Getenv("HOME"), "Library", "Caches", "ms-playwright"),
	} {
		if err := os.Symlink(target, link); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(dir, "current.json"), []byte(fmt.Sprintf(`{"node":%q,"modules":%q}`, nodeDir, modDir)), 0o644); err != nil {
		t.Fatal(err)
	}
	return &pw.Runtime{Dir: dir}
}

const mixedSpec = `import { test, expect, step } from './chatqa';

test('trang chủ web', async ({ page }) => {
  await step('mở trang', async () => {
    await page.goto('/');
  });
  await step('thấy tiêu đề', async () => {
    await expect(page.getByRole('heading', { name: 'Trang chủ' })).toBeVisible();
  });
});
`

func TestMixedDispatchYAMLOnPhoneAndSpecOnRealBrowser(t *testing.T) {
	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `<!doctype html><meta charset=utf-8><h1>Trang chủ</h1>`)
	}))
	defer site.Close()
	rt := linkedWebRuntime(t)
	if err := rt.Ready("chromium", ""); err != nil {
		t.Skipf("bộ chạy chưa đủ: %v", err)
	}
	r := newRig(t)
	e := r.t.Engine
	sc := &pw.Sidecar{RT: rt, Log: t.Logf}
	sc.OnDown = r.t.WebDown
	e.Web = &testengine.Web{RT: rt, Sidecar: sc, Profile: r.t.Store.BrowserProfile}
	e.Pool.OpenWeb = e.OpenWeb
	r.t.Local.Profiles, r.t.Local.WebReady = r.t.Store, e.WebReady
	t.Cleanup(func() {
		e.Pool.CloseAll(3 * time.Second)
		_ = sc.Close()
	})
	ctx := context.Background()
	base := strings.Replace(site.URL, "127.0.0.1", "localhost", 1)
	for _, id := range []string{"web-a", "web-b"} {
		p := pw.Profile{ID: id, Name: id, Browser: "chromium", Width: 800, Height: 600, BaseURL: base, Headless: true}
		if _, err := r.t.SaveProfile(ctx, p); err != nil {
			t.Fatal(err)
		}
	}
	r.setFound(android("emu-1"), android("emu-2"))
	r.poll(t)
	if err := os.WriteFile(filepath.Join(r.dir, "flows", "demo", "home.spec.ts"), []byte(mixedSpec), 0o644); err != nil {
		t.Fatal(err)
	}
	devs, _ := r.t.Fleet(ctx)
	for _, d := range devs {
		if d.Platform == testengine.PlatformWeb && d.State != pool.Connected {
			t.Fatalf("hồ sơ trình duyệt chưa dùng được: %+v", d)
		}
	}
	task, err := r.t.Dispatch(ctx, actor, DispatchRequest{App: "demo", Flows: []string{"02_home.yaml", "home.spec.ts"}, Filter: DeviceFilter{Count: 1}})
	if err != nil {
		t.Fatal(err)
	}
	done, err := r.t.Wait(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	flows, _ := e.Metrics.FlowRuns(done.RunID)
	got := map[string]string{}
	for _, f := range flows {
		got[f.DeviceID] = fmt.Sprintf("%s@%s/%s passed=%v %s", f.Flow, f.Platform, f.Driver, f.Passed, f.Error)
	}
	if done.Status != TaskPassed || len(flows) != 2 || got["emu-1"] == "" || got["web-a"] == "" {
		t.Fatalf("task %s: count=1 mỗi loại phải chạy emu-1 và web-a: %v", done.Status, got)
	}
	if !strings.HasPrefix(got["web-a"], "home.spec.ts@web/playwright passed=true") {
		t.Fatalf("spec trên hồ sơ thật: %s", got["web-a"])
	}
	run, _ := e.Metrics.Run(done.RunID)
	for _, f := range []string{testengine.ReportHTMLFile, testengine.ReportSummaryFile} {
		if _, err := os.Stat(filepath.Join(run.OutDir, f)); err != nil {
			t.Errorf("thiếu %s: %v", f, err)
		}
	}
}
