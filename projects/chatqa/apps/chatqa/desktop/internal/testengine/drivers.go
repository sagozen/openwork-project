package testengine

import (
	"context"
	"errors"
	"fmt"
	"log"
	"sort"
	"sync"
	"time"

	"github.com/devicelab-dev/maestro-runner/pkg/cli"
	"github.com/devicelab-dev/maestro-runner/pkg/core"

	"deskcore/apperr"
)

// Mã lỗi của engine (câu tiếng Việt ở contracts/errors.json).
const (
	CodeDriverBundleUnavailable = "driver_bundle_unavailable"
	CodeDeviceToolMissing       = "device_tool_missing"
	CodeDeviceNotReady          = "device_not_ready"
	CodeIOSTeamIDMissing        = "ios_team_id_missing"
	CodeDriverFailed            = "driver_failed"
)

// ErrDriverBroken: hàm chạy trả lỗi bọc lỗi này khi driver hỏng (mất kết nối agent, phiên chết),
// để pool dọn driver và tạo lại ở lượt sau thay vì dùng tiếp.
var ErrDriverBroken = errors.New("driver broken")

// Device: một thiết bị cục bộ và cách điều khiển nó. Platform và Driver luôn tường minh, không để trống.
type Device struct {
	ID       string // serial adb, UDID iOS hoặc mã hồ sơ trình duyệt
	Platform string // android | ios | web
	Driver   string // devicelab | uiautomator2 | wda | playwright
	TeamID   string // Apple Team ID, chỉ iPhone thật
	// Rev: dấu cấu hình của hồ sơ trình duyệt (trống với điện thoại). Đổi dấu thì pool mở lại phiên.
	Rev string `json:"rev,omitempty"`
}

// Health của driver trên một thiết bị.
const (
	HealthCold      = "cold"      // chưa có driver
	HealthWarm      = "warm"      // driver sẵn sàng dùng lại
	HealthBusy      = "busy"      // đang chạy
	HealthUnhealthy = "unhealthy" // lượt trước hỏng; tạo lại driver ở lượt sau
)

// DeviceState: trạng thái pool của một thiết bị (đọc cho tower, live view).
type DeviceState struct {
	Device   Device    `json:"device"`
	Health   string    `json:"health"`
	LastUsed time.Time `json:"lastUsed"`
	LastErr  string    `json:"lastError,omitempty"`
}

// Session: driver được giao cho một lượt chạy. Cold = driver vừa tạo trong lượt này (StartMs là thời gian tạo).
type Session struct {
	Driver  DeviceDriver
	Cold    bool
	StartMs int64
}

// CreateFunc tạo driver cho thiết bị; mặc định cli.CreateDriver. Test thay bằng driver mock.
type CreateFunc func(cfg *cli.RunConfig) (core.Driver, func(), error)

type entry struct {
	dev       Device
	lock      chan struct{} // khoá theo thiết bị, chờ được theo context
	drv       DeviceDriver
	cleanup   func()
	lastUsed  time.Time
	busy      bool
	peeking   bool // khoá đang giữ chỉ để đọc khung hình (live view): vẫn chặn dọn driver, nhưng không báo máy bận
	unhealthy bool
	lastErr   string
	// frames: nguồn khung hình của việc đang giữ khoá mà không chạy trên driver của pool (flow web chạy trong tiến
	// trình test riêng). Có nguồn này thì live view đọc từ nó thay vì driver ấm.
	frames func() ([]byte, error)
}

// Pool giữ một driver ấm cho mỗi thiết bị. Một thiết bị chạy một việc một lúc (khoá theo thiết bị);
// các thiết bị khác chạy song song. Tower và live view dùng chung pool và khoá này, nên chụp màn hình
// hay chạm không tranh thiết bị với flow đang chạy.
type Pool struct {
	Create CreateFunc
	// OpenWeb mở driver trình duyệt cho thiết bị DriverPlaywright; nil thì thiết bị web không tạo được driver.
	OpenWeb func(ctx context.Context, dev Device) (DeviceDriver, func(), error)
	// ManualDir: thư mục giả cho flow.Parse của lệnh tay (chạm, vuốt); NewEngine đặt bằng RunsDir.
	ManualDir string
	Idle      time.Duration // driver rảnh quá lâu thì dọn; mặc định 10 phút
	now       func() time.Time

	mu      sync.Mutex
	entries map[string]*entry
	closed  bool
}

