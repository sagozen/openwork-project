//go:build !darwin && !linux

package proc

// Children: Windows không cần (hậu duệ nằm trong Job Object và chết theo Job); nền tảng khác không hỗ trợ.
func Children(int) ([]int, error) { return nil, nil }
