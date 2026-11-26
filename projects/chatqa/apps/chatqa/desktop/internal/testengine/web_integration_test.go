//go:build pwintegration

package testengine

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	goruntime "runtime"
	"strings"
	"testing"
	"time"

	"chatqa/internal/pw"
)

// Thiết bị web với Node + Playwright + Chromium thật, qua đúng đường của app (Pool, Engine.OpenWeb, sidecar):
//
//	go test -tags pwintegration ./internal/testengine/ -run WebDevice -count=1
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

func TestWebDeviceRealSidecarReopensAfterCrash(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `<!doctype html><title>Đăng nhập</title><button onclick="this.textContent='OK'">Đăng nhập</button>`)
	}))
	defer srv.Close()
	u, _ := url.Parse(srv.URL)
	profile := pw.Profile{ID: "web-it", Name: "IT", Browser: "chromium", Width: 800, Height: 600, BaseURL: srv.URL,
		Headless: true, AllowedHosts: []string{u.Hostname()}}
	if err := profile.Validate(); err != nil {
		t.Fatal(err)
	}

	rt := realWebRuntime(t)
	if err := rt.Ready(profile.Browser, profile.Channel); err != nil {
		t.Skipf("bộ chạy chưa đủ: %v", err)
	}
	if n, err := rt.PIDs().Reap(); err != nil || n != 0 {
		t.Logf("reap: %d %v", n, err)
	}
	e, _ := newTestEngine(t)
	sc := &pw.Sidecar{RT: rt, Log: t.Logf}
	down := make(chan int, 2)
	sc.OnDown = func(gen int) { e.WebDown(gen); down <- gen }
	e.Web = &Web{RT: rt, Sidecar: sc, Profile: func(string) (pw.Profile, error) { return profile, nil }}
	e.Pool.OpenWeb = e.OpenWeb
	t.Cleanup(func() {
		e.Pool.CloseAll(3 * time.Second)
		_ = sc.Close()
	})
	dev := Device{ID: profile.ID, Platform: PlatformWeb, Driver: DriverPlaywright, Rev: profile.Fingerprint()}
	if err := e.EnsureRuntime(context.Background(), dev); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	start := time.Now()
	look := func() (shot []byte, tree string) {
		t.Helper()
		err := e.Pool.Run(ctx, dev, func(ctx context.Context, s Session) error {
			var err error
			if shot, err = s.Driver.Screenshot(); err != nil {
				return err
			}
			h, err := s.Driver.Hierarchy()
			tree = string(h)
			return err
		})
		if err != nil {
			t.Fatal(err)
		}
		return shot, tree
	}
	shot, _ := look()
	t.Logf("mở lạnh: %v", time.Since(start))
	if !bytes.HasPrefix(shot, []byte("\x89PNG")) {
		t.Fatalf("Screenshot không phải PNG (%d byte)", len(shot))
	}
	gen := sc.Gen()
	if err := sc.Call(ctx, gen, "navigate", map[string]any{"session": dev.ID, "url": "/"}, nil); err != nil {
		t.Fatalf("navigate: %v", err)
	}
	_, tree := look()
	if !strings.Contains(tree, "snapshotId: "+fmt.Sprint(gen)+"-") || !strings.Contains(tree, "Đăng nhập") || !strings.Contains(tree, "[ref=") {
		t.Fatalf("Hierarchy:\n%s", tree)
	}
	if err := e.Pool.Run(ctx, dev, func(ctx context.Context, s Session) error { return s.Driver.Tap(ctx, 0.05, 0.03) }); err != nil {
		t.Fatalf("tap: %v", err)
	}

	// Giết riêng tiến trình Node (sidecar sập): lần dùng sau mở lại trong suốt ở thế hệ mới.
	script := filepath.Join(rt.WorkDir(), "sidecar", "bootstrap.mjs")
	if out, err := exec.Command("pkill", "-KILL", "-f", script).CombinedOutput(); err != nil {
		t.Fatalf("pkill: %v %s", err, out)
	}
	select {
	case <-down:
	case <-time.After(10 * time.Second):
		t.Fatal("OnDown không chạy sau khi Node chết")
	}
	if h := func() string {
		for _, s := range e.Pool.States() {
			if s.Device.ID == dev.ID {
				return s.Health
			}
		}
		return ""
	}(); h != HealthCold {
		t.Fatalf("sau khi sidecar chết, driver web phải bị bỏ: %s", h)
	}
	shot, _ = look()
	if !bytes.HasPrefix(shot, []byte("\x89PNG")) || sc.Gen() != gen+1 {
		t.Fatalf("mở lại: gen %d (cũ %d), ảnh %d byte", sc.Gen(), gen, len(shot))
	}
}