func NewPool() *Pool {
	return &Pool{Create: cli.CreateDriver, Idle: 10 * time.Minute, now: time.Now, entries: map[string]*entry{}}
}

// Run giữ khoá thiết bị, bảo đảm có driver (tạo nếu chưa có, hỏng hoặc đổi cấu hình) rồi gọi fn.
// Panic trong fn được bắt; panic, lỗi ErrDriverBroken hoặc quá hạn (deadline) đều dọn driver và đánh
// dấu thiết bị unhealthy, lượt sau tạo lại driver một lần.
func (p *Pool) Run(ctx context.Context, dev Device, fn func(ctx context.Context, s Session) error) (err error) {
	e, err := p.acquire(ctx, dev)
	if err != nil {
		return err
	}
	return p.runEntry(ctx, e, fn)
}

// runEntry chạy fn trên thiết bị đã giữ khoá, nhả khoá khi xong.
func (p *Pool) runEntry(ctx context.Context, e *entry, fn func(ctx context.Context, s Session) error) (err error) {
	defer p.release(e)
	dev := e.dev
	sess, err := p.ensureDriver(ctx, e)
	if err != nil {
		return err
	}

	defer func() {
		if r := recover(); r != nil {
			err = apperr.New(CodeDriverFailed, fmt.Sprintf("panic: %v", r))
			log.Printf("testengine: panic khi chạy trên %s: %v", dev.ID, r)
		}
		if err != nil && (apperr.CodeOf(err) == CodeDriverFailed || errors.Is(err, ErrDriverBroken) ||
			errors.Is(ctx.Err(), context.DeadlineExceeded)) {
			p.discard(e, err)
		}
	}()
	return fn(ctx, sess)
}

// LockForRun giữ khoá thiết bị cho một lượt chạy không dùng driver của pool (flow web chạy trong tiến trình
// playwright test riêng): bỏ phiên ấm của thiết bị trước (dọn sau khi nhả p.mu, vẫn giữ khoá thiết bị), đăng ký frames
// làm nguồn khung hình của live view trong lúc fn chạy, rồi nhả khoá. Thiết bị chạy xong không còn driver ấm.
func (p *Pool) LockForRun(ctx context.Context, dev Device, frames func() ([]byte, error), fn func(ctx context.Context) error) error {
	e, err := p.acquire(ctx, dev)
	if err != nil {
		return err
	}
	p.mu.Lock()
	stale := p.detachLocked(e)
	e.frames = frames
	p.mu.Unlock()
	runCleanup(dev.ID, stale)
	defer func() {
		p.mu.Lock()
		e.frames = nil
		p.mu.Unlock()
		p.release(e)
	}()
	return fn(ctx)
}

// frameDriver: DeviceDriver chỉ đọc khung hình từ nguồn của lượt chạy (live view); lệnh khác bị từ chối.
type frameDriver struct{ frames func() ([]byte, error) }

func (f frameDriver) Screenshot() ([]byte, error) { return f.frames() }

func (frameDriver) Hierarchy() ([]byte, error) {
	return nil, apperr.New(CodeDeviceNotReady, "thiết bị đang chạy flow")
}

func (frameDriver) Tap(context.Context, float64, float64) error {
	return apperr.New(CodeDeviceNotReady, "thiết bị đang chạy flow")
}

func (frameDriver) Swipe(context.Context, float64, float64, float64, float64, int) error {
	return apperr.New(CodeDeviceNotReady, "thiết bị đang chạy flow")
}

// Lock giữ khoá thiết bị cho việc không cần driver (cài app, lệnh adb), để không tranh thiết bị với flow đang chạy.
func (p *Pool) Lock(ctx context.Context, dev Device, fn func(ctx context.Context) error) error {
	e, err := p.acquire(ctx, dev)
	if err != nil {
		return err
	}
	defer p.release(e)
	return fn(ctx)
}

