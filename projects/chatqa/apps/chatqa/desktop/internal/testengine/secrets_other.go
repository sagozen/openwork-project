//go:build !darwin

package testengine

import "path/filepath"

// NewSecrets: ngoài macOS bí mật nằm trong dir/secrets.bin, niêm phong bằng DPAPI (Windows).
func NewSecrets(dir, _ string) Secrets {
	return &fileSecrets{path: filepath.Join(dir, "secrets.bin")}
}
