package testengine

import (
	"context"
	"fmt"
	"log"
	"sync"
	"time"

	"deskcore/apperr"
)

// Giành quyền điều khiển (take over): người dùng tạm giữ một máy để tự chạm, vuốt (vd nhập mã 2FA) rồi trả lại.
// Máy đang chạy flow: lượt chạy dừng ngay sau bước hiện tại, vẫn giữ khoá, driver và trạng thái app; trả lại thì chạy
// tiếp từ bước sau. Máy rảnh: giữ khoá thiết bị đến khi trả lại, để không lượt chạy nào chen vào. Máy web đang chạy flow
// thì từ chối: flow chạy trong tiến trình test riêng, không có ranh giới bước để dừng giữa chừng.

// CodeTakeoverTimeout: bước hiện tại chưa xong trong thời gian chờ nên chưa giữ được máy.
const CodeTakeoverTimeout = "takeover_timeout"

// Trạng thái giữ máy của người dùng (HoldState).
const (
	HoldNone    = ""        // không ai giữ
	HoldPending = "pending" // đang chờ bước hiện tại xong
	HoldIdle    = "held"    // máy rảnh, người dùng giữ khoá
	HoldPaused  = "paused"  // lượt chạy tạm dừng sau một bước, người dùng đang điều khiển
)

type hold struct {
	mu       sync.Mutex
	drv      DeviceDriver
	claimed  bool
	byRun    bool
	ended    bool
	parked   chan struct{} // đóng khi đã giữ được máy
	release  chan struct{} // đóng khi trả lại (hoặc Dừng tất cả, rút cáp)
	failed   chan error    // đường giữ khoá không giữ được máy
	unlocked chan struct{} // đóng khi đường giữ khoá đã nhả khoá thiết bị
	stop     context.CancelFunc
	cmd      sync.Mutex // lệnh tay chạy lần lượt trên driver
}

// claim: lượt chạy (ở ranh giới bước) hoặc đường giữ khoá nhận máy; chỉ một bên thắng.
func (h *hold) claim(drv DeviceDriver, byRun bool) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.claimed || h.ended {
		return false
	}
	h.claimed, h.byRun, h.drv = true, byRun, drv
	close(h.parked)
	return true
}

// fail báo đường chờ của TakeOver rằng không giữ được máy; không chặn (chỉ lỗi đầu tiên được đọc).
func (h *hold) fail(err error) {
	select {
	case h.failed <- err:
	default:
	}
}

func (h *hold) end() {
	h.mu.Lock()
	if !h.ended {
		h.ended = true
		close(h.release)
	}
	h.mu.Unlock()
	h.stop()
}

// drain chờ lệnh tay đang chạy (nếu có) xong, để lượt chạy hay việc kế tiếp không dùng driver cùng lúc với nó.
func (h *hold) drain() {
	h.cmd.Lock()
	h.cmd.Unlock() // chỉ để chờ, không giữ
}

func (h *hold) state() string {
	h.mu.Lock()
	defer h.mu.Unlock()
	switch {
	case h.ended:
		return HoldNone
	case !h.claimed:
		return HoldPending
	case h.byRun:
		return HoldPaused
	default:
		return HoldIdle
	}
}

// TakeOver giữ máy cho người dùng, chờ bước hiện tại xong tối đa wait. paused = true nếu một lượt chạy đang tạm dừng
// trên máy (trả lại thì lượt chạy tiếp). Gọi lại khi đang giữ thì trả ngay. Máy web đang chạy flow: device_not_ready
// ngay.
func (e *Engine) TakeOver(ctx context.Context, dev Device, wait time.Duration) (paused bool, err error) {
	if err := ValidateDevice(dev); err != nil {
		return false, err
	}
	e.mu.Lock()
	if e.holds == nil {
		e.holds = map[string]*hold{}
	}
	h := e.holds[dev.ID]
	// Kiểm tra máy web đang chạy và tạo hold trong cùng một đoạn giữ e.mu: lượt web bắt đầu sau đoạn này sẽ thấy hold
	// đang chờ và trả lỗi cho nó (refuseHoldForWebRun), nên không bao giờ có hold chờ suông tới hết hạn.
	if h == nil && e.webRunning[dev.ID] > 0 {
		e.mu.Unlock()
		return false, errWebRunning(dev.ID)
	}
	if h == nil {
		lctx, stop := context.WithCancel(context.Background())
		h = &hold{parked: make(chan struct{}), release: make(chan struct{}), failed: make(chan error, 1), unlocked: make(chan struct{}), stop: stop}
		e.holds[dev.ID] = h
		// Đường máy rảnh: giữ khoá đến khi trả lại. Nếu một lượt chạy đang giữ khoá, lượt đó nhận trước ở ranh giới bước
		// và huỷ đường này.
		go func() {
			defer close(h.unlocked)
			err := e.Pool.Run(lctx, dev, func(_ context.Context, s Session) error {
				if h.claim(s.Driver, false) {
					<-h.release
					h.drain()
				}
				return nil
			})
			if err != nil && h.state() == HoldPending {
				h.fail(err)
			}
		}()
	}
	e.mu.Unlock()

	t := time.NewTimer(wait)
	defer t.Stop()
	select {
	case <-h.parked:
		return h.state() == HoldPaused, nil
	case err := <-h.failed:
		e.dropHold(dev.ID, h)
		return false, err
	case <-t.C:
		e.dropHold(dev.ID, h)
		return false, apperr.New(CodeTakeoverTimeout, wait.String())
	case <-h.release: // trả lại hoặc Dừng tất cả trong lúc chờ
		return false, apperr.New(CodeDeviceNotReady, dev.ID+": đã dừng giữ máy")
	case <-ctx.Done():
		e.dropHold(dev.ID, h)
		return false, ctx.Err()
	}
}

