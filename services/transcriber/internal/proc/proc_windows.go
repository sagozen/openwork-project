//go:build windows

package proc

import (
	"os/exec"
	"strconv"
	"syscall"
)

const createNewProcessGroup = 0x00000200

// Configure starts the child in a new process group; without it a cancelled job would leave
// whisper-cli.exe and ffmpeg.exe running after the Go process exits.
func Configure(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{CreationFlags: createNewProcessGroup}
}

// Kill uses taskkill /T so the child's own children (ffmpeg, yt-dlp) die too.
func Kill(command *exec.Cmd) {
	if command == nil || command.Process == nil {
		return
	}
	pid := strconv.Itoa(command.Process.Pid)
	_ = exec.Command("taskkill", "/T", "/F", "/PID", pid).Run()
	_ = command.Process.Kill()
}
