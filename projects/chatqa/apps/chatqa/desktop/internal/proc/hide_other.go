//go:build !windows

// Package proc: chạy và dọn tiến trình con của app (ẩn console trên Windows, giết cả cây tiến trình,
// ghi PID để dọn tiến trình mồ côi sau khi app bị tắt đột ngột).
package proc

import "os/exec"

// HideConsole: ngoài Windows không có cửa sổ console để ẩn.
func HideConsole(*exec.Cmd) {}
