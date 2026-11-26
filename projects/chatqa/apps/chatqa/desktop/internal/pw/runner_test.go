//go:build !windows

package pw

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"deskcore/apperr"
)

// fakeNode: node giả là script sh, chạy đúng giao thức của bootstrap (chờ dòng start, giữ stdin) và làm theo
// CQS_VAR_FAKE_MODE (đi qua đúng đường biến người dùng của bộ chạy):
//
//	report: chép CQS_VAR_FAKE_REPORT vào report.ndjson rồi chờ stdin đóng (như bootstrap khi Playwright xong)
//	crash:  ghi nửa báo cáo rồi thoát 1, không có end
//	hang:   mở một tiến trình con cùng nhóm và một tiến trình ở nhóm riêng (như trình duyệt), rồi treo
const fakeNode = `#!/bin/sh
read line
[ "$line" = start ] || exit 3
env > env.txt
ls > files.txt
case "$CQS_VAR_FAKE_MODE" in
report) cat "$CQS_VAR_FAKE_REPORT" > report.ndjson; cat > /dev/null; exit 0 ;;
crash) printf '{"type":"begin","total":1}\n{"type":"step","depth":0,"title":"a"}\n' > report.ndjson; echo "node: lỗi nạp" >&2; exit 1 ;;
hang)
  sleep 60 & echo $! > child.pid
  perl -e 'setpgrp(0,0); open(F,">browser.pid"); print F $$; close F; sleep 60' &
  sleep 60 ;;
esac
`

