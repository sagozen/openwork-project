//go:build windows

// Package proc: chạy và dọn tiến trình con của app (ẩn console trên Windows, giết cả cây tiến trình,
// ghi PID để dọn tiến trình mồ côi sau khi app bị tắt đột ngột).
package proc

import (
	"os/exec"
	"syscall"
)

// HideConsole: app giao diện không có console, nên mỗi tiến trình con (adb, emulator, node...) sẽ bật một
// cửa sổ console đen nếu thiếu CREATE_NO_WINDOW. Chỉ thêm cờ, giữ nguyên SysProcAttr có sẵn.
func HideConsole(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.HideWindow = true
	cmd.SysProcAttr.CreationFlags |= 0x08000000 // CREATE_NO_WINDOW
}
