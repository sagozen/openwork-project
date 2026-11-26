package testengine

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"net/url"
	"os"
	"path/filepath"
	goruntime "runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"chatqa/internal/pw"
	"deskcore/apperr"
)

const fakeWebSidecarArg = "cqs-fake-web-sidecar"

// Tiến trình phụ: binary test chạy lại làm sidecar giả (fakeWebSidecar), được gọi qua script node giả.
func TestMain(m *testing.M) {
	if len(os.Args) > 2 && os.Args[1] == fakeWebSidecarArg {
		fakeWebSidecar(os.Args[2])
		return
	}
	os.Exit(m.Run())
}

// fakeWebSidecar nói cùng giao thức NDJSON với sidecar.mjs và ghi "method session" của mỗi lệnh vào logPath.
// exit làm tiến trình chết ngay (sidecar sập).
func fakeWebSidecar(logPath string) {
	in := bufio.NewReader(os.Stdin)
	if first, err := in.ReadString('\n'); err != nil || first != "start\n" {
		os.Exit(3)
	}
	var mu sync.Mutex
	logf, _ := os.OpenFile(logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	snap := 0
	for {
		line, err := in.ReadBytes('\n')
		if err != nil {
			os.Exit(0)
		}
		var req struct {
			ID     int64  `json:"id"`
			Method string `json:"method"`
			Params struct {
				Session string `json:"session"`
			} `json:"params"`
		}
		if json.Unmarshal(line, &req) != nil {
			continue
		}
		mu.Lock()
		fmt.Fprintf(logf, "%s %s\n", req.Method, req.Params.Session)
		mu.Unlock()
		var res any = map[string]any{}
		switch req.Method {
		case "hello":
			res = map[string]string{"playwright": pw.DefaultPins.Playwright, "node": "fake"}
		case "exit":
			os.Exit(1)
		case "screenshot":
			res = map[string]any{"data": base64.StdEncoding.EncodeToString(onePixelPNG()), "width": 1, "height": 1}
		case "snapshot":
			snap++
			res = map[string]any{"url": "http://app.test/login", "title": "Đăng nhập", "viewport": map[string]int{"width": 1280, "height": 800},
				"text": "- button \"Đăng nhập\" [ref=e1] [box=0.1,0.2,0.3,0.05]", "snapshotId": fmt.Sprintf("%s-%d", os.Getenv("CQS_SIDECAR_GEN"), snap)}
		default: // thao tác theo phần tử (web_driver_test.go)
			res = fakeWebAct(req.Method, line, &snap)
		}
		b, _ := json.Marshal(fakeReply(req.ID, res))
		os.Stdout.Write(append(b, '\n'))
	}
}

func onePixelPNG() []byte {
	img := image.NewRGBA(image.Rect(0, 0, 1, 1))
	img.Set(0, 0, color.White)
	var buf bytes.Buffer
	_ = png.Encode(&buf, img)
	return buf.Bytes()
}

// fakeWebRuntime dựng bố cục bộ chạy đã cài (darwin/arm64, chromium) trong thư mục tạm, với node là script gọi
// sidecar giả. Trả bộ chạy và hàm đọc nhật ký lệnh của sidecar giả.
func fakeWebRuntime(t *testing.T) (*pw.Runtime, func() []string) {
	t.Helper()
	if goruntime.GOOS == "windows" {
		t.Skip("node giả là script sh")
	}
	dir := t.TempDir()
	pins := pw.DefaultPins
	nodeDir, modDir := "node-"+pins.Node, "modules-"+pins.Playwright+"-"+pins.TypeScript
	logPath := filepath.Join(dir, "calls.log")
	files := map[string]string{
		filepath.Join(nodeDir, "bin", "node"):                                                           fmt.Sprintf("#!/bin/sh\nexec %q %s %q\n", os.Args[0], fakeWebSidecarArg, logPath),
		filepath.Join(modDir, "node_modules", "playwright-core", "package.json"):                        "{}",
		filepath.Join(modDir, "node_modules", "@playwright", "test", "cli.js"):                          "",
		filepath.Join(modDir, "node_modules", "typescript", "package.json"):                             "{}",
		filepath.Join("browsers", pins.Artifacts["darwin/arm64/chromium"].Dir, "INSTALLATION_COMPLETE"): "",
		"current.json": fmt.Sprintf(`{"node":%q,"modules":%q}`, nodeDir, modDir),
	}
	for name, body := range files {
		p := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.MkdirAll(filepath.Join(dir, modDir, "work"), 0o755); err != nil {
		t.Fatal(err)
	}
	calls := func() []string { // "method session" của mỗi lệnh, bỏ hello
		b, _ := os.ReadFile(logPath)
		var out []string
		for _, l := range strings.Split(string(b), "\n") {
			if l = strings.TrimSpace(l); l != "" && !strings.HasPrefix(l, "hello") {
				out = append(out, l)
			}
		}
		return out
	}
	return &pw.Runtime{Dir: dir, Platform: "darwin/arm64"}, calls
}

var testProfiles = map[string]pw.Profile{
	"web-a":  {ID: "web-a", Name: "A", Browser: "chromium", Width: 1280, Height: 800, BaseURL: "http://app.test", Headless: true},
	"web-ff": {ID: "web-ff", Name: "FF", Browser: "firefox", Width: 1280, Height: 800, BaseURL: "http://app.test", Headless: true},
}

// newWebEngine: engine có thiết bị điện thoại giả và bộ chạy trình duyệt nối sidecar giả. down nhận thế hệ mỗi
// khi sidecar thoát (sau khi WebDown đã chạy).
func newWebEngine(t *testing.T) (e *Engine, sc *pw.Sidecar, calls func() []string, down chan int) {
	t.Helper()
	rt, calls := fakeWebRuntime(t)
	e, _ = newTestEngine(t)
	sc = &pw.Sidecar{RT: rt, Log: t.Logf}
	down = make(chan int, 4)
	sc.OnDown = func(gen int) { e.WebDown(gen); down <- gen }
	e.Web = &Web{RT: rt, Sidecar: sc, Profile: func(id string) (pw.Profile, error) {
		p, ok := testProfiles[id]
		if !ok {
			return pw.Profile{}, apperr.New(apperr.CodeNotFound, id)
		}
		return p, nil
	}}
	e.Pool.OpenWeb = e.OpenWeb
	t.Cleanup(func() { _ = sc.Close() })
	return e, sc, calls, down
}

func killSidecar(t *testing.T, sc *pw.Sidecar, down chan int) int {
	t.Helper()
	gen := sc.Gen()
	if err := sc.Call(context.Background(), gen, "exit", nil, nil); !errors.Is(err, pw.ErrSidecarDown) {
		t.Fatalf("exit: %v", err)
	}
	select {
	case g := <-down:
		return g
	case <-time.After(5 * time.Second):
		t.Fatal("OnDown không chạy")
	}
	return 0
}

func TestValidateDeviceAcceptsWebOnlyWithPlaywright(t *testing.T) {
	if err := ValidateDevice(webA); err != nil {
		t.Fatal(err)
	}
	if err := ValidateDevice(Device{ID: "web-a", Platform: PlatformWeb, Driver: "devicelab"}); apperr.CodeOf(err) != apperr.CodeInvalid {
		t.Fatalf("web + devicelab: %v", err)
	}
	if err := (&Preflight{}).Check(context.Background(), webA); err != nil {
		t.Fatalf("Preflight web: %v", err)
	}
}

func TestEnsureRuntimeWebNeverDownloads(t *testing.T) {
	e := &Engine{Home: &Home{Dir: t.TempDir()}}
	if err := e.EnsureRuntime(context.Background(), webA); apperr.CodeOf(err) != pw.CodeRuntimeMissing {
		t.Fatalf("không có Web: %v", err)
	}
	e.Web = &Web{RT: &pw.Runtime{Dir: t.TempDir()}, Profile: func(string) (pw.Profile, error) { return testProfiles["web-a"], nil }}
	if err := e.EnsureRuntime(context.Background(), webA); apperr.CodeOf(err) != pw.CodeRuntimeMissing {
		t.Fatalf("chưa cài bộ chạy: %v", err)
	}
	if entries, _ := os.ReadDir(e.Web.RT.Dir); len(entries) != 0 {
		t.Fatal("EnsureRuntime web không được tải hay ghi gì")
	}
}

func TestWebDeviceWarmDriverReuseAndRevReopen(t *testing.T) {
	e, sc, calls, _ := newWebEngine(t)
	dev := Device{ID: "web-a", Platform: PlatformWeb, Driver: DriverPlaywright, Rev: "r1"}
	if err := e.EnsureRuntime(context.Background(), dev); err != nil {
		t.Fatalf("EnsureRuntime: %v", err)
	}
	var tree string
	for range 2 {
		err := e.Pool.Run(context.Background(), dev, func(_ context.Context, s Session) error {
			shot, err := s.Driver.Screenshot()
			if err != nil || !bytes.HasPrefix(shot, []byte("\x89PNG")) {
				return fmt.Errorf("screenshot = %d byte, %v", len(shot), err)
			}
			h, err := s.Driver.Hierarchy()
			tree = string(h)
			return err
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	if want := fmt.Sprintf("snapshotId: %d-", sc.Gen()); !strings.Contains(tree, want) || !strings.Contains(tree, "[ref=e1]") {
		t.Fatalf("Hierarchy thiếu dòng đầu hoặc ref:\n%s", tree)
	}
	if n := countCalls(calls(), "open web-a"); n != 1 {
		t.Fatalf("driver ấm phải dùng lại: open %d lần (%v)", n, calls())
	}

	dev.Rev = "r2" // hồ sơ vừa sửa
	if err := e.Pool.Run(context.Background(), dev, noop); err != nil {
		t.Fatal(err)
	}
	got := calls()
	if countCalls(got, "open web-a") != 2 || countCalls(got, "close web-a") != 1 || indexOf(got, "close web-a") > lastIndexOf(got, "open web-a") {
		t.Fatalf("đổi Rev phải đóng phiên cũ rồi mở lại: %v", got)
	}
}

func TestWebDownDiscardsWebEntriesAndKeepsMobile(t *testing.T) {
	e, sc, calls, down := newWebEngine(t)
	for _, d := range []Device{webA, android1} {
		if err := e.Pool.Run(context.Background(), d, noop); err != nil {
			t.Fatal(err)
		}
	}
	old := killSidecar(t, sc, down)
	if h := health(e.Pool, webA.ID); h != HealthCold {
		t.Fatalf("web sau khi sidecar chết: %s", h)
	}
	if h := health(e.Pool, android1.ID); h != HealthWarm {
		t.Fatalf("android không được đụng: %s", h)
	}
	if err := e.Pool.Run(context.Background(), webA, noop); err != nil {
		t.Fatalf("mở lại sau khi sidecar chết: %v", err)
	}
	if sc.Gen() != old+1 || countCalls(calls(), "close web-a") != 0 || countCalls(calls(), "open web-a") != 2 {
		t.Fatalf("gen=%d (cũ %d), calls=%v", sc.Gen(), old, calls())
	}
}

func TestStaleGenerationDriverMakesNoRPC(t *testing.T) {
	e, sc, calls, down := newWebEngine(t)
	drv, cleanup, err := e.OpenWeb(context.Background(), webA)
	if err != nil {
		t.Fatal(err)
	}
	gen := killSidecar(t, sc, down)
	before := len(calls())
	cleanup()
	if _, err := drv.Screenshot(); !errors.Is(err, ErrDriverBroken) || apperr.CodeOf(err) != pw.CodeSidecarFailed {
		t.Fatalf("driver thế hệ cũ: %v", err)
	}
	if err := drv.Tap(context.Background(), 0.5, 0.5); !errors.Is(err, ErrDriverBroken) {
		t.Fatalf("tap thế hệ cũ: %v", err)
	}
	if sc.Gen() != gen || sc.Running() {
		t.Fatal("lệnh của phiên cũ không được mở lại sidecar")
	}
	if len(calls()) != before {
		t.Fatalf("phiên cũ vẫn gửi lệnh: %v", calls()[before:])
	}
}

func TestHandBackWebEndsHoldOnWebDevicesOnly(t *testing.T) {
	e, _ := newTestEngine(t)
	e.Pool.OpenWeb = func(context.Context, Device) (DeviceDriver, func(), error) { return webStub{}, nil, nil }
	for _, d := range []Device{webA, android1} {
		if _, err := e.TakeOver(context.Background(), d, 2*time.Second); err != nil {
			t.Fatal(err)
		}
	}
	ids := e.WebDown(1)
	if len(ids) != 1 || ids[0] != webA.ID {
		t.Fatalf("WebDown trả %v", ids)
	}
	if s := e.HoldState(webA.ID); s != HoldNone {
		t.Fatalf("web vẫn bị giữ: %q", s)
	}
	if s := e.HoldState(android1.ID); s != HoldIdle {
		t.Fatalf("android phải vẫn bị giữ: %q", s)
	}
	if e.WebBusy() {
		t.Fatal("máy web đã trả mà vẫn bận")
	}
	e.HandBack(android1.ID)
}

func TestBeginWebInstallRefusedDuringWebRunAndWhileInstalling(t *testing.T) {
	e, _ := newTestEngine(t)
	e.Web = &Web{RT: &pw.Runtime{Dir: t.TempDir()}}
	e.Pool.OpenWeb = func(context.Context, Device) (DeviceDriver, func(), error) { return webStub{}, nil, nil }
	hold, started := make(chan struct{}), make(chan struct{})
	go e.Pool.Run(context.Background(), webA, func(context.Context, Session) error { close(started); <-hold; return nil })
	<-started
	if _, err := e.BeginWebInstall(); apperr.CodeOf(err) != CodeDeviceNotReady {
		t.Fatalf("đang chạy web: %v", err)
	}
	close(hold)
	deadline := time.Now().Add(2 * time.Second)
	for e.WebBusy() && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	done, err := e.BeginWebInstall()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.BeginWebInstall(); apperr.CodeOf(err) != CodeDeviceNotReady {
		t.Fatalf("hai lượt cài cùng lúc: %v", err)
	}
	done()
	if done, err := e.BeginWebInstall(); err != nil {
		t.Fatalf("sau khi cài xong: %v", err)
	} else {
		done()
	}
}

func TestOpenWebRefusedWhileInstalling(t *testing.T) {
	e, sc, calls, _ := newWebEngine(t)
	done, err := e.BeginWebInstall()
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := e.OpenWeb(context.Background(), webA); apperr.CodeOf(err) != CodeDeviceNotReady {
		t.Fatalf("mở phiên khi đang cài: %v", err)
	}
	if sc.Running() || countCalls(calls(), "open web-a") != 0 {
		t.Fatal("đang cài thì không được mở sidecar hay phiên")
	}
	done()
	_, cleanup, err := e.OpenWeb(context.Background(), webA)
	if err != nil {
		t.Fatalf("sau khi cài xong: %v", err)
	}
	cleanup()
}

func TestRequireSecretSafeOnlyChromiumFamily(t *testing.T) {
	e := &Engine{Web: &Web{RT: &pw.Runtime{}, Profile: func(id string) (pw.Profile, error) { return testProfiles[id], nil }}}
	if err := e.RequireSecretSafe(Device{ID: "web-a", Platform: PlatformWeb, Driver: DriverPlaywright}); err != nil {
		t.Fatalf("chromium: %v", err)
	}
	if err := e.RequireSecretSafe(Device{ID: "web-ff", Platform: PlatformWeb, Driver: DriverPlaywright}); apperr.CodeOf(err) != apperr.CodeInvalid {
		t.Fatalf("firefox: %v", err)
	}
	if err := e.RequireSecretSafe(android1); err != nil {
		t.Fatalf("điện thoại: %v", err)
	}
}

func TestRedactCoversURLEncodedSecret(t *testing.T) {
	secret := "p@ss w/rd&x=1"
	page := "http://app.test/cb?token=" + url.QueryEscape(secret) + "&next=/a/" + url.PathEscape(secret)
	lower := "http://app.test/cb?token=" + lowerPercent(url.QueryEscape(secret))
	for _, s := range []string{page, lower} {
		if got := redact(s, []string{secret}); strings.Contains(got, url.QueryEscape(secret)) || strings.Contains(got, url.PathEscape(secret)) ||
			strings.Contains(strings.ToLower(got), strings.ToLower(url.QueryEscape(secret))) {
			t.Fatalf("redact bỏ sót dạng mã hoá URL: %s", got)
		}
	}
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "steps.json"), []byte(`{"url":"`+page+`","u2":"`+lower+`"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if n, err := redactDir(dir, []string{secret}); err != nil || n < 3 {
		t.Fatalf("redactDir = %d, %v", n, err)
	}
	b, _ := os.ReadFile(filepath.Join(dir, "steps.json"))
	for _, v := range []string{secret, url.QueryEscape(secret), url.PathEscape(secret), lowerPercent(url.QueryEscape(secret))} {
		if strings.Contains(string(b), v) {
			t.Fatalf("redactDir bỏ sót %q: %s", v, b)
		}
	}
}

func countCalls(calls []string, want string) int {
	n := 0
	for _, c := range calls {
		if c == want {
			n++
		}
	}
	return n
}

func indexOf(xs []string, v string) int {
	for i, x := range xs {
		if x == v {
			return i
		}
	}
	return -1
}

func lastIndexOf(xs []string, v string) int {
	for i := len(xs) - 1; i >= 0; i-- {
		if xs[i] == v {
			return i
		}
	}
	return -1
}
