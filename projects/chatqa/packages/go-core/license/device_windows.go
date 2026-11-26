//go:build windows

package license

import (
	"errors"
	"os/exec"
	"strings"
	"syscall"
)

// machineID đọc HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid (không đổi khi cài lại app).
func machineID() (string, error) {
	cmd := exec.Command("reg", "query", `HKLM\SOFTWARE\Microsoft\Cryptography`, "/v", "MachineGuid")
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000} // CREATE_NO_WINDOW
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	for _, line := range strings.Split(string(out), "\n") {
		if f := strings.Fields(line); len(f) == 3 && f[0] == "MachineGuid" {
			return f[2], nil
		}
	}
	return "", errors.New("không đọc được MachineGuid")
}
