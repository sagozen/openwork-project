package testengine

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/devicelab-dev/maestro-runner/pkg/cli"
	"github.com/devicelab-dev/maestro-runner/pkg/core"
	"github.com/devicelab-dev/maestro-runner/pkg/driver/mock"

	"deskcore/apperr"
)

type fakeFactory struct {
	mu       sync.Mutex
	created  map[string]int
	cleaned  map[string]int
	failNext bool
	wrap     func(id string, d core.Driver) core.Driver // thay hành vi driver (chết, cây UI riêng...)
}

// probeDriver: driver mock có cây UI tuỳ chỉnh, hoặc "chết" (cây UI lỗi) khi dead bật.
type probeDriver struct {
	core.Driver
	dead *atomic.Bool
	tree string
}

func (d probeDriver) Hierarchy() ([]byte, error) {
	if d.dead != nil && d.dead.Load() {
		return nil, errors.New("agent không phản hồi")
	}
	if d.tree != "" {
		return []byte(d.tree), nil
	}
	return d.Driver.Hierarchy()
}

func (f *fakeFactory) create(cfg *cli.RunConfig) (core.Driver, func(), error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	id := cfg.Devices[0]
	if f.failNext {
		f.failNext = false
		return nil, nil, errors.New("agent không khởi động")
	}
	f.created[id]++
	var drv core.Driver = mock.New(mock.Config{Platform: cfg.Platform, DeviceID: id})
	if f.wrap != nil {
		drv = f.wrap(id, drv)
	}
	return drv, func() {
		f.mu.Lock()
		f.cleaned[id]++
		f.mu.Unlock()
	}, nil
}

func (f *fakeFactory) counts(id string) (int, int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.created[id], f.cleaned[id]
}

func newTestPool() (*Pool, *fakeFactory) {
	f := &fakeFactory{created: map[string]int{}, cleaned: map[string]int{}}
	p := NewPool()
	p.Create = f.create
	return p, f
}

var android1 = Device{ID: "emu-1", Platform: PlatformAndroid, Driver: "devicelab"}

func noop(context.Context, Session) error { return nil }

func health(p *Pool, id string) string {
	for _, s := range p.States() {
		if s.Device.ID == id {
			return s.Health
		}
	}
	return ""
}

func TestPoolReusesWarmDriver(t *testing.T) {
	p, f := newTestPool()
	var cold []bool
	for i := 0; i < 3; i++ {
		if err := p.Run(context.Background(), android1, func(_ context.Context, s Session) error { cold = append(cold, s.Cold); return nil }); err != nil {
			t.Fatal(err)
		}
	}
	if !cold[0] || cold[1] || cold[2] {
		t.Fatalf("cold = %v, muốn chỉ lượt đầu lạnh", cold)
	}
	if c, _ := f.counts(android1.ID); c != 1 {
		t.Fatalf("tạo driver %d lần, muốn 1 (driver ấm dùng lại)", c)
	}
	if h := health(p, android1.ID); h != HealthWarm {
		t.Fatalf("health = %s", h)
	}
}

func TestPoolPanicDiscardsDriverAndRecreatesOnce(t *testing.T) {
	p, f := newTestPool()
	err := p.Run(context.Background(), android1, func(context.Context, Session) error { panic("boom") })
	if apperr.CodeOf(err) != CodeDriverFailed {
		t.Fatalf("err = %v", err)
	}
	if c, cl := f.counts(android1.ID); c != 1 || cl != 1 {
		t.Fatalf("created=%d cleaned=%d, muốn 1/1", c, cl)
	}
	if h := health(p, android1.ID); h != HealthUnhealthy {
		t.Fatalf("health = %s, muốn unhealthy", h)
	}
	if err := p.Run(context.Background(), android1, noop); err != nil {
		t.Fatal(err)
	}
	if c, _ := f.counts(android1.ID); c != 2 {
		t.Fatalf("lượt sau phải tạo lại driver: created=%d", c)
	}
	if h := health(p, android1.ID); h != HealthWarm {
		t.Fatalf("health = %s", h)
	}
}

