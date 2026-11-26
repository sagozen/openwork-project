package proc

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	goruntime "runtime"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// Tiến trình phụ: chính binary test chạy lại với CQS_PROC_HELPER.
//   - sleep: ngủ 60s.
//   - tree-eof: mở một tiến trình cháu (sleep), in PID cháu, thoát khi stdin đóng.
//   - tree-stubborn: như trên nhưng bỏ qua SIGTERM và stdin đóng (chỉ SIGKILL / kết thúc Job mới dừng được).
func TestMain(m *testing.M) {
	switch os.Getenv("CQS_PROC_HELPER") {
	case "":
		os.Exit(m.Run())
	case "sleep":
		time.Sleep(60 * time.Second)
		os.Exit(0)
	case "tree-eof", "tree-stubborn":
		child := helper("sleep")
		if err := child.Start(); err != nil {
			os.Exit(3)
		}
		fmt.Println(child.Process.Pid)
		if os.Getenv("CQS_PROC_HELPER") == "tree-stubborn" {
			signal.Ignore(syscall.SIGTERM)
			time.Sleep(60 * time.Second)
		}
		_, _ = io.Copy(io.Discard, os.Stdin)
		os.Exit(0)
	}
}

func helper(mode string) *exec.Cmd {
	cmd := exec.Command(os.Args[0], "-test.run=^$")
	cmd.Env = append(os.Environ(), "CQS_PROC_HELPER="+mode)
	return cmd
}

func alive(pid int) bool {
	_, err := startTime(pid)
	return err == nil
}

func waitDead(t *testing.T, pid int) {
	t.Helper()
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		if !alive(pid) {
			return
		}
	}
	t.Fatalf("tiến trình %d vẫn sống", pid)
}

func startTree(t *testing.T, mode string) (*Tree, int) {
	t.Helper()
	cmd := helper(mode)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	tree, err := Start(cmd, stdin)
	if err != nil {
		t.Fatal(err)
	}
	line, err := bufio.NewReader(out).ReadString('\n')
	if err != nil {
		tree.KillTree(0)
		t.Fatalf("không đọc được PID cháu: %v", err)
	}
	child, err := strconv.Atoi(strings.TrimSpace(line))
	if err != nil {
		t.Fatal(err)
	}
	return tree, child
}

func TestKillTreeGracefulStopsBeforeGraceAndKillsGrandchild(t *testing.T) {
	tree, child := startTree(t, "tree-eof")
	start := time.Now()
	tree.KillTree(5 * time.Second)
	if d := time.Since(start); d > 3*time.Second {
		t.Fatalf("tiến trình tự thoát khi stdin đóng nhưng KillTree chờ %v", d)
	}
	if alive(tree.PID()) {
		t.Fatal("tiến trình gốc còn sống")
	}
	waitDead(t, child)
}

func TestKillTreeForcesStubbornTree(t *testing.T) {
	tree, child := startTree(t, "tree-stubborn")
	start := time.Now()
	tree.KillTree(300 * time.Millisecond)
	if d := time.Since(start); d < 300*time.Millisecond {
		t.Fatalf("chưa hết grace đã giết: %v", d)
	}
	select {
	case <-tree.Done():
	default:
		t.Fatal("KillTree trả về khi tiến trình gốc chưa thoát")
	}
	waitDead(t, child)
	tree.KillTree(0) // gọi lại vô hại
}

func TestPIDFileReapKillsOnlyMatchingRecords(t *testing.T) {
	path := filepath.Join(t.TempDir(), "pids.json")
	f := &PIDFile{Path: path}

	orphan := helper("sleep")
	other := helper("sleep")
	for _, c := range []*exec.Cmd{orphan, other} {
		if err := c.Start(); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = c.Process.Kill(); _, _ = c.Process.Wait() })
	}
	if err := f.Add(orphan.Process.Pid, false); err != nil {
		t.Fatal(err)
	}
	if err := f.Add(other.Process.Pid, false); err != nil {
		t.Fatal(err)
	}
	// PID của "other" coi như đã được cấp lại cho tiến trình khác: thời điểm bắt đầu không khớp.
	recs, _ := f.read()
	for i := range recs {
		if recs[i].PID == other.Process.Pid {
			recs[i].Start--
		}
	}
	if err := f.write(append(recs, Record{PID: 1 << 30, Start: 1})); err != nil { // PID không tồn tại
		t.Fatal(err)
	}

	n, err := (&PIDFile{Path: path}).Reap() // như lần khởi động sau: đối tượng mới, chỉ còn file
	if err != nil || n != 1 {
		t.Fatalf("Reap = %d, %v; muốn giết đúng 1", n, err)
	}
	done := make(chan struct{})
	go func() { _, _ = orphan.Process.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("tiến trình mồ côi chưa bị giết")
	}
	if !alive(other.Process.Pid) {
		t.Fatal("giết nhầm tiến trình có thời điểm bắt đầu khác")
	}
	if recs, _ := f.read(); len(recs) != 0 {
		t.Fatalf("Reap phải xoá danh sách: %v", recs)
	}
}

func TestPIDFileRemove(t *testing.T) {
	f := &PIDFile{Path: filepath.Join(t.TempDir(), "pids.json")}
	if err := f.Add(os.Getpid(), false); err != nil {
		t.Fatal(err)
	}
	if err := f.Remove(os.Getpid()); err != nil {
		t.Fatal(err)
	}
	if recs, _ := f.read(); len(recs) != 0 {
		t.Fatalf("còn bản ghi: %v", recs)
	}
}

func TestChildrenListsDirectChildren(t *testing.T) {
	c := helper("sleep")
	if err := c.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Process.Kill(); _, _ = c.Process.Wait() })
	kids, err := Children(os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	if goruntime.GOOS == "windows" {
		return // Windows dựa vào Job Object, Children không liệt kê
	}
	if !slices.Contains(kids, c.Process.Pid) {
		t.Fatalf("Children(%d) = %v, thiếu %d", os.Getpid(), kids, c.Process.Pid)
	}
}

func TestPIDFileKillOnlyListedRecords(t *testing.T) {
	f := &PIDFile{Path: filepath.Join(t.TempDir(), "pids.json")}
	a, b := helper("sleep"), helper("sleep")
	for _, c := range []*exec.Cmd{a, b} {
		if err := c.Start(); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = c.Process.Kill(); _, _ = c.Process.Wait() })
		if err := f.Add(c.Process.Pid, false); err != nil {
			t.Fatal(err)
		}
	}
	n, err := f.Kill([]int{a.Process.Pid, 1 << 30})
	if err != nil || n != 1 {
		t.Fatalf("Kill = %d, %v", n, err)
	}
	done := make(chan struct{})
	go func() { _, _ = a.Process.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("tiến trình trong danh sách chưa bị giết")
	}
	if !alive(b.Process.Pid) {
		t.Fatal("giết nhầm tiến trình không được yêu cầu")
	}
	if recs, _ := f.read(); len(recs) != 1 || recs[0].PID != b.Process.Pid {
		t.Fatalf("danh sách sau Kill: %v", recs)
	}
}

func TestLockFileIsExclusiveUntilClosed(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".lock")
	a, err := LockFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if b, err := LockFile(path); err != ErrLocked {
		if b != nil {
			b.Close()
		}
		t.Fatalf("khoá lần hai = %v; muốn ErrLocked", err)
	}
	a.Close()
	b, err := LockFile(path)
	if err != nil {
		t.Fatalf("đóng file giữ khoá rồi vẫn không khoá được: %v", err)
	}
	b.Close()
}