// Peek chạy fn chỉ đọc (chụp màn hình cho live view) trên driver ấm của thiết bị, không làm chậm việc đang chạy:
// thiết bị đang bận thì gọi thẳng trên driver của việc đó, không chờ khoá (client của driver là HTTP, gọi song song
// được), busy = true; driver đang được tạo thì trả ErrPeekBusy. Việc đang chạy có nguồn khung hình riêng (LockForRun)
// thì đọc từ nguồn đó, kể cả khi thiết bị còn driver. Thiết bị rảnh thì giữ khoá trong lúc đọc; chưa có driver
// ấm thì chỉ tạo khi create = true (máy đang phóng to), không thì trả ErrNoWarmDriver. Đọc không tính là "dùng", nên
// driver vẫn bị dọn khi rảnh lâu dù lưới đang mở.
func (p *Pool) Peek(ctx context.Context, dev Device, create bool, fn func(drv DeviceDriver) error) (busy bool, err error) {
	if err := ValidateDevice(dev); err != nil {
		return false, err
	}
	for range 2 {
		p.mu.Lock()
		e := p.entries[dev.ID]
		var drv DeviceDriver
		var frames func() ([]byte, error)
		inUse := e != nil && e.busy
		if inUse {
			drv, frames = e.drv, e.frames
		}
		p.mu.Unlock()
		if inUse {
			if frames != nil {
				return true, safeRead(dev.ID, frameDriver{frames}, fn)
			}
			if drv == nil {
				return true, ErrPeekBusy
			}
			return true, safeRead(dev.ID, drv, fn)
		}
		e, ok, err := p.tryAcquire(dev)
		if err != nil {
			return false, err
		}
		if ok {
			p.mu.Lock()
			drv := e.drv
			e.peeking = drv != nil || !create
			p.mu.Unlock()
			if drv == nil && create {
				return false, p.runEntry(ctx, e, func(_ context.Context, s Session) error { return fn(s.Driver) })
			}
			defer p.unlockQuiet(e)
			if drv == nil {
				return false, ErrNoWarmDriver
			}
			return false, safeRead(dev.ID, drv, fn)
		}
		// vừa có việc khác giữ khoá: lần lặp sau đọc trên driver của việc đó
	}
	return true, ErrPeekBusy
}

// ErrNoWarmDriver: thiết bị rảnh nhưng chưa có driver ấm, và lần đọc này không được phép tạo driver.
var ErrNoWarmDriver = errors.New("chưa có driver ấm")

// unlockQuiet nhả khoá mà không đổi lastUsed (lần đọc của live view không giữ driver ấm mãi).
func (p *Pool) unlockQuiet(e *entry) {
	p.mu.Lock()
	e.busy, e.peeking = false, false
	p.mu.Unlock()
	<-e.lock
}

// ErrPeekBusy: thiết bị đang bận và chưa có driver để đọc (đang khởi động driver); bỏ qua khung hình này.
var ErrPeekBusy = errors.New("thiết bị đang bận, chưa có driver để đọc")

func safeRead(id string, drv DeviceDriver, fn func(DeviceDriver) error) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = apperr.New(CodeDriverFailed, fmt.Sprintf("panic: %v", r))
			log.Printf("testengine: panic khi đọc %s: %v", id, r)
		}
	}()
	return fn(drv)
}

// tryAcquire giữ khoá nếu thiết bị đang rảnh, không chờ; ok = false nếu đang có việc giữ khoá.
func (p *Pool) tryAcquire(dev Device) (*entry, bool, error) {
	e, err := p.lockEntry(context.Background(), dev, true)
	if errors.Is(err, errLockBusy) {
		return nil, false, nil
	}
	return e, err == nil, err
}

func (p *Pool) acquire(ctx context.Context, dev Device) (*entry, error) {
	return p.lockEntry(ctx, dev, false)
}

var errLockBusy = errors.New("khoá thiết bị đang bận")

