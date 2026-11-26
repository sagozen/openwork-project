//go:build windows

package update

import (
	_ "embed"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"syscall"
)

//go:embed update-worker.ps1
var updateScript []byte

// apply starts a detached PowerShell script that stops the service, swaps the executable, and
// starts the service again. The worker keeps running until the script stops it, which also gives
// the lease manager a moment to finish an in-flight heartbeat.
func (m *Manager) apply(staged, version string) error {
	if m.options.ServiceName == "" {
		return errors.New("UPDATE_SERVICE is not configured")
	}
	if err := exec.Command("sc.exe", "query", m.options.ServiceName).Run(); err != nil {
		return fmt.Errorf("service %s was not found; the update stays staged", m.options.ServiceName)
	}
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	if m.options.StateDir == "" {
		return errors.New("state directory is not configured")
	}
	scriptPath := filepath.Join(m.options.StateDir, "update-worker.ps1")
	if err := os.WriteFile(scriptPath, updateScript, 0o600); err != nil {
		return err
	}
	logPath := filepath.Join(m.options.StateDir, "update.log")
	command := exec.Command(
		"powershell.exe",
		"-NoProfile",
		"-NonInteractive",
		"-ExecutionPolicy", "Bypass",
		"-WindowStyle", "Hidden",
		"-File", scriptPath,
		"-InstallDir", filepath.Dir(executable),
		"-StateDir", m.options.StateDir,
		"-StagedExe", staged,
		"-ServiceName", m.options.ServiceName,
		"-ProcessId", strconv.Itoa(os.Getpid()),
		"-Version", version,
		"-LogPath", logPath,
	)
	// DETACHED_PROCESS: the script must outlive this process.
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x00000008}
	if err := command.Start(); err != nil {
		return err
	}
	return command.Process.Release()
}
