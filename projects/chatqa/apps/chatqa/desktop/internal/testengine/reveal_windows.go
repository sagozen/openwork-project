//go:build windows

package testengine

import (
	"os/exec"
	"syscall"
)

// revealCmd: explorer chỉ hiểu /select,"<đường dẫn>" (ngoặc kép quanh đường dẫn, không quanh cả tham số), nên tự ghép
// dòng lệnh thay vì để Go thêm ngoặc. Đường dẫn đã được kiểm nằm trong thư mục xuất, không chứa ngoặc kép.
func revealCmd(p string) *exec.Cmd {
	c := exec.Command("explorer")
	c.SysProcAttr = &syscall.SysProcAttr{CmdLine: `explorer /select,"` + p + `"`}
	return c
}
