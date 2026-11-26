//go:build !darwin && !linux && !windows

package proc

import (
	"errors"
	"os"
)

// LockFile: nền tảng không hỗ trợ thì không xác minh được tiến trình độc quyền, nên không bao giờ coi là giữ được khoá.
func LockFile(string) (*os.File, error) { return nil, errors.New("nền tảng không hỗ trợ") }
