package pw

import (
	"io/fs"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	"golang.org/x/sys/unix"
)

// removeQuarantine gỡ com.apple.quarantine khỏi mọi file vừa giải nén. App không sandbox tải bằng net/http
// thì file không bị gắn cờ này; đây là bước phòng thủ, lỗi (kể cả ENOATTR) đều bỏ qua.
func removeQuarantine(dir string) {
	_ = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err == nil && d.Type()&fs.ModeSymlink == 0 {
			_ = unix.Removexattr(p, "com.apple.quarantine")
		}
		return nil
	})
}

// macHost: tên nền tảng macOS theo cách Playwright gọi (mac14, mac15, mac26) để chọn bản WebKit; "" nếu
// không xác định. Darwin 20-24 là macOS 11-15, từ Darwin 25 là macOS 26.
func macHost() string {
	rel, err := syscall.Sysctl("kern.osrelease")
	if err != nil {
		return ""
	}
	major, err := strconv.Atoi(strings.SplitN(rel, ".", 2)[0])
	if err != nil || major < 20 {
		return ""
	}
	if major >= 25 {
		return "mac26"
	}
	return "mac" + strconv.Itoa(major-9)
}
