//go:build !darwin && !linux && !windows

package proc

import "errors"

// startTime: nền tảng không hỗ trợ thì không xác minh được tiến trình, nên Reap không bao giờ giết gì.
func startTime(int) (int64, error) { return 0, errors.New("nền tảng không hỗ trợ") }
