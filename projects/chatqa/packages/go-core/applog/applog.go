// Package applog: ghi log ra file trong thư mục dữ liệu.
// App Windows (GUI) không có console => không có file log thì lỗi ở máy khách không điều tra được.
//
//	<DataDir>/logs/<config.Product.LogName> (tối đa ~5 MB, giữ 1 bản cũ <LogName>.1)
package applog

import (
	"io"
	"log"
	"os"
	"path/filepath"
	"runtime/debug"
)

const MaxSize = 5 << 20

// Setup chuyển log chuẩn sang file name trong <dataDir>/logs (kèm stderr khi chạy dev). Trả hàm đóng file.
func Setup(dataDir, name string) (path string, closeFn func()) {
	dir := filepath.Join(dataDir, "logs")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", func() {}
	}
	path = filepath.Join(dir, name)
	rotate(path, MaxSize)
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return "", func() {}
	}
	log.SetOutput(io.MultiWriter(os.Stderr, f))
	log.SetFlags(log.LstdFlags | log.Lmicroseconds | log.Lshortfile)
	// Panic / lỗi fatal của runtime chỉ in ra stderr (exe GUI không có) => ghi thêm vào file log. Runtime giữ bản sao fd riêng.
	if err := debug.SetCrashOutput(f, debug.CrashOptions{}); err != nil {
		log.Printf("applog: không ghi được panic vào log: %v", err)
	}
	return path, func() {
		// Runtime giữ bản sao fd của file cho SetCrashOutput: trả lại trước khi đóng, không thì trên Windows file log còn bị
		// giữ (không xoá / không xoay vòng được) tới khi tiến trình thoát.
		_ = debug.SetCrashOutput(nil, debug.CrashOptions{})
		_ = f.Close()
	}
}

// rotate: file quá max thì đổi thành .1 (ghi đè bản cũ hơn).
func rotate(path string, max int64) {
	if fi, err := os.Stat(path); err == nil && fi.Size() > max {
		_ = os.Remove(path + ".1")
		_ = os.Rename(path, path+".1")
	}
}