func errWebRunning(id string) error {
	return apperr.New(CodeDeviceNotReady, id+": máy web đang chạy flow; giành quyền giữa lượt không hỗ trợ")
}

// refuseHoldForWebRun: gọi khi lượt web vừa giữ khoá thiết bị. Hold còn đang chờ (TakeOver tạo trước khi lượt đánh dấu
// máy đang chạy) nhận lỗi device_not_ready ngay và đường giữ khoá của nó bị huỷ.
func (e *Engine) refuseHoldForWebRun(id string) {
	e.mu.Lock()
	h := e.holds[id]
	e.mu.Unlock()
	if h == nil || h.state() != HoldPending {
		return
	}
	h.fail(errWebRunning(id))
	h.stop()
}

// HandBack trả máy: lượt chạy đang tạm dừng chạy tiếp từ bước sau, khoá được nhả. false nếu máy không bị giữ.
func (e *Engine) HandBack(id string) bool {
	e.mu.Lock()
	h := e.holds[id]
	delete(e.holds, id)
	e.mu.Unlock()
	if h == nil {
		return false
	}
	idle := h.state() == HoldIdle
	h.end()
	if idle { // máy rảnh: chờ khoá được nhả để máy dùng được ngay khi hàm trả về
		select {
		case <-h.unlocked:
		case <-time.After(2 * time.Second):
		}
	}
	return true
}

func (e *Engine) dropHold(id string, h *hold) {
	e.mu.Lock()
	if e.holds[id] == h {
		delete(e.holds, id)
	}
	e.mu.Unlock()
	h.end()
}

// releaseHolds trả mọi máy đang giữ (Dừng tất cả).
func (e *Engine) releaseHolds() {
	e.mu.Lock()
	holds := e.holds
	e.holds = map[string]*hold{}
	e.mu.Unlock()
	for _, h := range holds {
		h.end()
	}
}

// HoldState: máy có đang bị người dùng giữ không (HoldNone, HoldPending, HoldIdle, HoldPaused).
func (e *Engine) HoldState(id string) string {
	e.mu.Lock()
	h := e.holds[id]
	e.mu.Unlock()
	if h == nil {
		return HoldNone
	}
	return h.state()
}

// WithHeld chạy fn (chạm, vuốt, chụp màn hình) trên driver của máy người dùng đang giữ, lần lượt từng lệnh.
// held = false khi máy không bị giữ (gọi theo đường thường). Đang chờ bước hiện tại xong thì báo máy chưa sẵn sàng.
func (e *Engine) WithHeld(id string, fn func(drv DeviceDriver) error) (held bool, err error) {
	e.mu.Lock()
	h := e.holds[id]
	e.mu.Unlock()
	if h == nil {
		return false, nil
	}
	h.mu.Lock()
	drv, claimed, ended := h.drv, h.claimed, h.ended
	h.mu.Unlock()
	if ended {
		return false, nil
	}
	if !claimed {
		return true, apperr.New(CodeDeviceNotReady, id+": đang chờ bước hiện tại xong")
	}
	h.cmd.Lock()
	defer h.cmd.Unlock()
	h.mu.Lock()
	ended = h.ended
	h.mu.Unlock()
	if ended { // trả máy trong lúc chờ lệnh trước: đi đường thường
		return false, nil
	}
	defer func() {
		if r := recover(); r != nil {
			err = apperr.New(CodeDriverFailed, fmt.Sprintf("panic: %v", r))
			log.Printf("testengine: panic khi điều khiển tay %s: %v", id, r)
		}
	}()
	return true, fn(drv)
}

// pauseIfHeld: gọi ở ranh giới bước của lượt chạy (trên goroutine của flow, đang giữ khoá). Có người đang chờ giữ máy
// thì dừng ở đây đến khi trả lại hoặc lượt bị huỷ. Trả thời gian đã dừng (không tính vào thời lượng flow).
// clock (nil giữa hai flow) là hạn của flow, ngừng đếm trong lúc dừng.
func (e *Engine) pauseIfHeld(ctx context.Context, runID string, dev Device, drv DeviceDriver, clock *flowClock) time.Duration {
	if ctx.Err() != nil {
		return 0
	}
	e.mu.Lock()
	h := e.holds[dev.ID]
	e.mu.Unlock()
	if h == nil || !h.claim(drv, true) {
		return 0
	}
	h.stop() // đường giữ khoá không cần nữa
	if clock != nil {
		clock.pause()
		defer clock.resume()
	}
	start := e.now()
	e.emit(Event{RunID: runID, Kind: "takeover_paused", DeviceID: dev.ID})
	select {
	case <-h.release:
	case <-ctx.Done():
		e.dropHold(dev.ID, h)
	}
	h.drain()
	e.emit(Event{RunID: runID, Kind: "takeover_resumed", DeviceID: dev.ID})
	return e.now().Sub(start)
}
