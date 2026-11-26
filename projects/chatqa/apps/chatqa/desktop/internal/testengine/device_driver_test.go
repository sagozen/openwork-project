package testengine

import (
	"context"
	"sync"
	"testing"

	"github.com/devicelab-dev/maestro-runner/pkg/core"
	"github.com/devicelab-dev/maestro-runner/pkg/flow"

	"deskcore/apperr"
)

// recDriver ghi lại mọi step được Execute (embed core.Driver nil: chỉ Execute được gọi).
type recDriver struct {
	core.Driver
	mu    sync.Mutex
	steps []flow.Step
}

func (r *recDriver) Execute(s flow.Step) *core.CommandResult {
	r.mu.Lock()
	r.steps = append(r.steps, s)
	r.mu.Unlock()
	return &core.CommandResult{Success: true}
}

func (r *recDriver) snapshot() []flow.Step {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]flow.Step(nil), r.steps...)
}

func TestMaestroDriverTapIsOnePercentTapOn(t *testing.T) {
	rec := &recDriver{}
	d := maestroDriver{Driver: rec, dir: t.TempDir()}
	if err := d.Tap(context.Background(), 0.5, 0.25); err != nil {
		t.Fatal(err)
	}
	steps := rec.snapshot()
	if len(steps) != 1 {
		t.Fatalf("%d step, muốn đúng 1", len(steps))
	}
	tap, ok := steps[0].(*flow.TapOnStep)
	if !ok || tap.Point != "50.0%,25.0%" {
		t.Fatalf("step = %#v, muốn tapOn point 50.0%%,25.0%%", steps[0])
	}
}

func TestMaestroDriverSwipeDefaultsDuration(t *testing.T) {
	rec := &recDriver{}
	d := maestroDriver{Driver: rec, dir: t.TempDir()}
	if err := d.Swipe(context.Background(), 0.1, 0.8, 0.1, 0.2, 0); err != nil {
		t.Fatal(err)
	}
	steps := rec.snapshot()
	sw, ok := steps[0].(*flow.SwipeStep)
	if len(steps) != 1 || !ok || sw.Duration != 400 || sw.Start != "10.0%,80.0%" || sw.End != "10.0%,20.0%" {
		t.Fatalf("step = %#v, muốn swipe 400ms", steps)
	}
}

// Toạ độ ngoài 0..1 không bị kiểm tra ở adapter: việc đó ở pool.Local, như trước.
func TestMaestroDriverDoesNotValidateRange(t *testing.T) {
	rec := &recDriver{}
	d := maestroDriver{Driver: rec, dir: t.TempDir()}
	if err := d.Tap(context.Background(), 1.5, -0.5); err != nil {
		t.Fatal(err)
	}
	if len(rec.snapshot()) != 1 {
		t.Fatal("adapter phải chuyển tiếp, không từ chối")
	}
}

func TestMaestroDriverMapsFailedStep(t *testing.T) {
	d := maestroDriver{Driver: failDriver{}, dir: t.TempDir()}
	err := d.Tap(context.Background(), 0.5, 0.5)
	if apperr.CodeOf(err) != CodeDriverFailed {
		t.Fatalf("err = %v, muốn %s", err, CodeDriverFailed)
	}
}

type failDriver struct{ core.Driver }

func (failDriver) Execute(flow.Step) *core.CommandResult {
	return &core.CommandResult{Success: false, Message: "không chạm được"}
}

// Pool bọc driver do CreateFunc trả và gắn ManualDir của engine, không bao giờ để trống.
func TestPoolWrapsCreatedDriverWithManualDir(t *testing.T) {
	p, _ := newTestPool()
	p.ManualDir = t.TempDir()
	err := p.Run(context.Background(), android1, func(_ context.Context, s Session) error {
		m, ok := s.Driver.(maestroDriver)
		if !ok {
			t.Fatalf("Session.Driver = %T, muốn maestroDriver", s.Driver)
		}
		if m.dir != p.ManualDir {
			t.Fatalf("dir = %q, muốn %q", m.dir, p.ManualDir)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestNewEngineSetsPoolManualDir(t *testing.T) {
	p, _ := newTestPool()
	e := NewEngine(t.TempDir(), p, nil, nil)
	if e.Pool.ManualDir == "" || e.Pool.ManualDir != e.RunsDir {
		t.Fatalf("ManualDir = %q, RunsDir = %q", e.Pool.ManualDir, e.RunsDir)
	}
}

func TestMaestroOfRejectsOtherDrivers(t *testing.T) {
	if _, err := maestroOf(webStub{}); apperr.CodeOf(err) != CodeDriverFailed {
		t.Fatalf("err = %v", err)
	}
	rec := &recDriver{}
	if d, err := maestroOf(maestroDriver{Driver: rec}); err != nil || d != core.Driver(rec) {
		t.Fatalf("maestroOf = %v, %v", d, err)
	}
}

type webStub struct{}

func (webStub) Screenshot() ([]byte, error)                                          { return nil, nil }
func (webStub) Hierarchy() ([]byte, error)                                           { return nil, nil }
func (webStub) Tap(context.Context, float64, float64) error                          { return nil }
func (webStub) Swipe(context.Context, float64, float64, float64, float64, int) error { return nil }

func TestEnsureRuntimeNilHome(t *testing.T) {
	e := &Engine{}
	if err := e.EnsureRuntime(context.Background(), android1); err != nil {
		t.Fatal(err)
	}
}
