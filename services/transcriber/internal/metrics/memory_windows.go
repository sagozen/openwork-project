//go:build windows

package metrics

import (
	"syscall"
	"unsafe"
)

var (
	memoryKernel32           = syscall.NewLazyDLL("kernel32.dll")
	memoryGlobalMemoryStatus = memoryKernel32.NewProc("GlobalMemoryStatusEx")
)

type memoryStatusEx struct {
	length               uint32
	memoryLoad           uint32
	totalPhys            uint64
	availPhys            uint64
	totalPageFile        uint64
	availPageFile        uint64
	totalVirtual         uint64
	availVirtual         uint64
	availExtendedVirtual uint64
}

func readMemory() (used uint64, total uint64, err error) {
	status := memoryStatusEx{length: uint32(unsafe.Sizeof(memoryStatusEx{}))}
	result, _, callErr := memoryGlobalMemoryStatus.Call(uintptr(unsafe.Pointer(&status)))
	if result == 0 {
		return 0, 0, callErr
	}
	if status.totalPhys == 0 || status.availPhys > status.totalPhys {
		return 0, 0, syscall.EINVAL
	}
	return status.totalPhys - status.availPhys, status.totalPhys, nil
}
