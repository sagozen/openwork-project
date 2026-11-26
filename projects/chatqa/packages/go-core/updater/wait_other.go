//go:build !windows

package updater

import (
	"syscall"
	"time"
)

// waitPID (macOS/Linux, dùng khi dev): thăm dò bằng signal 0.
func waitPID(pid int) {
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		if syscall.Kill(pid, 0) != nil {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
}
