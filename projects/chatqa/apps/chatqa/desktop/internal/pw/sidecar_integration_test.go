//go:build pwintegration

package pw

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	goruntime "runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"deskcore/apperr"
)

// Hợp đồng sidecar với Node + Playwright + trình duyệt thật:
//
//	go test -tags pwintegration ./internal/pw/ -run 'Sidecar|GuardSpike' -count=1 -timeout 15m
//
// Bộ chạy: CQS_PW_DIR trỏ tới một bộ chạy đã cài bằng Ensure thì dùng nguyên. Không thì test dựng cùng bố
// cục thư mục bằng symlink: node trong PATH, node_modules gốc của repo (package-lock.json ghim đúng
// Playwright/TypeScript của pins) và thư mục trình duyệt của Playwright trên máy (PLAYWRIGHT_BROWSERS_PATH
// hoặc thư mục mặc định). Đường mã chạy sidecar là đường thật của app, chỉ khác nơi các file nằm.
func integrationRuntime(t *testing.T) *Runtime {
	t.Helper()
	if d := os.Getenv("CQS_PW_DIR"); d != "" {
		r := &Runtime{Dir: d}
		if r.NodePath() == "" || r.ModulesDir() == "" {
			t.Fatalf("CQS_PW_DIR=%s chưa có bộ chạy đã cài", d)
		}
		return r
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("không có node trong PATH và không đặt CQS_PW_DIR")
	}
	modules := findRootModules(t)
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
	r := &Runtime{Dir: t.TempDir()}
	nodeBin := filepath.Join(r.Dir, r.nodeDirName(), filepath.FromSlash(r.nodeBin()))
	mod := filepath.Join(r.Dir, r.modulesDirName())
	for _, d := range []string{filepath.Dir(nodeBin), filepath.Join(mod, "work")} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for link, target := range map[string]string{
		nodeBin:                            node,
		filepath.Join(mod, "node_modules"): modules,
		r.BrowsersPath():                   browsers,
	} {
		if err := os.Symlink(target, link); err != nil {
			t.Fatal(err)
		}
	}
	if err := r.setPointer(func(p *pointer) { p.Node, p.Modules = r.nodeDirName(), r.modulesDirName() }); err != nil {
		t.Fatal(err)
	}
	return r
}

