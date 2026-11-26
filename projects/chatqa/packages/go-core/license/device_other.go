//go:build !windows

package license

import (
	"errors"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strings"
)

var ioregUUID = regexp.MustCompile(`"IOPlatformUUID" = "([^"]+)"`)

// machineID cho môi trường dev (macOS/Linux). Bản phát hành chỉ chạy Windows.
func machineID() (string, error) {
	if runtime.GOOS == "darwin" {
		out, err := exec.Command("ioreg", "-rd1", "-c", "IOPlatformExpertDevice").Output()
		if err == nil {
			if m := ioregUUID.FindSubmatch(out); m != nil {
				return string(m[1]), nil
			}
		}
	}
	for _, p := range []string{"/etc/machine-id", "/var/lib/dbus/machine-id"} {
		if b, err := os.ReadFile(p); err == nil && len(strings.TrimSpace(string(b))) > 0 {
			return string(b), nil
		}
	}
	if h, err := os.Hostname(); err == nil {
		return "host:" + h, nil
	}
	return "", errors.New("không xác định được máy")
}
