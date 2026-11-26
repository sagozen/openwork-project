//go:build windows

package disk

import (
	"syscall"
	"unsafe"
)

// Stats reports free and total bytes on the volume holding path.
func Stats(path string) (free int64, total int64, err error) {
	pathPointer, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return 0, 0, err
	}
	var freeToCaller, totalBytes, totalFree uint64
	result, _, callErr := getDiskFreeSpaceExW.Call(
		uintptr(unsafe.Pointer(pathPointer)),
		uintptr(unsafe.Pointer(&freeToCaller)),
		uintptr(unsafe.Pointer(&totalBytes)),
		uintptr(unsafe.Pointer(&totalFree)),
	)
	if result == 0 {
		return 0, 0, callErr
	}
	return int64(freeToCaller), int64(totalBytes), nil
}
