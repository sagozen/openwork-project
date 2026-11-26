// Package version resolves the version this binary reports. An auto-update writes
// `<state>/version.txt` next to the executable, so the file wins over the environment: the
// environment value is baked into the service at install time and would otherwise stay stale
// for ever. Workers installed before version.txt existed simply keep reporting their env value.
package version

import (
	"os"
	"path/filepath"
	"strings"
)

const FileName = "version.txt"

func Resolve(stateDir, envVersion string) string {
	if stateDir != "" {
		if raw, err := os.ReadFile(filepath.Join(stateDir, FileName)); err == nil {
			if value := strings.TrimSpace(string(raw)); value != "" && len(value) <= 64 {
				return value
			}
		}
	}
	if value := strings.TrimSpace(envVersion); value != "" {
		return value
	}
	return "0.0.0"
}
