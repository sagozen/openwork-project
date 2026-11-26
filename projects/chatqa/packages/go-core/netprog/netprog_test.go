package netprog

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

type sink struct {
	mu sync.Mutex
	ev []Event
}

func (s *sink) emit(name string, data any) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if name == EventName {
		s.ev = append(s.ev, data.(Event))
	}
}

func (s *sink) all() []Event {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]Event(nil), s.ev...)
}

func install(t *testing.T) *sink {
	t.Helper()
	s := &sink{}
	SetEmitter(s.emit)
	t.Cleanup(func() { SetEmitter(nil) })
	return s
}

func TestLifecycleEmitsRunningThenDone(t *testing.T) {
	s := install(t)
	ctx, op := Begin(context.Background(), "vipo.read-sheet", "Đang đọc Sheet Vipo")
	if From(ctx) != op {
		t.Fatal("ctx phải mang Op vừa mở")
	}
	op.Step("Đang xử lý dòng")
	op.End(nil)
	op.End(errors.New("lần hai bị bỏ qua"))
	ev := s.all()
	if len(ev) != 3 {
		t.Fatalf("muốn 3 sự kiện (mở, bước, xong), có %d: %+v", len(ev), ev)
	}
	if ev[0].State != StateRunning || ev[0].Op != "vipo.read-sheet" || ev[0].Label != "Đang đọc Sheet Vipo" {
		t.Fatalf("sự kiện mở sai: %+v", ev[0])
	}
	if ev[1].Label != "Đang xử lý dòng" || ev[2].State != StateDone {
		t.Fatalf("bước/kết thúc sai: %+v", ev[1:])
	}
	if ev[0].ID == "" || ev[0].ID != ev[2].ID || ev[0].StartedAt == 0 {
		t.Fatalf("mã/giờ bắt đầu phải giữ nguyên suốt lần chạy: %+v", ev)
	}
}

func TestFailedStateOnError(t *testing.T) {
	s := install(t)
	_, op := Begin(context.Background(), "x", "x")
	op.End(errors.New("mất mạng"))
	ev := s.all()
	if got := ev[len(ev)-1].State; got != StateFailed {
		t.Fatalf("state = %q, muốn failed", got)
	}
}

func TestCountIsThrottledButEndIsAlwaysSent(t *testing.T) {
	s := install(t)
	cur := time.Unix(1000, 0)
	old := now
	now = func() time.Time { return cur }
	t.Cleanup(func() { now = old })

	_, op := Begin(context.Background(), "drive.download", "Đang tải")
	for i := int64(1); i <= 50; i++ {
		op.Count(i, 50, UnitBytes) // cùng một mốc giờ: bị nén
	}
	cur = cur.Add(throttle)
	op.Count(51, 100, UnitBytes) // đủ khoảng cách: được gửi
	op.End(nil)

	ev := s.all()
	if len(ev) != 3 { // mở, một lần đếm, xong
		t.Fatalf("muốn 3 sự kiện sau khi nén, có %d: %+v", len(ev), ev)
	}
	if ev[1].Done != 51 || ev[1].Total != 100 || ev[1].Unit != UnitBytes {
		t.Fatalf("đếm sai: %+v", ev[1])
	}
}

func TestStepResetsCount(t *testing.T) {
	s := install(t)
	_, op := Begin(context.Background(), "x", "một")
	op.Count(5, 10, UnitRows)
	op.Step("hai")
	ev := s.all()
	last := ev[len(ev)-1]
	if last.Label != "hai" || last.Done != 0 || last.Total != 0 || last.Unit != UnitNone {
		t.Fatalf("Step phải xoá đếm cũ: %+v", last)
	}
}

func TestNilOpAndNoEmitterAreSafe(t *testing.T) {
	SetEmitter(nil)
	var op *Op
	op.Step("a")
	op.Count(1, 2, UnitRows)
	op.Note("n")
	op.End(nil)
	if From(context.Background()) != nil {
		t.Fatal("ctx trống không có Op")
	}
	_, real := Begin(context.Background(), "x", "x") // không emitter: không panic
	real.Count(1, 1, UnitRows)
	real.End(nil)
}
