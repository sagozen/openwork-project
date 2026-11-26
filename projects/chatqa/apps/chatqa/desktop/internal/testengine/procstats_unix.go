//go:build !windows

package testengine

import (
	"runtime"
	"syscall"
)

// maxRSSMB: RSS đỉnh của tiến trình app (macOS trả byte, Linux trả KB).
func maxRSSMB() float64 {
	var ru syscall.Rusage
	if syscall.Getrusage(syscall.RUSAGE_SELF, &ru) != nil {
		return 0
	}
	if runtime.GOOS == "darwin" {
		return float64(ru.Maxrss) / (1 << 20)
	}
	return float64(ru.Maxrss) / (1 << 10)
}

// cpuTime: thời gian CPU (user + system) tiến trình đã dùng, mili giây.
func cpuTime() int64 {
	var ru syscall.Rusage
	if syscall.Getrusage(syscall.RUSAGE_SELF, &ru) != nil {
		return 0
	}
	return (ru.Utime.Nano() + ru.Stime.Nano()) / 1e6
}
