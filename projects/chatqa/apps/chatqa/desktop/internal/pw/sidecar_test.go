package pw

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"chatqa/internal/proc"
	"deskcore/apperr"
)

const fakeSidecarArg = "cqs-fake-sidecar"

// fakeSidecar: tiến trình giả nói cùng giao thức với sidecar.mjs. Dòng đầu phải là "start" (cổng
// bootstrap), sau đó mỗi lệnh xử lý trong goroutine riêng nên trả lời có thể về không theo thứ tự.
//
//	hello         {playwright, node}; mode "oldpw" trả phiên bản khác bản ghim
//	echo          trả lại params sau params.delayMs
//	env           {env: os.Environ()}
//	pid           {pid}
//	crash         thoát mã 1 ngay
//	fail          lỗi {code: params.code, message: params.message}
//	close         không bao giờ trả lời
//	closedEvent   gửi sự kiện closed cho params.session rồi trả {}
//	open          trả {}
func fakeSidecar(mode string) {
	in := bufio.NewReader(os.Stdin)
	if first, err := in.ReadString('\n'); err != nil || first != "start\n" {
		fmt.Fprintln(os.Stderr, "fake: thiếu dòng start")
		os.Exit(3)
	}
	var wmu sync.Mutex
	send := func(v any) {
		b, _ := json.Marshal(v)
		wmu.Lock()
		_, _ = os.Stdout.Write(append(b, '\n'))
		wmu.Unlock()
	}
	for {
		line, err := in.ReadBytes('\n')
		if err != nil {
			os.Exit(0) // stdin đóng: app đã đi
		}
		var req struct {
			ID     int64           `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
		}
		if json.Unmarshal(line, &req) != nil {
			continue
		}
		go func() {
			var p struct {
				DelayMs int    `json:"delayMs"`
				Code    string `json:"code"`
				Message string `json:"message"`
				Session string `json:"session"`
			}
			_ = json.Unmarshal(req.Params, &p)
			res := func(v any) { send(map[string]any{"id": req.ID, "result": v}) }
			switch req.Method {
			case "hello":
				v := DefaultPins.Playwright
				if mode == "oldpw" {
					v = "1.0.0"
				}
				res(map[string]string{"playwright": v, "node": "fake"})
			case "echo":
				time.Sleep(time.Duration(p.DelayMs) * time.Millisecond)
				res(req.Params)
			case "env":
				res(map[string]any{"env": os.Environ()})
			case "pid":
				res(map[string]int{"pid": os.Getpid()})
			case "crash":
				os.Exit(1)
			case "fail":
				send(map[string]any{"id": req.ID, "error": map[string]string{"code": p.Code, "message": p.Message}})
			case "close":
			case "closedEvent":
				send(map[string]string{"event": "closed", "session": p.Session})
				res(map[string]any{})
			case "open":
				res(map[string]any{})
			default:
				send(map[string]any{"id": req.ID, "error": map[string]string{"code": "invalid", "message": "?"}})
			}
		}()
	}
}

// newFake: Sidecar chạy tiến trình giả; starts đếm số lần mở tiến trình.
func newFake(t *testing.T, mode string) (*Sidecar, *atomic.Int32) {
	t.Helper()
	var starts atomic.Int32
	s := &Sidecar{
		RT:  &Runtime{Dir: t.TempDir()},
		Log: t.Logf,
		command: func() (*exec.Cmd, error) {
			starts.Add(1)
			return exec.Command(os.Args[0], fakeSidecarArg, mode), nil
		},
	}
	t.Cleanup(func() { _ = s.Close() })
	return s, &starts
}

func mustStart(t *testing.T, s *Sidecar) int {
	t.Helper()
	gen, err := s.Start(context.Background())
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	return gen
}

// crash làm tiến trình giả chết và chờ Sidecar ghi nhận.
func crash(t *testing.T, s *Sidecar, gen int) {
	t.Helper()
	s.mu.Lock()
	c := s.cur
	s.mu.Unlock()
	if err := s.Call(context.Background(), gen, "crash", nil, nil); !errors.Is(err, ErrSidecarDown) {
		t.Fatalf("crash: %v", err)
	}
	<-c.gone
}

func TestSidecarMultiplexesConcurrentCalls(t *testing.T) {
	s, _ := newFake(t, "")
	gen := mustStart(t, s)
	var wg sync.WaitGroup
	errs := make(chan error, 50)
	for i := range 50 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			in := map[string]int{"n": i, "delayMs": (i * 7) % 40}
			var out map[string]int
			if err := s.Call(context.Background(), gen, "echo", in, &out); err != nil {
				errs <- err
				return
			}
			if out["n"] != i {
				errs <- fmt.Errorf("lệnh %d nhận trả lời của %d", i, out["n"])
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Error(err)
	}
}

func TestSidecarErrorMapping(t *testing.T) {
	s, _ := newFake(t, "")
	gen := mustStart(t, s)
	cases := []struct {
		code, want string
		down       bool
	}{
		{"unknown_session", CodeSidecarFailed, true},
		{CodeStaleRef, CodeStaleRef, false},
		{CodeHostBlocked, CodeHostBlocked, false},
		{"invalid", "invalid", false},
		{"boom", CodeSidecarFailed, false},
	}
	for _, c := range cases {
		err := s.Call(context.Background(), gen, "fail", map[string]string{"code": c.code, "message": "chi tiết"}, nil)
		if apperr.CodeOf(err) != c.want || errors.Is(err, ErrSidecarDown) != c.down {
			t.Errorf("%s: %v (mã %q, down=%v)", c.code, err, apperr.CodeOf(err), errors.Is(err, ErrSidecarDown))
		}
	}
}

func TestSidecarCrashFailsPendingAndFiresOnDown(t *testing.T) {
	s, _ := newFake(t, "")
	down := make(chan int, 1)
	s.OnDown = func(gen int) { down <- gen }
	gen := mustStart(t, s)
	pending := make(chan error, 1)
	go func() { pending <- s.Call(context.Background(), gen, "echo", map[string]int{"delayMs": 10000}, nil) }()
	time.Sleep(100 * time.Millisecond)
	crash(t, s, gen)
	select {
	case err := <-pending:
		if !errors.Is(err, ErrSidecarDown) {
			t.Fatalf("lệnh đang chờ phải nhận ErrSidecarDown: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("lệnh đang chờ không được giải phóng khi tiến trình chết")
	}
	select {
	case g := <-down:
		if g != gen {
			t.Fatalf("OnDown(%d), muốn %d", g, gen)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("OnDown không chạy")
	}
	if s.Running() {
		t.Fatal("Running sau khi chết")
	}
}

func TestSidecarRestartBumpsGenAndOldGenerationIsDown(t *testing.T) {
	s, _ := newFake(t, "")
	g1 := mustStart(t, s)
	crash(t, s, g1)
	g2 := mustStart(t, s)
	if g2 != g1+1 || s.Gen() != g2 {
		t.Fatalf("thế hệ sau khi mở lại = %d (Gen %d), muốn %d", g2, s.Gen(), g1+1)
	}
	if err := s.Call(context.Background(), g1, "echo", nil, nil); !errors.Is(err, ErrSidecarDown) {
		t.Fatalf("lệnh thế hệ cũ phải là ErrSidecarDown: %v", err)
	}
	if err := s.Call(context.Background(), g2, "echo", nil, nil); err != nil {
		t.Fatal(err)
	}
	if g, _ := s.Start(context.Background()); g != g2 {
		t.Fatalf("Start khi đang chạy phải trả thế hệ hiện tại, được %d", g)
	}
}

func TestSidecarRestartCapAndResets(t *testing.T) {
	s, starts := newFake(t, "")
	gen := mustStart(t, s)
	for range maxRestarts {
		crash(t, s, gen)
		gen = mustStart(t, s)
	}
	crash(t, s, gen)
	_, err := s.Start(context.Background())
	if apperr.CodeOf(err) != CodeSidecarFailed {
		t.Fatalf("quá %d lần khởi động lại trong 1 phút phải là web_sidecar_failed: %v", maxRestarts, err)
	}
	if n := starts.Load(); n != maxRestarts+1 {
		t.Fatalf("đã mở %d tiến trình, muốn %d (không mở khi bị chặn)", n, maxRestarts+1)
	}

	// Sự kiện xoá bộ đếm: Prepare/cài bộ chạy thành công gọi ResetRestarts.
	s.ResetRestarts()
	gen = mustStart(t, s)

	// open thành công sau một phút sống cũng xoá bộ đếm.
	for range maxRestarts - 1 {
		crash(t, s, gen)
		gen = mustStart(t, s)
	}
	s.mu.Lock()
	s.cur.started = time.Now().Add(-2 * uptimeForReset)
	s.mu.Unlock()
	if err := s.Call(context.Background(), gen, "open", map[string]string{"session": "web-a"}, nil); err != nil {
		t.Fatal(err)
	}
	for range maxRestarts {
		crash(t, s, gen)
		gen = mustStart(t, s)
	}
}

func TestSidecarCloseCallBoundedAtOneSecond(t *testing.T) {
	s, _ := newFake(t, "")
	gen := mustStart(t, s)
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	start := time.Now()
	err := s.Call(ctx, gen, "close", map[string]string{"session": "web-a"}, nil)
	d := time.Since(start)
	if !errors.Is(err, context.DeadlineExceeded) || d < 900*time.Millisecond || d > 2*time.Second {
		t.Fatalf("close không trả lời phải hết hạn sau ~1 s: %v sau %v", err, d)
	}
	if err := s.Call(context.Background(), gen, "echo", nil, nil); err != nil {
		t.Fatalf("tiến trình vẫn phải dùng được: %v", err)
	}
}

func TestSidecarStaleGenerationCleanupDoesNotStartProcess(t *testing.T) {
	s, starts := newFake(t, "")
	err := s.Call(context.Background(), 1, "close", map[string]string{"session": "web-a"}, nil)
	if !errors.Is(err, ErrSidecarDown) {
		t.Fatalf("dọn phiên thế hệ cũ khi không có tiến trình: %v", err)
	}
	if starts.Load() != 0 || s.Gen() != 0 || s.Running() {
		t.Fatal("Call không được mở tiến trình")
	}
	gen := mustStart(t, s)
	if err := s.Call(context.Background(), gen+5, "close", nil, nil); !errors.Is(err, ErrSidecarDown) || starts.Load() != 1 {
		t.Fatalf("thế hệ lạ: %v, số lần mở %d", err, starts.Load())
	}
}

func TestSidecarEnvAllowlistAppKeysLast(t *testing.T) {
	t.Setenv("CHATQA_MCP_TOKEN", "tok")
	t.Setenv("CQS_VAR_PASS", "x")
	t.Setenv("MY_SECRET", "hunter2")
	t.Setenv("NODE_OPTIONS", "--require /tmp/evil.js")
	t.Setenv("HTTPS_PROXY", "http://evil.test")
	t.Setenv("PLAYWRIGHT_BROWSERS_PATH", "/evil")
	t.Setenv("CQS_SIDECAR_GEN", "99")
	t.Setenv("HOME", "/Users/cqs-home-test")
	s, _ := newFake(t, "")
	gen := mustStart(t, s)
	var out struct{ Env []string }
	if err := s.Call(context.Background(), gen, "env", nil, &out); err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(out.Env, "\n")
	for _, kv := range out.Env {
		k, v, _ := strings.Cut(kv, "=")
		for _, bad := range []string{"CHATQA_", "CQS_VAR_", "MY_SECRET", "NODE_OPTIONS", "HTTPS_PROXY", "PATH"} {
			if strings.HasPrefix(k, bad) {
				t.Errorf("môi trường của Node lọt %s", k)
			}
		}
		if v == "hunter2" || v == "/evil" || v == "99" {
			t.Errorf("môi trường của Node lọt giá trị của %s", k)
		}
	}
	if !strings.Contains(joined, "HOME=/Users/cqs-home-test") {
		t.Errorf("thiếu biến được phép HOME:\n%s", joined)
	}
	n := len(out.Env)
	if n < 2 || out.Env[n-2] != "PLAYWRIGHT_BROWSERS_PATH="+s.RT.BrowsersPath() || out.Env[n-1] != fmt.Sprintf("CQS_SIDECAR_GEN=%d", gen) {
		t.Fatalf("biến của app phải nằm cuối:\n%s", joined)
	}
}

func TestSidecarClosedEventMarksSessionUntilReopened(t *testing.T) {
	s, _ := newFake(t, "")
	gen := mustStart(t, s)
	if s.Closed(gen, "web-a") {
		t.Fatal("phiên chưa đóng")
	}
	if err := s.Call(context.Background(), gen, "closedEvent", map[string]string{"session": "web-a"}, nil); err != nil {
		t.Fatal(err)
	}
	if !s.Closed(gen, "web-a") || s.Closed(gen, "web-b") {
		t.Fatal("sự kiện closed phải đánh dấu đúng phiên")
	}
	if !s.Closed(gen-1, "web-b") {
		t.Fatal("phiên của thế hệ không chạy luôn coi như đã đóng")
	}
	if err := s.Call(context.Background(), gen, "open", map[string]string{"session": "web-a"}, nil); err != nil {
		t.Fatal(err)
	}
	if s.Closed(gen, "web-a") {
		t.Fatal("open thành công phải bỏ dấu đóng")
	}
}

func TestSidecarPlaywrightVersionMismatchIsRefused(t *testing.T) {
	s, _ := newFake(t, "oldpw")
	_, err := s.Start(context.Background())
	if apperr.CodeOf(err) != CodeSidecarFailed || !strings.Contains(err.Error(), "1.0.0") {
		t.Fatalf("phiên bản Playwright khác bản ghim: %v", err)
	}
	if s.Running() {
		t.Fatal("tiến trình sai phiên bản phải bị dừng")
	}
	waitPIDsEmpty(t, s.RT.PIDs().Path)
}

func TestSidecarRuntimeMissingIsNotAFailure(t *testing.T) {
	s := &Sidecar{RT: &Runtime{Dir: t.TempDir()}, Log: t.Logf}
	_, err := s.Start(context.Background())
	if apperr.CodeOf(err) != CodeRuntimeMissing {
		t.Fatalf("chưa cài bộ chạy phải là web_runtime_missing: %v", err)
	}
	if s.failed {
		t.Fatal("chưa cài không phải là tiến trình chết: không được tính vào giới hạn khởi động lại")
	}
}

func TestSidecarPIDFileRecordsAndReapKillsStaleProcess(t *testing.T) {
	s, _ := newFake(t, "")
	down := make(chan int, 1)
	s.OnDown = func(gen int) { down <- gen }
	gen := mustStart(t, s)
	var out struct{ PID int }
	if err := s.Call(context.Background(), gen, "pid", nil, &out); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(filepath.Join(s.RT.Dir, "pids.json"))
	if err != nil || !strings.Contains(string(b), fmt.Sprintf(`"pid":%d`, out.PID)) {
		t.Fatalf("pids.json phải ghi tiến trình đang sống: %s %v", b, err)
	}
	// Như lần khởi động sau một lần app sập: đối tượng mới, chỉ còn file.
	n, err := (&proc.PIDFile{Path: filepath.Join(s.RT.Dir, "pids.json")}).Reap()
	if err != nil || n != 1 {
		t.Fatalf("Reap = %d, %v", n, err)
	}
	select {
	case <-down:
	case <-time.After(5 * time.Second):
		t.Fatal("tiến trình mồ côi chưa bị giết")
	}
}

func TestSidecarCloseStopsProcessAndAllowsRestart(t *testing.T) {
	s, _ := newFake(t, "")
	down := make(chan int, 2)
	s.OnDown = func(gen int) { down <- gen }
	gen := mustStart(t, s)
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	if s.Running() {
		t.Fatal("Running sau Close")
	}
	if err := s.Call(context.Background(), gen, "echo", nil, nil); !errors.Is(err, ErrSidecarDown) {
		t.Fatalf("lệnh sau Close: %v", err)
	}
	select {
	case <-down:
	case <-time.After(3 * time.Second):
		t.Fatal("OnDown phải chạy cả khi Close chủ động")
	}
	if s.failed {
		t.Fatal("Close chủ động không phải là chết bất thường")
	}
	waitPIDsEmpty(t, s.RT.PIDs().Path)
	if g := mustStart(t, s); g != gen+1 {
		t.Fatalf("mở lại sau Close: thế hệ %d", g)
	}
}

func waitPIDsEmpty(t *testing.T, path string) {
	t.Helper()
	for deadline := time.Now().Add(3 * time.Second); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		b, err := os.ReadFile(path)
		if err == nil && strings.TrimSpace(string(b)) == "[]" {
			return
		}
	}
	b, _ := os.ReadFile(path)
	t.Fatalf("pids.json còn bản ghi: %s", b)
}

func TestInstallWritesScriptsOnlyWhenChanged(t *testing.T) {
	dir := t.TempDir()
	if err := Install(dir); err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{"bootstrap.mjs", "sidecar.mjs", "locator.mjs", "validate.mjs", "boxes.mjs", "guard.mjs"} {
		if _, err := os.Stat(filepath.Join(dir, f)); err != nil {
			t.Fatalf("thiếu %s: %v", f, err)
		}
	}
	if matches, _ := filepath.Glob(filepath.Join(dir, "*.test.mjs")); len(matches) != 0 {
		t.Fatalf("không được ghi file test: %v", matches)
	}
	p := filepath.Join(dir, "sidecar.mjs")
	old := time.Now().Add(-time.Hour)
	if err := os.Chtimes(p, old, old); err != nil {
		t.Fatal(err)
	}
	if err := Install(dir); err != nil {
		t.Fatal(err)
	}
	if st, _ := os.Stat(p); !st.ModTime().Equal(old) {
		t.Fatal("file không đổi nội dung thì không được ghi lại")
	}
	if err := os.WriteFile(p, []byte("cũ"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := Install(dir); err != nil {
		t.Fatal(err)
	}
	want, _ := scripts.ReadFile("js/sidecar.mjs")
	if got, _ := os.ReadFile(p); string(got) != string(want) {
		t.Fatal("file khác nội dung phải được ghi lại")
	}
}

func TestSidecarStderrIsScrubbedThenCapped(t *testing.T) {
	const secret = "S3cret-Pa55-xyz"
	var mu sync.Mutex
	var lines []string
	s := &Sidecar{
		Log: func(format string, args ...any) {
			mu.Lock()
			lines = append(lines, fmt.Sprintf(format, args...))
			mu.Unlock()
		},
		Scrub: func(line string) string { return strings.ReplaceAll(line, secret, "***") },
	}
	long := strings.Repeat("x", stderrLineMax-5) + secret + strings.Repeat("y", 100) // bí mật vắt qua chỗ cắt
	s.readStderr(1, strings.NewReader("Error: fill(\""+secret+"\") failed\n"+long+"\n"))
	if len(lines) != 2 {
		t.Fatalf("log = %q", lines)
	}
	for _, l := range lines {
		if strings.Contains(l, secret) || strings.Contains(l, secret[:5]) {
			t.Fatalf("log còn giá trị bí mật: %q", l)
		}
	}
	if !strings.Contains(lines[0], "***") || len(lines[1]) > stderrLineMax+len("sidecar[1]: …") {
		t.Fatalf("log = %q", lines)
	}
}
