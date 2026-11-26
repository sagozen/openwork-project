//go:build !windows

package proc

import "syscall"

// killPID giết tiến trình (và cả nhóm nếu nó là trưởng nhóm).
func killPID(pid int, group bool) error {
	if group {
		_ = syscall.Kill(-pid, syscall.SIGKILL)
	}
	if err := syscall.Kill(pid, syscall.SIGKILL); err != nil && err != syscall.ESRCH {
		return err
	}
	return nil
}
