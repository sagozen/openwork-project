package proc

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
)

// Record: một tiến trình app đã mở. Start là thời điểm hệ điều hành ghi nhận tiến trình bắt đầu, dùng để
// không bao giờ giết nhầm tiến trình khác được cấp lại cùng PID sau khi máy khởi động lại.
type Record struct {
	PID   int   `json:"pid"`
	Start int64 `json:"start"`
	Group bool  `json:"group,omitempty"` // POSIX: PID là trưởng nhóm, giết cả nhóm
}

// PIDFile: danh sách tiến trình con đang sống (pids.json). App sập (kill -9) thì danh sách còn lại, và lần
// khởi động sau Reap giết các tiến trình mồ côi trước khi mở tiến trình mới.
type PIDFile struct {
	Path string
	mu   sync.Mutex
}

// Add ghi PID (đang chạy) vào danh sách.
func (f *PIDFile) Add(pid int, group bool) error {
	start, err := startTime(pid)
	if err != nil {
		return err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	recs, err := f.read()
	if err != nil {
		return err
	}
	out := recs[:0]
	for _, r := range recs {
		if r.PID != pid {
			out = append(out, r)
		}
	}
	return f.write(append(out, Record{PID: pid, Start: start, Group: group}))
}

// Remove bỏ PID khỏi danh sách (tiến trình đã thoát bình thường).
func (f *PIDFile) Remove(pid int) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	recs, err := f.read()
	if err != nil {
		return err
	}
	out := recs[:0]
	for _, r := range recs {
		if r.PID != pid {
			out = append(out, r)
		}
	}
	return f.write(out)
}

// Reap giết mọi tiến trình trong danh sách còn sống và đúng thời điểm bắt đầu đã ghi, rồi xoá danh sách.
// Trả số tiến trình đã giết. Gọi lúc app khởi động, trước khi mở tiến trình con nào.
func (f *PIDFile) Reap() (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	recs, err := f.read()
	if err != nil {
		return 0, err
	}
	killed := 0
	var errs []error
	for _, r := range recs {
		if start, err := startTime(r.PID); err != nil || start != r.Start {
			continue // đã chết, hoặc PID nay thuộc tiến trình khác
		}
		if err := killPID(r.PID, r.Group); err != nil {
			errs = append(errs, err)
			continue
		}
		killed++
	}
	if err := f.write(nil); err != nil {
		errs = append(errs, err)
	}
	return killed, errors.Join(errs...)
}

// Kill giết các tiến trình trong pids còn sống và đúng thời điểm bắt đầu đã ghi, rồi bỏ chúng khỏi danh
// sách. PID không có trong danh sách bị bỏ qua (không bao giờ giết tiến trình app không tự ghi).
func (f *PIDFile) Kill(pids []int) (int, error) {
	if len(pids) == 0 {
		return 0, nil
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	recs, err := f.read()
	if err != nil {
		return 0, err
	}
	want := map[int]bool{}
	for _, p := range pids {
		want[p] = true
	}
	killed := 0
	var errs []error
	out := recs[:0]
	for _, r := range recs {
		if !want[r.PID] {
			out = append(out, r)
			continue
		}
		if start, err := startTime(r.PID); err != nil || start != r.Start {
			continue
		}
		if err := killPID(r.PID, r.Group); err != nil {
			errs = append(errs, err)
			continue
		}
		killed++
	}
	if err := f.write(out); err != nil {
		errs = append(errs, err)
	}
	return killed, errors.Join(errs...)
}

func (f *PIDFile) read() ([]Record, error) {
	b, err := os.ReadFile(f.Path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var recs []Record
	if len(b) > 0 && json.Unmarshal(b, &recs) != nil {
		return nil, nil // file hỏng (app sập giữa lúc ghi cũ): coi như rỗng thay vì chặn khởi động
	}
	return recs, nil
}

// write ghi file tạm rồi đổi tên, để app sập giữa chừng không để lại danh sách cụt.
func (f *PIDFile) write(recs []Record) error {
	if recs == nil {
		recs = []Record{}
	}
	b, err := json.Marshal(recs)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(f.Path), 0o755); err != nil {
		return err
	}
	tmp := f.Path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, f.Path)
}