// findRootModules: node_modules gốc của repo có playwright-core đúng phiên bản ghim.
func findRootModules(t *testing.T) string {
	t.Helper()
	dir, _ := os.Getwd()
	for {
		m := filepath.Join(dir, "node_modules")
		b, err := os.ReadFile(filepath.Join(m, "playwright-core", "package.json"))
		if err == nil {
			var p struct{ Version string }
			_ = json.Unmarshal(b, &p)
			if p.Version != DefaultPins.Playwright {
				t.Skipf("playwright-core ở %s là %s, khác bản ghim %s", m, p.Version, DefaultPins.Playwright)
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

func browserPIDs(t *testing.T, parent int) []int {
	t.Helper()
	if goruntime.GOOS == "windows" {
		return nil
	}
	out, err := exec.Command("ps", "-A", "-o", "pid=,ppid=").Output()
	if err != nil {
		t.Fatal(err)
	}
	var pids []int
	for _, line := range strings.Split(string(out), "\n") {
		f := strings.Fields(line)
		if len(f) == 2 && f[1] == strconv.Itoa(parent) {
			pid, _ := strconv.Atoi(f[0])
			pids = append(pids, pid)
		}
	}
	return pids
}

func waitGone(t *testing.T, pids []int, within time.Duration) {
	t.Helper()
	deadline := time.Now().Add(within)
	for _, pid := range pids {
		for {
			if err := exec.Command("kill", "-0", strconv.Itoa(pid)).Run(); err != nil {
				break
			}
			if time.Now().After(deadline) {
				out, _ := exec.Command("ps", "-o", "pid,command", "-p", strconv.Itoa(pid)).CombinedOutput()
				t.Fatalf("tiến trình %d còn sống sau %v:\n%s", pid, within, out)
			}
			time.Sleep(50 * time.Millisecond)
		}
	}
}

func sidecarPID(s *Sidecar) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cur == nil {
		return 0
	}
	return s.cur.tree.PID()
}

type actResult struct {
	Locator    string   `json:"locator"`
	URL        string   `json:"url"`
	Snapshot   string   `json:"snapshot"`
	SnapshotID string   `json:"snapshotId"`
	Blocked    []string `json:"blocked"`
}

type snapResult struct {
	URL        string `json:"url"`
	Title      string `json:"title"`
	Text       string `json:"text"`
	SnapshotID string `json:"snapshotId"`
	Viewport   struct{ Width, Height int }
}

const loginPage = `<!doctype html><title>Đăng nhập</title>
<h1>Xin chào</h1>
<label>Email <input id="e"></label>
<button onclick="document.body.insertAdjacentHTML('beforeend','<p>đã bấm '+document.getElementById('e').value.length+'</p>')">Sign in</button>`

func TestSidecarIntegration(t *testing.T) {
	rt := integrationRuntime(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, loginPage)
	}))
	defer srv.Close()
	base := strings.Replace(srv.URL, "127.0.0.1", "localhost", 1)

	downs := make(chan int, 4)
	s := &Sidecar{RT: rt, Log: t.Logf, OnDown: func(g int) { downs <- g }}
	defer s.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	gen, err := s.Start(ctx) // gồm hello và so phiên bản Playwright với bản ghim
	if err != nil {
		t.Fatal(err)
	}
	profile := Profile{ID: "web-it", Name: "it", Browser: "chromium", Width: 1000, Height: 600, BaseURL: base, Headless: true}
	if err := profile.Validate(); err != nil {
		t.Fatal(err)
	}
	open := map[string]any{"session": profile.ID, "profile": profile}

	t0 := time.Now()
	if err := s.Call(ctx, gen, "open", open, nil); err != nil {
		t.Fatalf("open chromium headless (channel chromium): %v", err)
	}
	cold := time.Since(t0)
	t0 = time.Now()
	if err := s.Call(ctx, gen, "open", open, nil); err != nil {
		t.Fatal(err)
	}
	warm := time.Since(t0)
	t.Logf("thời gian open: lạnh %v, ấm (cùng phiên) %v", cold.Round(time.Millisecond), warm.Round(time.Millisecond))

	var nav actResult
	if err := s.Call(ctx, gen, "navigate", map[string]any{"session": profile.ID, "url": "/login"}, &nav); err != nil {
		t.Fatal(err)
	}
	idRe := regexp.MustCompile(`^` + strconv.Itoa(gen) + `-\d+$`)
	if !strings.HasSuffix(nav.URL, "/login") || !idRe.MatchString(nav.SnapshotID) {
		t.Fatalf("navigate: %+v", nav)
	}

	var snap snapResult
	if err := s.Call(ctx, gen, "snapshot", map[string]any{"session": profile.ID}, &snap); err != nil {
		t.Fatal(err)
	}
	if !idRe.MatchString(snap.SnapshotID) || snap.SnapshotID == nav.SnapshotID || snap.Title != "Đăng nhập" ||
		snap.Viewport.Width != 1000 || snap.Viewport.Height != 600 {
		t.Fatalf("snapshot: %+v", snap)
	}
	t.Logf("snapshot %s:\n%s", snap.SnapshotID, snap.Text)
	boxRe := regexp.MustCompile(`\[box=([^\]]+)\]`)
	boxes := boxRe.FindAllStringSubmatch(snap.Text, -1)
	if len(boxes) == 0 {
		t.Fatal("snapshot không có [box=]")
	}
	for _, m := range boxes {
		for _, v := range strings.Split(m[1], ",") {
			f, err := strconv.ParseFloat(v, 64)
			if err != nil || f < 0 || f > 1 {
				t.Fatalf("hộp chưa chuẩn hoá 0..1: %s", m[0])
			}
		}
	}
	refRe := regexp.MustCompile(`button "Sign in" \[ref=(\w+)\]`)
	m := refRe.FindStringSubmatch(snap.Text)
	if m == nil {
		t.Fatal("không thấy ref của nút Sign in")
	}
	btnRef := m[1]

	var filled actResult
	err = s.Call(ctx, gen, "fill", map[string]any{
		"session": profile.ID, "locator": "getByLabel('Email')", "text": "${USER_EMAIL}",
		"vars": map[string]string{"USER_EMAIL": "khach@example.com"},
	}, &filled)
	if err != nil {
		t.Fatal(err)
	}
	if filled.Locator != "getByRole('textbox', { name: 'Email' })" || strings.Contains(filled.Locator, "khach@") {
		t.Fatalf("locator sau fill: %q", filled.Locator)
	}
	// fill làm trang đổi snapshot: ref của snapshot trước đó đã cũ
	err = s.Call(ctx, gen, "click", map[string]any{"session": profile.ID, "ref": btnRef, "snapshotId": snap.SnapshotID}, nil)
	if apperr.CodeOf(err) != CodeStaleRef {
		t.Fatalf("ref của snapshot cũ phải là web_stale_ref: %v", err)
	}
	m = refRe.FindStringSubmatch(filled.Snapshot)
	if m == nil {
		t.Fatalf("snapshot sau fill thiếu nút:\n%s", filled.Snapshot)
	}
	var clicked actResult
	if err := s.Call(ctx, gen, "click", map[string]any{"session": profile.ID, "ref": m[1], "snapshotId": filled.SnapshotID}, &clicked); err != nil {
		t.Fatal(err)
	}
	if clicked.Locator != "getByRole('button', { name: 'Sign in' })" {
		t.Fatalf("locator chuẩn hoá của click theo ref: %q", clicked.Locator)
	}
	if !strings.Contains(clicked.Snapshot, "đã bấm 17") { // len("khach@example.com"): giá trị đã được thay vào ô
		t.Fatalf("click không có tác dụng hoặc giá trị biến chưa được thay:\n%s", clicked.Snapshot)
	}
	if err := s.Call(ctx, gen, "click", map[string]any{"session": profile.ID, "locator": "getByRole('button', { name: 'Sign in' })"}, nil); err != nil {
		t.Fatalf("click theo locator: %v", err)
	}

	var shot struct {
		Data          string
		Width, Height int
	}
	if err := s.Call(ctx, gen, "screenshot", map[string]any{"session": profile.ID, "format": "png"}, &shot); err != nil {
		t.Fatal(err)
	}
	raw, _ := base64.StdEncoding.DecodeString(shot.Data)
	img, err := png.Decode(bytes.NewReader(raw))
	if err != nil || img.Bounds().Dx() != 1000 || img.Bounds().Dy() != 600 || shot.Width != 1000 {
		t.Fatalf("screenshot: %v %v %dx%d", err, img.Bounds(), shot.Width, shot.Height)
	}

	var v struct {
		Errors  []struct{ Line int }
		EnvUsed []string
	}
	spec := "import { test, step } from './chatqa';\ntest('t', async ({ page }) => {\n  await step('a', async () => {\n    await page.evaluate(() => 1);\n  });\n});\n"
	if err := s.Call(ctx, gen, "validateSpec", map[string]any{"source": spec, "envNames": []string{}, "allowedHosts": []string{"localhost"}}, &v); err != nil {
		t.Fatal(err)
	}
	if len(v.Errors) != 1 || v.Errors[0].Line != 4 {
		t.Fatalf("validateSpec qua sidecar: %+v", v)
	}

	// Sidecar bị giết đột ngột: phiên cũ là ErrSidecarDown, snapshotId cũ không khớp snapshot của thế hệ mới.
	nodePID := sidecarPID(s)
	browsers := browserPIDs(t, nodePID)
	p, _ := os.FindProcess(nodePID)
	if err := p.Kill(); err != nil {
		t.Fatal(err)
	}
	select {
	case g := <-downs:
		if g != gen {
			t.Fatalf("OnDown(%d)", g)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("OnDown không chạy sau khi sidecar bị giết")
	}
	waitGone(t, browsers, 10*time.Second) // trình duyệt tự thoát khi ống điều khiển đứt
	if err := s.Call(ctx, gen, "snapshot", map[string]any{"session": profile.ID}, nil); !errors.Is(err, ErrSidecarDown) {
		t.Fatalf("phiên của thế hệ đã chết: %v", err)
	}
	gen2, err := s.Start(ctx)
	if err != nil || gen2 != gen+1 {
		t.Fatalf("mở lại: %d %v", gen2, err)
	}
	t0 = time.Now()
	if err := s.Call(ctx, gen2, "open", open, nil); err != nil {
		t.Fatal(err)
	}
	t.Logf("thời gian open sau khi mở lại sidecar: %v", time.Since(t0).Round(time.Millisecond))
	if err := s.Call(ctx, gen2, "navigate", map[string]any{"session": profile.ID, "url": "/login"}, &nav); err != nil {
		t.Fatal(err)
	}
	err = s.Call(ctx, gen2, "click", map[string]any{"session": profile.ID, "ref": btnRef, "snapshotId": snap.SnapshotID}, nil)
	if apperr.CodeOf(err) != CodeStaleRef {
		t.Fatalf("snapshotId của thế hệ trước phải là web_stale_ref: %v", err)
	}
	if err := s.Call(ctx, gen2, "close", map[string]any{"session": profile.ID}, nil); err != nil {
		t.Fatal(err)
	}

	nodePID = sidecarPID(s)
	if err := s.Call(ctx, gen2, "open", open, nil); err != nil {
		t.Fatal(err)
	}
	browsers = browserPIDs(t, nodePID)
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	waitGone(t, append(browsers, nodePID), 5*time.Second)
	if b, _ := os.ReadFile(rt.PIDs().Path); strings.TrimSpace(string(b)) != "[]" {
		t.Fatalf("pids.json sau Close: %s", b)
	}
}
