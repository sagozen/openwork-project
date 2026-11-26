//go:build !windows

package core

// Ngoài Windows (chỉ dùng khi phát triển trên macOS/Linux) không có DPAPI: giữ nguyên dữ liệu.
// Bản phát hành chạy trên Windows nên không đi đường này.

func protect(plain []byte) ([]byte, error) { return append([]byte(nil), plain...), nil }

func unprotect(sealed []byte) ([]byte, error) { return append([]byte(nil), sealed...), nil }
