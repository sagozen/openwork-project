package proc

import (
	"os"
	"strconv"
	"strings"
)

// Children: PID các tiến trình con trực tiếp (còn sống) của pid, đọc từ /proc. Linux không phải nền tảng
// phát hành, chỉ để CI chạy.
func Children(pid int) ([]int, error) {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil, err
	}
	want := strconv.Itoa(pid)
	var out []int
	for _, e := range entries {
		child, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		b, err := os.ReadFile("/proc/" + e.Name() + "/stat")
		if err != nil {
			continue
		}
		s := string(b)
		i := strings.LastIndexByte(s, ')')
		if i < 0 {
			continue
		}
		f := strings.Fields(s[i+1:])
		if len(f) > 1 && f[0] != "Z" && f[1] == want {
			out = append(out, child)
		}
	}
	return out, nil
}
