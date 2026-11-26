package tools

import (
	"fmt"
	"sync"
	"time"

	"deskcore/apperr"
)

// saveJobKeep: lượt lưu flow đã xong được giữ kết quả bấy lâu để client hỏi lại bằng test_save_result.
const saveJobKeep = time.Hour

// saveJob: một lần test_save_flow chạy nền (chạy xác nhận có thể lâu hơn giới hạn chờ của client MCP).
type saveJob struct {
	id       string
	key      string // app/tên flow: cùng flow đang lưu thì không chạy lượt thứ hai
	done     chan struct{}
	res      any
	err      error
	finished time.Time
}

// saveJobs: các lượt lưu flow đang chạy hoặc vừa xong, trong bộ nhớ (tắt app là mất, như lượt chạy đang dở).
type saveJobs struct {
	mu   sync.Mutex
	seq  int
	jobs map[string]*saveJob
	now  func() time.Time
}

func newSaveJobs() *saveJobs { return &saveJobs{jobs: map[string]*saveJob{}, now: time.Now} }

// start chạy fn ở nền và trả lượt mới; nếu cùng key đang chạy thì trả lượt đó với started = false, không chạy fn.
func (s *saveJobs) start(key string, fn func() (any, error)) (job *saveJob, started bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	for id, j := range s.jobs {
		select {
		case <-j.done:
			if now.Sub(j.finished) > saveJobKeep {
				delete(s.jobs, id)
			}
		default:
			if j.key == key {
				return j, false
			}
		}
	}
	s.seq++
	job = &saveJob{id: fmt.Sprintf("save-%s-%d", now.Format("150405"), s.seq), key: key, done: make(chan struct{})}
	s.jobs[job.id] = job
	go func() {
		res, err := fn()
		s.mu.Lock()
		job.res, job.err, job.finished = res, err, s.now()
		s.mu.Unlock()
		close(job.done)
	}()
	return job, true
}

func (s *saveJobs) get(id string) (*saveJob, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if j, ok := s.jobs[id]; ok {
		return j, nil
	}
	return nil, apperr.New(apperr.CodeNotFound, fmt.Sprintf("không có lượt lưu flow %q (app đã khởi động lại hoặc kết quả quá %s)", id, saveJobKeep))
}

// wait chờ lượt xong tối đa d; ok = false nếu vẫn đang chạy.
func (s *saveJobs) wait(j *saveJob, d time.Duration) (res any, ok bool, err error) {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-j.done:
		s.mu.Lock()
		defer s.mu.Unlock()
		return j.res, true, j.err
	case <-t.C:
		return nil, false, nil
	}
}
