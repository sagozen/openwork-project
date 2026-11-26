package proc

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

// startTime: thời điểm bắt đầu của tiến trình (tick đồng hồ từ lúc máy khởi động, trường 22 của
// /proc/<pid>/stat), lỗi nếu không còn tiến trình. Linux không phải nền tảng phát hành, chỉ để CI chạy.
func startTime(pid int) (int64, error) {
	b, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return 0, err
	}
	s := string(b)
	i := strings.LastIndexByte(s, ')') // tên lệnh có thể chứa dấu cách
	if i < 0 {
		return 0, fmt.Errorf("stat lạ: %d", pid)
	}
	f := strings.Fields(s[i+1:])
	if len(f) < 20 {
		return 0, fmt.Errorf("stat lạ: %d", pid)
	}
	if f[0] == "Z" {
		return 0, fmt.Errorf("tiến trình %d đã thoát", pid)
	}
	return strconv.ParseInt(f[19], 10, 64)
}
