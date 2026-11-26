//go:build !windows

package testengine

import (
	"os/exec"
	"path/filepath"
	"runtime"
)

// revealCmd: Finder chọn sẵn file; Linux không có cách chung để chọn file nên mở thư mục cha.
func revealCmd(p string) *exec.Cmd {
	if runtime.GOOS == "darwin" {
		return exec.Command("open", "-R", p)
	}
	return exec.Command("xdg-open", filepath.Dir(p))
}
