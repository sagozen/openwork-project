package proc

import "golang.org/x/sys/unix"

// Children: PID các tiến trình con trực tiếp (còn sống) của pid.
func Children(pid int) ([]int, error) {
	procs, err := unix.SysctlKinfoProcSlice("kern.proc.all")
	if err != nil {
		return nil, err
	}
	var out []int
	for _, p := range procs {
		if int(p.Eproc.Ppid) == pid && p.Proc.P_stat != 5 { // 5 = SZOMB
			out = append(out, int(p.Proc.P_pid))
		}
	}
	return out, nil
}
