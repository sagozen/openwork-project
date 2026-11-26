package tools

import (
	"errors"
	"testing"
	"time"

	"deskcore/apperr"
)

// Chạy xác nhận lâu hơn thời gian chờ: lượt vẫn chạy tiếp, hỏi lại theo id lấy được kết quả; gọi lại cùng flow không chạy lượt thứ hai.
func TestSaveJobOutlivesWaitAndIsNotStartedTwice(t *testing.T) {
	s := newSaveJobs()
	release := make(chan struct{})
	runs := 0
	job, started := s.start("demo/09_e2e.yaml", func() (any, error) {
		runs++
		<-release
		return "saved", nil
	})
	if !started {
		t.Fatal("lượt đầu phải được chạy")
	}
	if _, ok, _ := s.wait(job, 10*time.Millisecond); ok {
		t.Fatal("lượt chưa xong mà wait báo xong")
	}
	again, started := s.start("demo/09_e2e.yaml", func() (any, error) { t.Error("không được chạy lượt thứ hai"); return nil, nil })
	if started || again.id != job.id {
		t.Fatalf("gọi lại cùng flow phải trả lượt đang chạy %s, được %s (started=%v)", job.id, again.id, started)
	}
	close(release)
	got, err := s.get(job.id)
	if err != nil {
		t.Fatal(err)
	}
	res, ok, err := s.wait(got, time.Second)
	if !ok || err != nil || res != "saved" || runs != 1 {
		t.Fatalf("kết quả: res=%v ok=%v err=%v runs=%d", res, ok, err, runs)
	}
	// Flow đã xong thì lần lưu sau chạy lượt mới.
	if _, started := s.start("demo/09_e2e.yaml", func() (any, error) { return nil, errors.New("x") }); !started {
		t.Fatal("flow đã xong phải chạy được lượt mới")
	}
}

func TestSaveJobsForgetOldResults(t *testing.T) {
	s := newSaveJobs()
	now := time.Now()
	s.now = func() time.Time { return now }
	job, _ := s.start("demo/a.yaml", func() (any, error) { return "ok", nil })
	if _, ok, _ := s.wait(job, time.Second); !ok {
		t.Fatal("lượt phải xong")
	}
	now = now.Add(saveJobKeep + time.Minute)
	s.start("demo/b.yaml", func() (any, error) { return "ok", nil }) // dọn lượt cũ khi bắt đầu lượt mới
	if _, err := s.get(job.id); apperr.CodeOf(err) != apperr.CodeNotFound {
		t.Fatalf("lượt quá hạn giữ phải bị quên: %v", err)
	}
	if _, err := s.get("save-không-có"); apperr.CodeOf(err) != apperr.CodeNotFound {
		t.Fatalf("id lạ: %v", err)
	}
}
