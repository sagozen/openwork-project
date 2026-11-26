package testengine

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/devicelab-dev/maestro-runner/pkg/core"
	"github.com/devicelab-dev/maestro-runner/pkg/flow"

	"deskcore/apperr"
)

// slowDriver: mỗi bước mất delay, đủ để giành máy giữa hai bước.
type slowDriver struct {
	core.Driver
	delay time.Duration
}

func (d slowDriver) Execute(s flow.Step) *core.CommandResult {
	time.Sleep(d.delay)
	return d.Driver.Execute(s)
}

// eventLog ghi lại sự kiện của engine theo thứ tự.
type eventLog struct {
	mu   sync.Mutex
	evs  []Event
	hook func(Event)
}

func (l *eventLog) on(ev Event) {
	l.mu.Lock()
	l.evs = append(l.evs, ev)
	hook := l.hook
	l.mu.Unlock()
	if hook != nil {
		hook(ev)
	}
}

func (l *eventLog) count(kind string) int {
	l.mu.Lock()
	defer l.mu.Unlock()
	n := 0
	for _, ev := range l.evs {
		if ev.Kind == kind {
			n++
		}
	}
	return n
}

func (l *eventLog) kinds() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	var out []string
	for _, ev := range l.evs {
		out = append(out, ev.Kind)
	}
	return out
}

func TestTakeOverPausesRunAfterCurrentStepAndResumes(t *testing.T) {
	e, f := newTestEngine(t)
	f.wrap = func(_ string, d core.Driver) core.Driver { return slowDriver{d, 40 * time.Millisecond} }
	log := &eventLog{}
	e.OnEvent = log.on
	type result struct {
		paused bool
		err    error
	}
	took := make(chan result, 1)
	var once sync.Once
	log.hook = func(ev Event) {
		if ev.Kind == "step" {
			once.Do(func() {
				go func() {
					p, err := e.TakeOver(context.Background(), android1, 5*time.Second)
					took <- result{p, err}
				}()
			})
		}
	}
	done := make(chan *RunSummary, 1)
	start := time.Now()
	go func() {
		sum, err := e.Run(context.Background(), RunRequest{App: "demo", Devices: []Device{android1}, Secrets: []string{"PASSWORD"}})
		if err != nil {
			t.Error(err)
		}
		done <- sum
	}()

	r := <-took
	if r.err != nil || !r.paused {
		t.Fatalf("TakeOver = %+v, muốn lượt chạy tạm dừng", r)
	}
	if s := e.HoldState(android1.ID); s != HoldPaused {
		t.Fatalf("HoldState = %q", s)
	}
	steps := log.count("step")
	time.Sleep(150 * time.Millisecond)
	if n := log.count("step"); n != steps {
		t.Fatalf("lượt chạy vẫn chạy bước khi đang bị giữ: %d -> %d", steps, n)
	}
	var shot []byte
	held, err := e.WithHeld(android1.ID, func(d DeviceDriver) error {
		var err error
		shot, err = d.Screenshot()
		return err
	})
	if !held || err != nil || len(shot) == 0 {
		t.Fatalf("WithHeld = %v %v (%d byte)", held, err, len(shot))
	}
	if !e.HandBack(android1.ID) {
		t.Fatal("HandBack = false")
	}
	sum := <-done
	wall := time.Since(start)
	if len(sum.Flows) != 1 || !sum.Flows[0].Passed {
		t.Fatalf("flow = %+v, muốn đạt sau khi trả máy", sum.Flows)
	}
	if n := len(sum.Flows[0].Steps); n != 5 {
		t.Fatalf("%d bước, muốn đủ 5 (chạy tiếp từ bước sau)", n)
	}
	if d := sum.Flows[0].DurationMs; d > wall.Milliseconds()-140 {
		t.Fatalf("thời lượng flow %dms tính cả lúc bị giữ (tổng %v)", d, wall)
	}
	if log.count("takeover_paused") != 1 || log.count("takeover_resumed") != 1 {
		t.Fatalf("sự kiện = %v", log.kinds())
	}
	if s := e.HoldState(android1.ID); s != HoldNone {
		t.Fatalf("sau khi trả: HoldState = %q", s)
	}
}

