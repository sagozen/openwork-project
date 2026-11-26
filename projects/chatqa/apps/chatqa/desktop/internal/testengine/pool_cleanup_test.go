package testengine

import (
	"context"
	"testing"
	"time"
)

var webA = Device{ID: "web-a", Platform: PlatformWeb, Driver: DriverPlaywright, Rev: "r1"}

// hangingCleanupPool: pool có thiết bị web mà hàm dọn treo tới 5 s (sidecar không trả lời close).
// started nhận tín hiệu khi một hàm dọn bắt đầu chạy; release cho mọi hàm dọn đang treo chạy tiếp.
func hangingCleanupPool(t *testing.T) (p *Pool, started chan struct{}, release func()) {
	t.Helper()
	p, _ = newTestPool()
	started = make(chan struct{}, 8)
	stop := make(chan struct{})
	p.OpenWeb = func(context.Context, Device) (DeviceDriver, func(), error) {
		return webStub{}, func() {
			started <- struct{}{}
			select {
			case <-stop:
			case <-time.After(5 * time.Second):
			}
		}, nil
	}
	var closed bool
	release = func() {
		if !closed {
			closed = true
			close(stop)
		}
	}
	t.Cleanup(release)
	return p, started, release
}

// statesFast: States() không bị hàm dọn đang treo chặn quá 100 ms.
func statesFast(t *testing.T, p *Pool, where string) {
	t.Helper()
	start := time.Now()
	_ = p.States()
	if d := time.Since(start); d > 100*time.Millisecond {
		t.Fatalf("%s: States() bị chặn %v trong lúc dọn driver", where, d)
	}
}

func waitStarted(t *testing.T, started chan struct{}) {
	t.Helper()
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("hàm dọn không chạy")
	}
}

func TestHangingCleanupDoesNotBlockStatesInReapIdle(t *testing.T) {
	p, started, release := hangingCleanupPool(t)
	now := time.Now()
	p.now = func() time.Time { return now }
	if err := p.Run(context.Background(), webA, noop); err != nil {
		t.Fatal(err)
	}
	now = now.Add(11 * time.Minute)
	done := make(chan int, 1)
	go func() { done <- p.ReapIdle() }()
	waitStarted(t, started)
	statesFast(t, p, "ReapIdle")
	release()
	if n := <-done; n != 1 {
		t.Fatalf("ReapIdle = %d, muốn 1", n)
	}
	if h := health(p, webA.ID); h != HealthCold {
		t.Fatalf("health = %s", h)
	}
}

func TestHangingCleanupDoesNotBlockStatesInCloseAll(t *testing.T) {
	p, started, release := hangingCleanupPool(t)
	if err := p.Run(context.Background(), webA, noop); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() { p.CloseAll(time.Second); close(done) }()
	waitStarted(t, started)
	statesFast(t, p, "CloseAll")
	release()
	<-done
}

func TestHangingCleanupDoesNotBlockStatesOnRevChange(t *testing.T) {
	p, started, release := hangingCleanupPool(t)
	if err := p.Run(context.Background(), webA, noop); err != nil {
		t.Fatal(err)
	}
	edited := webA
	edited.Rev = "r2"
	ran := make(chan struct{})
	go func() {
		_ = p.Run(context.Background(), edited, func(context.Context, Session) error { close(ran); return nil })
	}()
	waitStarted(t, started)
	statesFast(t, p, "đổi Rev")
	select {
	case <-ran:
		t.Fatal("lượt mới chạy trước khi driver cũ dọn xong")
	default:
	}
	release()
	select {
	case <-ran:
	case <-time.After(2 * time.Second):
		t.Fatal("lượt mới không chạy sau khi dọn xong")
	}
}

func TestDiscardWhereSkipsCleanupAndKeepsOthers(t *testing.T) {
	p, f := newTestPool()
	cleaned := 0
	p.OpenWeb = func(context.Context, Device) (DeviceDriver, func(), error) {
		return webStub{}, func() { cleaned++ }, nil
	}
	for _, d := range []Device{webA, android1} {
		if err := p.Run(context.Background(), d, noop); err != nil {
			t.Fatal(err)
		}
	}
	if n := p.DiscardWhere(func(d Device) bool { return d.Driver == DriverPlaywright }); n != 1 {
		t.Fatalf("DiscardWhere = %d, muốn 1", n)
	}
	if cleaned != 0 {
		t.Fatal("DiscardWhere không được chạy hàm dọn của phiên đã chết")
	}
	if h := health(p, webA.ID); h != HealthCold {
		t.Fatalf("web health = %s", h)
	}
	if h := health(p, android1.ID); h != HealthWarm {
		t.Fatalf("android health = %s", h)
	}
	if _, cl := f.counts(android1.ID); cl != 0 {
		t.Fatal("thiết bị điện thoại bị dọn")
	}
}
