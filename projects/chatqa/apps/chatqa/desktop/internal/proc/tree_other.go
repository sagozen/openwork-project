//go:build !windows

package proc

import (
	"syscall"
)

// treeSys: POSIX dùng nhóm tiến trình (pgid = pid tiến trình gốc), không cần tài nguyên riêng.
type treeSys struct{}

func (t *Tree) prepare() error {
	if t.cmd.SysProcAttr == nil {
		t.cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	t.cmd.SysProcAttr.Setpgid = true
	return nil
}

func (t *Tree) attach() error { return nil }

// terminate gửi SIGTERM cho cả nhóm: Playwright tự đóng các trình duyệt nó mở (mỗi trình duyệt nằm ở
// nhóm riêng nên SIGKILL nhóm node không tới được chúng).
func (t *Tree) terminate() { _ = syscall.Kill(-t.PID(), syscall.SIGTERM) }

// kill giết cả nhóm, kể cả khi tiến trình gốc đã thoát nhưng tiến trình con trong nhóm còn sống.
func (t *Tree) kill() { _ = syscall.Kill(-t.PID(), syscall.SIGKILL) }

func (t *Tree) release() {}
