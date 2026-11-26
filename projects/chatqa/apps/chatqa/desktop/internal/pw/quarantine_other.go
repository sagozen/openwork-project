//go:build !darwin

package pw

// removeQuarantine: chỉ macOS có cờ cách ly.
func removeQuarantine(string) {}

// macHost: chỉ dùng trên macOS.
func macHost() string { return "" }