// fakeRunnerRuntime dựng bố cục bộ chạy đã cài với node giả.
func fakeRunnerRuntime(t *testing.T) *Runtime {
	t.Helper()
	dir := t.TempDir()
	pins := DefaultPins
	nodeDir, modDir := "node-"+pins.Node, "modules-"+pins.Playwright+"-"+pins.TypeScript
	for name, body := range map[string]string{
		filepath.Join(nodeDir, "bin", "node"):                                  fakeNode,
		filepath.Join(modDir, "node_modules", "@playwright", "test", "cli.js"): "",
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
	return &Runtime{Dir: dir}
}

func testJob(rt *Runtime, name string, vars map[string]string) Job {
	p := baseProfile()
	p.BaseURL = "http://app.test"
	return Job{Dir: filepath.Join(RunsDir(rt), "run1", "web-a", name), Spec: []byte("// spec"), Profile: p, Vars: vars,
		LiveDir: filepath.Join(RunsDir(rt), "run1", "web-a", "live"), StepShots: ShotsAlways, Timeout: time.Minute}
}

func TestRunnerStreamsReportAndExitsAfterEnd(t *testing.T) {
	t.Setenv("NODE_OPTIONS", "--require /evil.js")
	t.Setenv("HTTPS_PROXY", "http://attacker:8080")
	rt := fakeRunnerRuntime(t)
	canned := filepath.Join(t.TempDir(), "canned.ndjson")
	if err := os.WriteFile(canned, []byte(cannedReport), 0o600); err != nil {
		t.Fatal(err)
	}
	j := testJob(rt, "01-login", map[string]string{"FAKE_MODE": "report", "FAKE_REPORT": canned, "PASSWORD": "s3cret", "NODE_OPTIONS": "--x"})
	var types []string
	start := time.Now()
	res, err := (&Runner{RT: rt, Log: t.Logf}).Run(context.Background(), j, func(e Event) { types = append(types, e.Type) })
	if err != nil {
		t.Fatal(err)
	}
	if !res.Ended || res.Status != "failed" || res.Killed || res.TimedOut {
		t.Fatalf("kết cục = %+v", res)
	}
	if got := strings.Join(types, ","); got != "begin,step,step,test,end" {
		t.Fatalf("sự kiện = %s", got)
	}
	if d := time.Since(start); d > 4*time.Second {
		t.Fatalf("sau end phải đóng stdin để tiến trình thoát ngay, mất %v", d)
	}
	env, _ := os.ReadFile(filepath.Join(j.Dir, "env.txt"))
	for _, want := range []string{"CQS_VAR_PASSWORD=s3cret", "CQS_VAR_FAKE_MODE=report", `CQS_ALLOWED_HOSTS=["api.example.com","*.cdn.example.com","app.test"]`,
		"CQS_LIVE_DIR=" + j.LiveDir, "CQS_STEP_SHOTS=always", "PLAYWRIGHT_BROWSERS_PATH=" + rt.BrowsersPath()} {
		if !strings.Contains(string(env), want+"\n") {
			t.Errorf("thiếu %s trong môi trường:\n%s", want, env)
		}
	}
	for _, bad := range []string{"\nPASSWORD=", "NODE_OPTIONS=", "HTTPS_PROXY=", "CQS_VAR_NODE_OPTIONS="} {
		if strings.Contains("\n"+string(env), bad) {
			t.Errorf("môi trường không được có %s:\n%s", bad, env)
		}
	}
	files, _ := os.ReadFile(filepath.Join(j.Dir, "files.txt"))
	for _, f := range []string{"bootstrap.mjs", "chatqa.ts", "flow.spec.ts", "guard.mjs", "package.json", "playwright.config.mjs", "reporter.mjs"} {
		if !strings.Contains(string(files), f+"\n") {
			t.Errorf("thư mục lượt thiếu %s: %s", f, files)
		}
	}
	if b, _ := os.ReadFile(filepath.Join(rt.Dir, "pids.json")); strings.TrimSpace(string(b)) != "[]" {
		t.Errorf("pids.json còn tiến trình sau khi lượt xong: %s", b)
	}
}

func TestRunnerCrashWithoutEndKeepsLog(t *testing.T) {
	rt := fakeRunnerRuntime(t)
	var n int
	res, err := (&Runner{RT: rt, Log: t.Logf}).Run(context.Background(), testJob(rt, "01-x", map[string]string{"FAKE_MODE": "crash"}),
		func(Event) { n++ })
	if err != nil {
		t.Fatal(err)
	}
	if res.Ended || n != 2 || !strings.Contains(res.Log, "lỗi nạp") {
		t.Fatalf("kết cục = %+v, sự kiện %d", res, n)
	}
}

func alive(pid int) bool { return syscall.Kill(pid, 0) == nil }

func readPID(t *testing.T, path string) int {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if b, err := os.ReadFile(path); err == nil {
			if pid, err := strconv.Atoi(strings.TrimSpace(string(b))); err == nil {
				return pid
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("không thấy %s", path)
	return 0
}

// Huỷ giữa lượt: KillTree tường minh dừng cả nhóm, và tiến trình ở nhóm riêng (như trình duyệt Playwright mở) cũng bị
// dọn nhờ danh sách tiến trình con đã ghi. Không có gì sống sót.
func TestRunnerCancelKillsWholeTreeIncludingOwnGroupChild(t *testing.T) {
	rt := fakeRunnerRuntime(t)
	j := testJob(rt, "01-hang", map[string]string{"FAKE_MODE": "hang"})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan Result, 1)
	go func() {
		res, err := (&Runner{RT: rt, Log: t.Logf}).Run(ctx, j, nil)
		if err != nil {
			t.Error(err)
		}
		done <- res
	}()
	child, browser := readPID(t, filepath.Join(j.Dir, "child.pid")), readPID(t, filepath.Join(j.Dir, "browser.pid"))
	time.Sleep(2 * trackEvery) // để bộ ghi tiến trình con thấy cả hai
	start := time.Now()
	cancel()
	var res Result
	select {
	case res = <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("huỷ không dừng được lượt chạy")
	}
	if d := time.Since(start); d > 3*time.Second {
		t.Errorf("huỷ mất %v", d)
	}
	if !res.Killed {
		t.Errorf("kết cục = %+v", res)
	}
	time.Sleep(200 * time.Millisecond)
	for name, pid := range map[string]int{"tiến trình con cùng nhóm": child, "tiến trình nhóm riêng": browser} {
		if alive(pid) {
			_ = syscall.Kill(pid, syscall.SIGKILL)
			t.Errorf("%s %d còn sống sau khi huỷ", name, pid)
		}
	}
}

func TestRunnerRefusesDirOutsideRunsAndMissingRuntime(t *testing.T) {
	rt := fakeRunnerRuntime(t)
	j := testJob(rt, "x", nil)
	j.Dir = filepath.Join(t.TempDir(), "elsewhere")
	if _, err := (&Runner{RT: rt}).Run(context.Background(), j, nil); apperr.CodeOf(err) != apperr.CodeInvalid {
		t.Fatalf("thư mục ngoài runs: %v", err)
	}
	empty := &Runtime{Dir: t.TempDir()}
	if _, err := (&Runner{RT: empty}).Run(context.Background(), testJob(empty, "x", nil), nil); apperr.CodeOf(err) != CodeRuntimeMissing {
		t.Fatalf("chưa cài: %v", err)
	}
}

func TestRunnerSweepsStaleRunDirs(t *testing.T) {
	rt := fakeRunnerRuntime(t)
	old := filepath.Join(RunsDir(rt), "old-run")
	fresh := filepath.Join(RunsDir(rt), "fresh-run")
	long := filepath.Join(RunsDir(rt), "long-run") // lượt chạy hơn một ngày: thư mục lượt cũ, việc đang chạy ở sâu bên dưới
	for _, d := range []string{old, fresh, filepath.Join(long, "web-a", "job-2")} {
		if err := os.MkdirAll(filepath.Join(d, "web-a"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	past := time.Now().Add(-2 * staleRunAge)
	for _, d := range []string{filepath.Join(old, "web-a"), old, filepath.Join(long, "web-a"), long} {
		if err := os.Chtimes(d, past, past); err != nil {
			t.Fatal(err)
		}
	}
	canned := filepath.Join(t.TempDir(), "c.ndjson")
	_ = os.WriteFile(canned, []byte(`{"type":"end","status":"passed"}`+"\n"), 0o600)
	if _, err := (&Runner{RT: rt}).Run(context.Background(), testJob(rt, "01-a", map[string]string{"FAKE_MODE": "report", "FAKE_REPORT": canned}), nil); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(old); !os.IsNotExist(err) {
		t.Errorf("lượt cũ hơn 1 ngày phải bị xoá: %v", err)
	}
	if _, err := os.Stat(fresh); err != nil {
		t.Errorf("lượt mới không được xoá: %v", err)
	}
	if _, err := os.Stat(long); err != nil {
		t.Errorf("lượt dài còn việc mới bên dưới không được xoá: %v", err)
	}
}
