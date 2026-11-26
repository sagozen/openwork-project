package proc

import (
	"golang.org/x/sys/windows"
)

// startTime: thời điểm tạo tiến trình (FILETIME, 100ns), lỗi nếu không mở được tiến trình.
func startTime(pid int) (int64, error) {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return 0, err
	}
	defer windows.CloseHandle(h)
	var code uint32
	if err := windows.GetExitCodeProcess(h, &code); err == nil && code != 259 { // 259 = STILL_ACTIVE
		return 0, windows.ERROR_INVALID_PARAMETER
	}
	var created, exited, kernel, user windows.Filetime
	if err := windows.GetProcessTimes(h, &created, &exited, &kernel, &user); err != nil {
		return 0, err
	}
	return created.Nanoseconds() / 100, nil
}

// killPID: hậu duệ đã chết theo Job Object khi app sập; chỉ còn tiến trình gốc (nếu có) cần dừng.
func killPID(pid int, _ bool) error {
	h, err := windows.OpenProcess(windows.PROCESS_TERMINATE, false, uint32(pid))
	if err != nil {
		return err
	}
	defer windows.CloseHandle(h)
	return windows.TerminateProcess(h, 1)
}
