//go:build !windows

package main

import (
	"runtime"
	"syscall"
)

// maxRSSMB: RSS đỉnh của tiến trình (macOS trả byte, Linux trả KB).
func maxRSSMB() float64 {
	var ru syscall.Rusage
	if err := syscall.Getrusage(syscall.RUSAGE_SELF, &ru); err != nil {
		return 0
	}
	if runtime.GOOS == "darwin" {
		return float64(ru.Maxrss) / (1 << 20)
	}
	return float64(ru.Maxrss) / (1 << 10)
}