// lockEntry giữ khoá thiết bị; try = true thì không chờ (trả errLockBusy nếu đang có việc giữ khoá).
func (p *Pool) lockEntry(ctx context.Context, dev Device, try bool) (*entry, error) {
	if err := ValidateDevice(dev); err != nil {
		return nil, err
	}
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return nil, apperr.New(CodeDeviceNotReady, "đang đóng ứng dụng")
	}
	e := p.entries[dev.ID]
	if e == nil {
		e = &entry{dev: dev, lock: make(chan struct{}, 1)}
		p.entries[dev.ID] = e
	}
	p.mu.Unlock()

	if try {
		select {
		case e.lock <- struct{}{}:
		default:
			return nil, errLockBusy
		}
	} else {
		select {
		case e.lock <- struct{}{}:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		<-e.lock
		return nil, apperr.New(CodeDeviceNotReady, "đang đóng ứng dụng")
	}
	var stale func()
	if e.drv != nil && e.dev != dev { // đổi driver, Team ID hoặc cấu hình hồ sơ: bỏ driver cũ
		stale = p.detachLocked(e)
	}
	e.dev = dev
	e.busy = true
	p.mu.Unlock()
	// Dọn ngoài p.mu nhưng vẫn giữ khoá thiết bị: xong trước khi lượt này tạo driver mới.
	runCleanup(dev.ID, stale)
	return e, nil
}

func (p *Pool) release(e *entry) {
	p.mu.Lock()
	e.busy = false
	e.lastUsed = p.now()
	p.mu.Unlock()
	<-e.lock
}

func (p *Pool) ensureDriver(ctx context.Context, e *entry) (Session, error) {
	p.mu.Lock()
	drv, dev := e.drv, e.dev
	p.mu.Unlock()
	if drv != nil {
		return Session{Driver: drv}, nil
	}
	// Tạo driver ngoài p.mu: có thể mất vài giây (cài agent, ký iOS).
	start := p.now()
	drv, cleanup, err := p.open(ctx, dev)
	p.mu.Lock()
	defer p.mu.Unlock()
	if err != nil {
		e.unhealthy = true
		e.lastErr = err.Error()
		return Session{}, apperr.Wrap(CodeDriverFailed, err)
	}
	e.drv, e.cleanup, e.unhealthy, e.lastErr = drv, cleanup, false, ""
	return Session{Driver: drv, Cold: true, StartMs: p.now().Sub(start).Milliseconds()}, nil
}

// open tạo driver theo loại thiết bị: trình duyệt qua OpenWeb, điện thoại qua Create bọc thành maestroDriver.
func (p *Pool) open(ctx context.Context, dev Device) (drv DeviceDriver, cleanup func(), err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("panic khi tạo driver: %v", r)
		}
	}()
	if dev.Driver == DriverPlaywright {
		if p.OpenWeb == nil {
			return nil, nil, apperr.New(CodeDeviceNotReady, dev.ID+": chưa có runtime web")
		}
		return p.OpenWeb(ctx, dev)
	}
	cfg := &cli.RunConfig{Platform: dev.Platform, Driver: dev.Driver, Devices: []string{dev.ID}, TeamID: dev.TeamID}
	raw, cleanup, err := p.Create(cfg)
	if err != nil {
		return nil, cleanup, err
	}
	return maestroDriver{Driver: raw, dir: p.ManualDir}, cleanup, nil
}

// discard bỏ driver hỏng; gọi khi đang giữ khoá thiết bị.
func (p *Pool) discard(e *entry, cause error) {
	p.mu.Lock()
	stale := p.detachLocked(e)
	e.unhealthy = true
	e.lastErr = cause.Error()
	p.mu.Unlock()
	runCleanup(e.dev.ID, stale)
}

// detachLocked tách driver khỏi thiết bị và trả hàm dọn của nó (nil nếu không có). Gọi khi đang giữ p.mu;
// bên gọi chạy hàm dọn bằng runCleanup SAU khi nhả p.mu: dọn có thể chờ thiết bị hay sidecar, mà p.mu chặn
// mọi thiết bị (States, Peek, Poll).
func (p *Pool) detachLocked(e *entry) func() {
	fn := e.cleanup
	e.drv, e.cleanup = nil, nil
	return fn
}

// runCleanup chạy hàm dọn đã tách (nil thì bỏ qua); panic chỉ được ghi log.
func runCleanup(id string, fn func()) {
	if fn == nil {
		return
	}
	defer func() {
		if r := recover(); r != nil {
			log.Printf("testengine: panic khi dọn driver %s: %v", id, r)
		}
	}()
	fn()
}

