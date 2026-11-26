//go:build darwin || linux

package proc

import (
	"errors"
	"os"
	"syscall"
)

// LockFile mở (tạo nếu chưa có) path và giữ khoá độc quyền trên nó tới khi file trả về được đóng (hoặc tiến
// trình thoát, kể cả khi sập). Khoá đang thuộc file mở khác, ở tiến trình này hay tiến trình khác, thì trả
// ErrLocked ngay, không chờ.
func LockFile(path string) (*os.File, error) {
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return nil, ErrLocked
		}
		return nil, err
	}
	return f, nil
}
