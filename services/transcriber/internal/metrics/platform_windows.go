//go:build windows

package metrics

import (
	"syscall"
	"unsafe"
)

var (
	metricKernel32       = syscall.NewLazyDLL("kernel32.dll")
	metricGetSystemTimes = metricKernel32.NewProc("GetSystemTimes")
	metricGetTickCount64 = metricKernel32.NewProc("GetTickCount64")
)

type filetime struct {
	low  uint32
	high uint32
}

func (f filetime) value() uint64 {
	return uint64(f.high)<<32 | uint64(f.low)
}

// readCPU uses GetSystemTimes. Kernel time already includes idle time, so total = kernel + user.
func readCPU() (cpuSample, error) {
	var idle, kernel, user filetime
	result, _, err := metricGetSystemTimes.Call(
		uintptr(unsafe.Pointer(&idle)),
		uintptr(unsafe.Pointer(&kernel)),
		uintptr(unsafe.Pointer(&user)),
	)
	if result == 0 {
		return cpuSample{}, err
	}
	return cpuSample{idle: idle.value(), total: kernel.value() + user.value()}, nil
}

func readUptime() (uint64, error) {
	milliseconds, _, err := metricGetTickCount64.Call()
	if milliseconds == 0 {
		return 0, err
	}
	return uint64(milliseconds) / 1000, nil
}