// ReapIdle dọn driver rảnh lâu hơn Idle. Thiết bị đang chạy hoặc đang có việc giữ khoá không bị đụng; thiết bị
// được dọn bị giữ khoá trong lúc dọn, nên lượt sau chỉ tạo driver mới khi driver cũ đã dọn xong.
func (p *Pool) ReapIdle() int {
	type reap struct {
		e  *entry
		id string
		fn func()
	}
	var todo []reap
	p.mu.Lock()
	for _, e := range p.entries {
		if e.drv == nil || e.busy || p.now().Sub(e.lastUsed) <= p.Idle {
			continue
		}
		select {
		case e.lock <- struct{}{}:
			todo = append(todo, reap{e, e.dev.ID, p.detachLocked(e)})
		default: // vừa có việc giữ khoá: để lần sau
		}
	}
	p.mu.Unlock()
	for _, r := range todo {
		runCleanup(r.id, r.fn)
		<-r.e.lock
	}
	return len(todo)
}

// StartReaper chạy ReapIdle mỗi phút đến khi ctx kết thúc.
func (p *Pool) StartReaper(ctx context.Context) {
	go func() {
		t := time.NewTicker(time.Minute)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				p.ReapIdle()
			}
		}
	}()
}

// CloseAll dọn mọi driver (Dừng tất cả, thoát app). Lượt đang chạy phải được hủy context trước;
// chờ mỗi thiết bị nhả khoá tối đa wait, quá hạn thì vẫn dọn (lệnh driver treo không giữ agent mãi).
// Sau CloseAll pool từ chối lượt mới.
func (p *Pool) CloseAll(wait time.Duration) {
	p.mu.Lock()
	p.closed = true
	entries := make([]*entry, 0, len(p.entries))
	for _, e := range p.entries {
		entries = append(entries, e)
	}
	p.mu.Unlock()

	var wg sync.WaitGroup
	for _, e := range entries {
		wg.Add(1)
		go func(e *entry) {
			defer wg.Done()
			got := false
			select {
			case e.lock <- struct{}{}:
				got = true
			case <-time.After(wait):
			}
			p.mu.Lock()
			stale, id := p.detachLocked(e), e.dev.ID
			p.mu.Unlock()
			runCleanup(id, stale)
			if got {
				<-e.lock
			}
		}(e)
	}
	wg.Wait()
}

// Reopen cho pool nhận lượt mới sau Dừng tất cả.
func (p *Pool) Reopen() {
	p.mu.Lock()
	p.closed = false
	p.mu.Unlock()
}

// States: trạng thái từng thiết bị pool đã biết, xếp theo ID.
func (p *Pool) States() []DeviceState {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := make([]DeviceState, 0, len(p.entries))
	for _, e := range p.entries {
		h := HealthCold
		switch {
		case e.busy && !e.peeking:
			h = HealthBusy
		case e.unhealthy:
			h = HealthUnhealthy
		case e.drv != nil:
			h = HealthWarm
		}
		out = append(out, DeviceState{Device: e.dev, Health: h, LastUsed: e.lastUsed, LastErr: e.lastErr})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Device.ID < out[j].Device.ID })
	return out
}

// Discard dọn driver của một thiết bị (nhả thiết bị) khi thiết bị rảnh; lần dùng sau tạo driver mới.
func (p *Pool) Discard(ctx context.Context, dev Device) error {
	e, err := p.acquire(ctx, dev)
	if err != nil {
		return err
	}
	defer p.release(e)
	p.mu.Lock()
	stale := p.detachLocked(e)
	e.unhealthy = false
	p.mu.Unlock()
	runCleanup(e.dev.ID, stale)
	return nil
}

// DiscardWhere bỏ driver của mọi thiết bị khớp pred mà KHÔNG chạy hàm dọn và không chờ khoá thiết bị: dùng khi
// phiên đã chết cùng tiến trình điều khiển (sidecar trình duyệt), lệnh dọn cũ vô nghĩa và không được mở lại
// tiến trình. Lượt đang giữ driver cũ nhận ErrDriverBroken ở lệnh kế tiếp; lượt sau mở phiên mới. Trả số thiết bị.
func (p *Pool) DiscardWhere(pred func(Device) bool) int {
	p.mu.Lock()
	defer p.mu.Unlock()
	n := 0
	for _, e := range p.entries {
		if e.drv != nil && pred(e.dev) {
			e.drv, e.cleanup = nil, nil
			n++
		}
	}
	return n
}
