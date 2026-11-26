package proc

import (
	"io"
	"os/exec"
	"time"
)

// waitDelay: sau khi tiến trình gốc thoát, chờ tối đa chừng này cho ống stdout/stderr rồi đóng hẳn, để
// một tiến trình cháu còn giữ ống không làm Wait treo mãi.
const waitDelay = 2 * time.Second

// Tree: một tiến trình con cùng mọi hậu duệ của nó (POSIX: nhóm tiến trình riêng; Windows: Job Object
// KILL_ON_JOB_CLOSE, nên cả cây chết theo app kể cả khi app sập).
type Tree struct {
	cmd   *exec.Cmd
	stdin io.Closer
	done  chan struct{}
	err   error
	sys   treeSys
}

// Start ẩn console, đặt cmd vào nhóm/Job riêng rồi chạy. stdin (có thể nil) là đầu ghi của stdin tiến trình
// con, bị đóng đầu tiên khi KillTree để tiến trình tự thoát êm. Tree tự gọi cmd.Wait: dùng Wait/Done.
func Start(cmd *exec.Cmd, stdin io.Closer) (*Tree, error) {
	HideConsole(cmd)
	t := &Tree{cmd: cmd, stdin: stdin, done: make(chan struct{})}
	if err := t.prepare(); err != nil {
		return nil, err
	}
	if cmd.WaitDelay == 0 {
		cmd.WaitDelay = waitDelay
	}
	if err := cmd.Start(); err != nil {
		t.release()
		return nil, err
	}
	if err := t.attach(); err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		t.release()
		return nil, err
	}
	go func() {
		t.err = cmd.Wait()
		t.release() // Windows: hậu duệ còn sót chết theo khi tiến trình gốc thoát
		close(t.done)
	}()
	return t, nil
}

// PID của tiến trình gốc.
func (t *Tree) PID() int { return t.cmd.Process.Pid }

// Done đóng khi tiến trình gốc đã thoát.
func (t *Tree) Done() <-chan struct{} { return t.done }

// Wait chờ tiến trình gốc thoát và trả lỗi của cmd.Wait.
func (t *Tree) Wait() error {
	<-t.done
	return t.err
}

// KillTree đóng stdin, xin cả cây dừng (POSIX: SIGTERM cho nhóm), chờ tối đa grace, rồi giết cả cây.
// Gọi nhiều lần vô hại. Trả khi tiến trình gốc đã thoát.
func (t *Tree) KillTree(grace time.Duration) {
	if t.stdin != nil {
		_ = t.stdin.Close()
	}
	t.terminate()
	timer := time.NewTimer(grace)
	defer timer.Stop()
	select {
	case <-t.done:
	case <-timer.C:
	}
	t.kill()
	<-t.done
}
