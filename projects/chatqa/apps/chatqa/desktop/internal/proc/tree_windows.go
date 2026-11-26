//go:build windows

package proc

import (
	"sync"
	"unsafe"

	"golang.org/x/sys/windows"
)

// treeSys: Job Object KILL_ON_JOB_CLOSE. App giữ handle; app thoát hay sập thì Windows đóng handle và giết
// mọi tiến trình trong Job (tiến trình con sinh sau cũng vào Job; Job lồng nhau chạy từ Windows 8).
type treeSys struct {
	mu  sync.Mutex
	job windows.Handle // 0 sau release
}

func (t *Tree) prepare() error {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return err
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{
		BasicLimitInformation: windows.JOBOBJECT_BASIC_LIMIT_INFORMATION{LimitFlags: windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE},
	}
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		_ = windows.CloseHandle(job)
		return err
	}
	t.sys.job = job
	return nil
}

func (t *Tree) attach() error {
	h, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(t.PID()))
	if err != nil {
		return err
	}
	defer windows.CloseHandle(h)
	return windows.AssignProcessToJobObject(t.sys.job, h)
}

// terminate: Windows không có SIGTERM cho tiến trình không console; đóng stdin là tín hiệu dừng êm.
func (t *Tree) terminate() {}

func (t *Tree) kill() {
	t.sys.mu.Lock()
	defer t.sys.mu.Unlock()
	if t.sys.job != 0 {
		_ = windows.TerminateJobObject(t.sys.job, 1)
	}
}

// release đóng handle Job: mọi tiến trình còn sót trong Job chết theo (KILL_ON_JOB_CLOSE).
func (t *Tree) release() {
	t.sys.mu.Lock()
	defer t.sys.mu.Unlock()
	if t.sys.job != 0 {
		_ = windows.CloseHandle(t.sys.job)
		t.sys.job = 0
	}
}
