//go:build windows

package updater

import (
	"os"
	"time"
)

// waitPID: Windows cho chờ bất kỳ tiến trình nào qua handle.
func waitPID(pid int) {
	p, err := os.FindProcess(pid)
	if err != nil {
		return // đã thoát
	}
	done := make(chan struct{})
	go func() { _, _ = p.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(20 * time.Second):
	}
}