func TestTakeOverIdleDeviceHoldsLockUntilHandBack(t *testing.T) {
	e, _ := newTestEngine(t)
	paused, err := e.TakeOver(context.Background(), android1, 2*time.Second)
	if err != nil || paused {
		t.Fatalf("TakeOver = %v %v", paused, err)
	}
	if s := e.HoldState(android1.ID); s != HoldIdle {
		t.Fatalf("HoldState = %q", s)
	}
	again, err := e.TakeOver(context.Background(), android1, time.Second) // giữ lại lần nữa: trả ngay
	if err != nil || again {
		t.Fatalf("TakeOver lần 2 = %v %v", again, err)
	}
	done := make(chan *RunSummary, 1)
	go func() {
		sum, _ := e.Run(context.Background(), RunRequest{App: "demo", Devices: []Device{android1}, Secrets: []string{"PASSWORD"}})
		done <- sum
	}()
	select {
	case <-done:
		t.Fatal("lượt chạy chen vào máy đang bị giữ")
	case <-time.After(150 * time.Millisecond):
	}
	if held, err := e.WithHeld(android1.ID, func(d DeviceDriver) error { _, err := d.Screenshot(); return err }); !held || err != nil {
		t.Fatalf("WithHeld = %v %v", held, err)
	}
	e.HandBack(android1.ID)
	select {
	case sum := <-done:
		if sum.Run.Passed != 1 {
			t.Fatalf("run = %+v", sum.Run)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("lượt chạy không bắt đầu sau khi trả máy")
	}
	if held, _ := e.WithHeld(android1.ID, func(DeviceDriver) error { return nil }); held {
		t.Fatal("WithHeld vẫn true sau khi trả máy")
	}
}

func TestStopAllReleasesHeldAndPausedDevices(t *testing.T) {
	e, f := newTestEngine(t)
	f.wrap = func(_ string, d core.Driver) core.Driver { return slowDriver{d, 30 * time.Millisecond} }
	dev2 := twoDevices[1]
	if _, err := e.TakeOver(context.Background(), android1, 2*time.Second); err != nil {
		t.Fatal(err)
	}
	log := &eventLog{}
	e.OnEvent = log.on
	took := make(chan error, 1)
	var once sync.Once
	log.hook = func(ev Event) {
		if ev.Kind == "step" && ev.DeviceID == dev2.ID {
			once.Do(func() {
				go func() {
					_, err := e.TakeOver(context.Background(), dev2, 5*time.Second)
					took <- err
				}()
			})
		}
	}
	done := make(chan *RunSummary, 1)
	go func() {
		sum, _ := e.Run(context.Background(), RunRequest{App: "demo", Devices: []Device{dev2}, Secrets: []string{"PASSWORD"}, Repeat: 3})
		done <- sum
	}()
	if err := <-took; err != nil {
		t.Fatal(err)
	}
	t0 := time.Now()
	e.StopAll(2 * time.Second)
	sum := <-done
	if time.Since(t0) > 3*time.Second {
		t.Fatalf("Dừng tất cả mất %v", time.Since(t0))
	}
	if !sum.Run.Canceled {
		t.Fatalf("run = %+v, muốn bị huỷ", sum.Run)
	}
	for _, d := range []Device{android1, dev2} {
		if s := e.HoldState(d.ID); s != HoldNone {
			t.Errorf("%s vẫn bị giữ: %q", d.ID, s)
		}
		if c, cl := f.counts(d.ID); c != cl {
			t.Errorf("%s: tạo %d dọn %d driver", d.ID, c, cl)
		}
	}
}

func TestTakeOverTimesOutWhenStepNeverEnds(t *testing.T) {
	e, _ := newTestEngine(t)
	started := make(chan struct{})
	e.Execute = blockingExecute(started) // một bước dài, không có ranh giới bước nào
	done := make(chan struct{})
	go func() {
		_, _ = e.Run(context.Background(), RunRequest{App: "demo", Devices: []Device{android1}, Secrets: []string{"PASSWORD"}})
		close(done)
	}()
	<-started
	_, err := e.TakeOver(context.Background(), android1, 100*time.Millisecond)
	if apperr.CodeOf(err) != CodeTakeoverTimeout {
		t.Fatalf("err = %v, muốn %s", err, CodeTakeoverTimeout)
	}
	if s := e.HoldState(android1.ID); s != HoldNone {
		t.Fatalf("hết giờ chờ mà vẫn giữ: %q", s)
	}
	e.StopAll(time.Second)
	<-done
}

func TestPeekReadsBusyDeviceWithoutWaitingForLock(t *testing.T) {
	p, f := newTestPool()
	inside, leave := make(chan struct{}), make(chan struct{})
	go func() {
		_ = p.Run(context.Background(), android1, func(context.Context, Session) error {
			close(inside)
			<-leave
			return nil
		})
	}()
	<-inside
	t0 := time.Now()
	busy, err := p.Peek(context.Background(), android1, false, func(d DeviceDriver) error { _, err := d.Screenshot(); return err })
	if !busy || err != nil {
		t.Fatalf("Peek máy bận = %v %v", busy, err)
	}
	if time.Since(t0) > 100*time.Millisecond {
		t.Fatalf("Peek chờ khoá %v", time.Since(t0))
	}
	close(leave)

	idle := Device{ID: "emu-9", Platform: PlatformAndroid, Driver: "devicelab"}
	shot := func(d DeviceDriver) error { _, err := d.Screenshot(); return err }
	if _, err := p.Peek(context.Background(), idle, false, shot); !errors.Is(err, ErrNoWarmDriver) {
		t.Fatalf("Peek máy lạnh không được phép tạo driver: %v", err)
	}
	if c, _ := f.counts(idle.ID); c != 0 {
		t.Fatalf("lưới tự tạo %d driver cho máy lạnh", c)
	}
	busy, err = p.Peek(context.Background(), idle, true, shot)
	if busy || err != nil {
		t.Fatalf("Peek máy rảnh = %v %v", busy, err)
	}
	if c, _ := f.counts(idle.ID); c != 1 {
		t.Fatalf("máy rảnh: tạo %d driver, muốn 1 (driver ấm cho lần sau)", c)
	}
	if h := health(p, idle.ID); h != HealthWarm {
		t.Fatalf("health = %q", h)
	}
	// Đọc của live view không tính là dùng: driver vẫn bị dọn khi rảnh lâu.
	p.Idle = 50 * time.Millisecond
	time.Sleep(80 * time.Millisecond)
	if _, err := p.Peek(context.Background(), idle, false, shot); err != nil {
		t.Fatal(err)
	}
	p.ReapIdle()
	if h := health(p, idle.ID); h != HealthCold {
		t.Fatalf("health = %q: lần đọc của live view không được giữ driver ấm mãi", h)
	}
}

func TestPausedTimeDoesNotCountTowardFlowTimeout(t *testing.T) {
	e, f := newTestEngine(t)
	f.wrap = func(_ string, d core.Driver) core.Driver { return slowDriver{d, 20 * time.Millisecond} }
	log := &eventLog{}
	e.OnEvent = log.on
	var once sync.Once
	took := make(chan error, 1)
	log.hook = func(ev Event) {
		if ev.Kind == "step" {
			once.Do(func() {
				go func() {
					_, err := e.TakeOver(context.Background(), android1, 5*time.Second)
					took <- err
				}()
			})
		}
	}
	done := make(chan *RunSummary, 1)
	go func() {
		sum, _ := e.Run(context.Background(), RunRequest{App: "demo", Devices: []Device{android1}, Secrets: []string{"PASSWORD"}, Timeout: 400 * time.Millisecond})
		done <- sum
	}()
	if err := <-took; err != nil {
		t.Fatal(err)
	}
	time.Sleep(700 * time.Millisecond) // giữ máy lâu hơn hạn của flow
	if s := e.HoldState(android1.ID); s != HoldPaused {
		t.Fatalf("hết hạn flow trong lúc giữ máy mà mất quyền điều khiển: %q", s)
	}
	e.HandBack(android1.ID)
	sum := <-done
	if len(sum.Flows) != 1 || !sum.Flows[0].Passed {
		t.Fatalf("flow = %+v, muốn đạt (thời gian giữ máy không tính vào hạn)", sum.Flows)
	}
}

func TestFlowTimeoutStillApplies(t *testing.T) {
	e, f := newTestEngine(t)
	f.wrap = func(_ string, d core.Driver) core.Driver { return slowDriver{d, 100 * time.Millisecond} }
	e.HungGrace = 2 * time.Second // bước đang chạy xong rồi flow mới thấy quá hạn, không phải lệnh treo
	sum, _ := e.Run(context.Background(), RunRequest{App: "demo", Devices: []Device{android1}, Secrets: []string{"PASSWORD"}, Timeout: 150 * time.Millisecond})
	if len(sum.Flows) != 1 || sum.Flows[0].Passed || !strings.Contains(sum.Flows[0].Error, "quá hạn") {
		t.Fatalf("flow = %+v, muốn quá hạn", sum.Flows)
	}
}

func TestAppSecretsAreNotFlowSecrets(t *testing.T) {
	e, _ := newTestEngine(t)
	if err := e.Secrets.Set("WEBHOOK_W_ABC", "khoa-ky"); err != nil {
		t.Fatal(err)
	}
	names, _ := FlowSecretNames(e.Secrets)
	for _, n := range names {
		if IsReservedSecret(n) {
			t.Fatalf("khoá của app lẫn vào biến của flow: %v", names)
		}
	}
	if _, err := e.Run(context.Background(), RunRequest{App: "demo", Devices: []Device{android1}, Secrets: []string{"WEBHOOK_W_ABC"}}); apperr.CodeOf(err) != CodeSecretMissing {
		t.Fatalf("flow lấy được khoá ký webhook: %v", err)
	}
}
