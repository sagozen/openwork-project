//go:build !windows

package update

import "errors"

func (m *Manager) apply(_ string, _ string) error {
	return errors.New("auto-update is only supported on Windows")
}