func TestPoolDiscardsOnBrokenOrDeadline(t *testing.T) {
	p, f := newTestPool()
	broken := fmt.Errorf("mất agent: %w", ErrDriverBroken)
	if err := p.Run(context.Background(), android1, func(context.Context, Session) error { return broken }); !errors.Is(err, ErrDriverBroken) {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	_ = p.Run(ctx, android1, func(ctx context.Context, _ Session) error { <-ctx.Done(); return ctx.Err() })
	if _, cl := f.counts(android1.ID); cl != 2 {
		t.Fatalf("cleaned=%d, muốn 2 (lỗi driver + quá hạn)", cl)
	}
	// Lỗi của flow (không phải driver) giữ driver ấm.
	_ = p.Run(context.Background(), android1, func(context.Context, Session) error { return errors.New("assert thất bại") })
	if _, cl := f.counts(android1.ID); cl != 2 {
		t.Fatalf("lỗi flow không được dọn driver: cleaned=%d", cl)
	}
}

func TestPoolCreateFailureMarksUnhealthy(t *testing.T) {
	p, f := newTestPool()
	f.failNext = true
	if err := p.Run(context.Background(), android1, noop); apperr.CodeOf(err) != CodeDriverFailed {
		t.Fatalf("err = %v", err)
	}
	if h := health(p, android1.ID); h != HealthUnhealthy {
		t.Fatalf("health = %s", h)
	}
	if err := p.Run(context.Background(), android1, noop); err != nil {
		t.Fatal(err)
	}
}

func TestPoolOneRunPerDeviceParallelAcrossDevices(t *testing.T) {
	p, _ := newTestPool()
	var perDevice [2]int32
	var maxSeen [2]int32
	var wg sync.WaitGroup
	devs := []Device{android1, {ID: "emu-2", Platform: PlatformAndroid, Driver: "uiautomator2"}}
	var overlap atomic.Bool
	var both sync.WaitGroup
	both.Add(2)
	for i := 0; i < 6; i++ {
		idx := i % 2
		wg.Add(1)
		go func(first bool) {
			defer wg.Done()
			_ = p.Run(context.Background(), devs[idx], func(context.Context, Session) error {
				n := atomic.AddInt32(&perDevice[idx], 1)
				if n > atomic.LoadInt32(&maxSeen[idx]) {
					atomic.StoreInt32(&maxSeen[idx], n)
				}
				if first { // hai thiết bị phải cùng lúc ở trong vùng chạy
					both.Done()
					done := make(chan struct{})
					go func() { both.Wait(); close(done) }()
					select {
					case <-done:
						overlap.Store(true)
					case <-time.After(2 * time.Second):
					}
				}
				time.Sleep(5 * time.Millisecond)
				atomic.AddInt32(&perDevice[idx], -1)
				return nil
			})
		}(i < 2)
	}
	wg.Wait()
	if maxSeen[0] != 1 || maxSeen[1] != 1 {
		t.Fatalf("một thiết bị chạy nhiều việc cùng lúc: %v", maxSeen)
	}
	if !overlap.Load() {
		t.Fatal("hai thiết bị khác nhau phải chạy song song")
	}
}

func TestPoolAcquireHonoursContext(t *testing.T) {
	p, _ := newTestPool()
	hold := make(chan struct{})
	started := make(chan struct{})
	go p.Run(context.Background(), android1, func(context.Context, Session) error { close(started); <-hold; return nil })
	<-started
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if err := p.Run(ctx, android1, noop); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v, muốn hết hạn khi chờ khoá", err)
	}
	close(hold)
}

func TestPoolConfigChangeRecreatesDriver(t *testing.T) {
	p, f := newTestPool()
	_ = p.Run(context.Background(), android1, noop)
	other := android1
	other.Driver = "uiautomator2"
	_ = p.Run(context.Background(), other, noop)
	if c, cl := f.counts(android1.ID); c != 2 || cl != 1 {
		t.Fatalf("created=%d cleaned=%d, muốn 2/1", c, cl)
	}
}

func TestPoolReapIdle(t *testing.T) {
	p, f := newTestPool()
	now := time.Now()
	p.now = func() time.Time { return now }
	_ = p.Run(context.Background(), android1, noop)
	now = now.Add(9 * time.Minute)
	if n := p.ReapIdle(); n != 0 {
		t.Fatalf("dọn sớm %d driver", n)
	}
	now = now.Add(2 * time.Minute)
	if n := p.ReapIdle(); n != 1 {
		t.Fatalf("dọn %d driver, muốn 1", n)
	}
	if _, cl := f.counts(android1.ID); cl != 1 || health(p, android1.ID) != HealthCold {
		t.Fatalf("cleaned=%d health=%s", cl, health(p, android1.ID))
	}
}

func TestPoolCloseAllCleansEvenWhenRunHangs(t *testing.T) {
	p, f := newTestPool()
	ios := Device{ID: "sim-1", Platform: PlatformIOS, Driver: "devicelab"}
	_ = p.Run(context.Background(), ios, noop)
	hang := make(chan struct{})
	started := make(chan struct{})
	go p.Run(context.Background(), android1, func(context.Context, Session) error { close(started); <-hang; return nil })
	<-started

	start := time.Now()
	p.CloseAll(50 * time.Millisecond)
	if time.Since(start) > time.Second {
		t.Fatal("CloseAll bị lệnh treo giữ lại")
	}
	for _, id := range []string{ios.ID, android1.ID} {
		if _, cl := f.counts(id); cl != 1 {
			t.Fatalf("%s cleaned=%d, muốn 1", id, cl)
		}
	}
	if err := p.Run(context.Background(), ios, noop); apperr.CodeOf(err) != CodeDeviceNotReady {
		t.Fatalf("sau CloseAll phải từ chối lượt mới: %v", err)
	}
	close(hang)
	p.Reopen()
	if err := p.Run(context.Background(), ios, noop); err != nil {
		t.Fatal(err)
	}
}

func TestPoolRejectsImplicitPlatformOrDriver(t *testing.T) {
	p, f := newTestPool()
	for _, d := range []Device{
		{ID: "x", Platform: "", Driver: "devicelab"},
		{ID: "x", Platform: PlatformAndroid, Driver: ""},
		{ID: "x", Platform: PlatformAndroid, Driver: "wda"},
		{ID: "", Platform: PlatformIOS, Driver: "wda"},
	} {
		if err := p.Run(context.Background(), d, noop); apperr.CodeOf(err) != apperr.CodeInvalid {
			t.Errorf("%+v: err = %v", d, err)
		}
	}
	if len(f.created) != 0 {
		t.Fatal("cấu hình sai không được tạo driver")
	}
}

func TestPoolPeekDoesNotShowDeviceBusy(t *testing.T) {
	p, _ := newTestPool()
	if err := p.Run(context.Background(), android1, noop); err != nil {
		t.Fatal(err)
	}
	// Lưới trực tiếp đang chụp máy rảnh: đội máy vẫn phải thấy máy sẵn sàng, không thì điều phối bị từ chối "busy".
	var during string
	busy, err := p.Peek(context.Background(), android1, false, func(DeviceDriver) error {
		during = p.States()[0].Health
		return nil
	})
	if err != nil || busy {
		t.Fatalf("peek: busy=%v err=%v", busy, err)
	}
	if during != HealthWarm {
		t.Fatalf("trong lúc chụp khung hình health=%s, muốn %s", during, HealthWarm)
	}
}
