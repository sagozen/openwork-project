//go:build !windows

package pw

import (
	"bufio"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"chatqa/internal/proc"
)

// bootstrap.mjs chạy bằng Node thật (không cần Playwright); máy không có node thì bỏ qua.
func nodeOrSkip(t *testing.T) string {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("không có node trong PATH")
	}
	return node
}

// startBootstrap chạy node bootstrap.mjs <target> như sidecar: nhóm tiến trình riêng, stdin là ống.
func startBootstrap(t *testing.T, target string) (*proc.Tree, io.WriteCloser, <-chan string) {
	t.Helper()
	node := nodeOrSkip(t)
	dir := t.TempDir()
	if err := Install(dir); err != nil {
		t.Fatal(err)
	}
	script := filepath.Join(dir, "target.mjs")
	if err := os.WriteFile(script, []byte(target), 0o644); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(node, filepath.Join(dir, "bootstrap.mjs"), script)
	cmd.Env = ChildEnv(os.Environ(), nil)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	tree, err := proc.Start(cmd, stdin)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { tree.KillTree(0) })
	lines := make(chan string, 16) // một bộ đọc duy nhất cho stdout
	go func() {
		defer close(lines)
		sc := bufio.NewScanner(stdout)
		for sc.Scan() {
			lines <- strings.TrimSpace(sc.Text())
		}
	}()
	return tree, stdin, lines
}

func readLine(t *testing.T, lines <-chan string, within time.Duration) (string, bool) {
	t.Helper()
	select {
	case line, ok := <-lines:
		return line, ok
	case <-time.After(within):
		return "", false
	}
}

func pidAlive(pid int) bool { return syscall.Kill(pid, 0) == nil }

func TestBootstrapWaitsForStartGate(t *testing.T) {
	_, stdin, out := startBootstrap(t, `process.stdout.write('ran\n'); setInterval(() => {}, 1000);`)
	if line, ok := readLine(t, out, 500*time.Millisecond); ok {
		t.Fatalf("script chạy trước dòng start: %q", line)
	}
	if _, err := io.WriteString(stdin, "start\n"); err != nil {
		t.Fatal(err)
	}
	if line, ok := readLine(t, out, 5*time.Second); !ok || line != "ran" {
		t.Fatalf("script không chạy sau start: %q", line)
	}
}

func TestBootstrapForwardsInputAfterGate(t *testing.T) {
	_, stdin, out := startBootstrap(t, `
const input = globalThis[Symbol.for('chatqa.stdin')];
input.on('data', (b) => process.stdout.write('got:' + b.toString()));`)
	// "start" và dữ liệu đầu tiên tới cùng một lần ghi: phần sau dòng start không được mất.
	if _, err := io.WriteString(stdin, "start\nhello\n"); err != nil {
		t.Fatal(err)
	}
	if line, ok := readLine(t, out, 5*time.Second); !ok || line != "got:hello" {
		t.Fatalf("script không nhận phần stdin sau start: %q", line)
	}
}

func TestBootstrapStdinEOFStopsProcessAndGrandchild(t *testing.T) {
	tree, stdin, out := startBootstrap(t, `
import { spawn } from 'node:child_process';
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
process.stdout.write(child.pid + '\n');
setInterval(() => {}, 1000);`)
	if _, err := io.WriteString(stdin, "start\n"); err != nil {
		t.Fatal(err)
	}
	line, ok := readLine(t, out, 5*time.Second)
	grandchild, err := strconv.Atoi(line)
	if !ok || err != nil {
		t.Fatalf("không đọc được PID tiến trình cháu: %q", line)
	}
	// Như app sập: stdin đóng, không ai gọi KillTree.
	start := time.Now()
	_ = stdin.Close()
	select {
	case <-tree.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("bootstrap không tự thoát trong 2 s sau khi stdin đóng")
	}
	for pidAlive(grandchild) {
		if time.Since(start) > 2*time.Second {
			t.Fatal("tiến trình cháu còn sống 2 s sau khi stdin đóng")
		}
		time.Sleep(20 * time.Millisecond)
	}
}
