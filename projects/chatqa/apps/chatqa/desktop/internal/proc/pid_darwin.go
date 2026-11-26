package proc

import (
	"fmt"

	"golang.org/x/sys/unix"
)

// startTime: thời điểm bắt đầu của tiến trình (micro giây Unix), lỗi nếu không còn tiến trình.
func startTime(pid int) (int64, error) {
	kp, err := unix.SysctlKinfoProc("kern.proc.pid", pid)
	if err != nil {
		return 0, err
	}
	if int(kp.Proc.P_pid) != pid || kp.Proc.P_stat == 5 { // 5 = SZOMB: đã thoát, chờ thu dọn
		return 0, fmt.Errorf("không có tiến trình %d", pid)
	}
	t := kp.Proc.P_starttime
	return t.Sec*1e6 + int64(t.Usec), nil
}
