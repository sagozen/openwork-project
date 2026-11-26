//go:build !windows

package proc

import (
	"os/exec"
	"syscall"
)

// Configure puts the child in its own process group so a cancelled job can kill ffmpeg,
// whisper-cli and yt-dlp together instead of leaving orphans.
func Configure(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

// Kill terminates the whole process group.
func Kill(command *exec.Cmd) {
	if command == nil || command.Process == nil {
		return
	}
	group := -command.Process.Pid
	_ = syscall.Kill(group, syscall.SIGKILL)
}
