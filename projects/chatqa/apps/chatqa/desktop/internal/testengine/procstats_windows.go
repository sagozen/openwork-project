//go:build windows

package testengine

import (
	"syscall"
	"unsafe"
)

var (
	psapi                    = syscall.NewLazyDLL("psapi.dll")
	procGetProcessMemoryInfo = psapi.NewProc("GetProcessMemoryInfo")
)

// PROCESS_MEMORY_COUNTERS (psapi.h).
type processMemoryCounters struct {
	cb                         uint32
	pageFaultCount             uint32
	peakWorkingSetSize         uintptr
	workingSetSize             uintptr
	quotaPeakPagedPoolUsage    uintptr
	quotaPagedPoolUsage        uintptr
	quotaPeakNonPagedPoolUsage uintptr
	quotaNonPagedPoolUsage     uintptr
	pagefileUsage              uintptr
	peakPagefileUsage          uintptr
}

// maxRSSMB: working set đỉnh của tiến trình app.
func maxRSSMB() float64 {
	var c processMemoryCounters
	c.cb = uint32(unsafe.Sizeof(c))
	h, err := syscall.GetCurrentProcess()
	if err != nil {
		return 0
	}
	if r, _, _ := procGetProcessMemoryInfo.Call(uintptr(h), uintptr(unsafe.Pointer(&c)), uintptr(c.cb)); r == 0 {
		return 0
	}
	return float64(c.peakWorkingSetSize) / (1 << 20)
}

// cpuTime: thời gian CPU (user + kernel) tiến trình đã dùng, mili giây.
func cpuTime() int64 {
	h, err := syscall.GetCurrentProcess()
	if err != nil {
		return 0
	}
	var created, exited, kernel, user syscall.Filetime
	if syscall.GetProcessTimes(h, &created, &exited, &kernel, &user) != nil {
		return 0
	}
	ft := func(f syscall.Filetime) int64 { return int64(f.HighDateTime)<<32 | int64(f.LowDateTime) }
	return (ft(kernel) + ft(user)) / 10000 // đơn vị 100 ns
}
