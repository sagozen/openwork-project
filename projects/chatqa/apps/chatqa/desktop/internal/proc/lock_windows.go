package proc

import (
	"errors"
	"os"

	"golang.org/x/sys/windows"
)

// LockFile mở (tạo nếu chưa có) path và giữ khoá độc quyền trên nó tới khi file trả về được đóng (hoặc tiến
// trình thoát, kể cả khi sập). Khoá đang thuộc file mở khác, ở tiến trình này hay tiến trình khác, thì trả
// ErrLocked ngay, không chờ.
func LockFile(path string) (*os.File, error) {
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, err
	}
	err = windows.LockFileEx(windows.Handle(f.Fd()), windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY,
		0, 1, 0, &windows.Overlapped{})
	if err != nil {
		f.Close()
		if errors.Is(err, windows.ERROR_LOCK_VIOLATION) {
			return nil, ErrLocked
		}
		return nil, err
	}
	return f, nil
}
