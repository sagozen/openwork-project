package testengine

import (
	"context"
	"fmt"
	"sync/atomic"
	"time"

	"chatqa/internal/pw"
	"deskcore/apperr"
)

// webCloseTimeout: lệnh đóng phiên trình duyệt không bao giờ giữ bên dọn lâu hơn.
const webCloseTimeout = time.Second

// Web: bộ chạy trình duyệt dùng chung của engine. Hồ sơ trình duyệt là thiết bị DriverPlaywright; phiên của nó
// sống trong một sidecar Node chung cho mọi hồ sơ.
type Web struct {
	RT      *pw.Runtime
	Sidecar *pw.Sidecar
	// Profile đọc hồ sơ theo mã (kho tower); nil = chưa có hồ sơ nào dùng được.
	Profile func(id string) (pw.Profile, error)
	// OnRuntime báo tiến độ và kết quả cài bộ chạy (sự kiện "web:runtime"); nil = không báo.
	OnRuntime func(WebRuntimeEvent)

	installing atomic.Bool
}

// WebRuntimeEvent: tiến độ cài bộ chạy trình duyệt. Finished = lượt cài đã xong (Error trống là thành công).
type WebRuntimeEvent struct {
	Component string `json:"component,omitempty"` // node | modules | chromium | ffmpeg | firefox | webkit
	Done      int64  `json:"done"`
	Total     int64  `json:"total"`
	Finished  bool   `json:"finished"`
	Code      string `json:"code,omitempty"`
	Error     string `json:"error,omitempty"`
}

func isWebDevice(d Device) bool { return d.Driver == DriverPlaywright }

func errNoWebRuntime() error {
	return apperr.New(pw.CodeRuntimeMissing, "bộ chạy trình duyệt chưa sẵn sàng")
}

func (e *Engine) webProfile(id string) (pw.Profile, error) {
	if e.Web == nil || e.Web.RT == nil || e.Web.Profile == nil {
		return pw.Profile{}, errNoWebRuntime()
	}
	return e.Web.Profile(id)
}

// WebReady: hồ sơ mở được ngay (Node, Playwright, trình duyệt hoặc kênh đã có); không tải gì.
func (e *Engine) WebReady(p pw.Profile) error {
	if e.Web == nil || e.Web.RT == nil {
		return errNoWebRuntime()
	}
	return e.Web.RT.Ready(p.Browser, p.Channel)
}

// ensureWeb: nhánh web của EnsureRuntime. Đường chạy và điều khiển không bao giờ tải bộ chạy.
func (e *Engine) ensureWeb(dev Device) error {
	p, err := e.webProfile(dev.ID)
	if err != nil {
		return err
	}
	return e.WebReady(p)
}

// OpenWeb mở (hoặc dùng lại) phiên trình duyệt của hồ sơ trong sidecar thế hệ hiện tại; Pool.OpenWeb trỏ vào đây.
// Hàm dọn chỉ gửi close khi phiên còn thuộc thế hệ đang chạy, và không bao giờ mở lại sidecar. Đang cài bộ chạy thì
// trả device_not_ready: ô live mở lại sidecar giữa lúc cài sẽ làm lượt cài bị từ chối.
func (e *Engine) OpenWeb(ctx context.Context, dev Device) (DeviceDriver, func(), error) {
	p, err := e.webProfile(dev.ID)
	if err != nil {
		return nil, nil, err
	}
	if e.Web.installing.Load() {
		return nil, nil, apperr.New(CodeDeviceNotReady, "đang cài bộ chạy trình duyệt")
	}
	if err := e.WebReady(p); err != nil {
		return nil, nil, err
	}
	sc := e.Web.Sidecar
	if sc == nil {
		return nil, nil, errNoWebRuntime()
	}
	gen, err := sc.Start(ctx)
	if err != nil {
		return nil, nil, err
	}
	if err := sc.Call(ctx, gen, "open", map[string]any{"session": dev.ID, "profile": p}, nil); err != nil {
		return nil, nil, err
	}
	return &webDriver{sc: sc, id: dev.ID, gen: gen}, func() { closeWebSession(sc, gen, dev.ID) }, nil
}

func closeWebSession(sc *pw.Sidecar, gen int, id string) {
	if sc.Closed(gen, id) { // thế hệ cũ hoặc phiên đã đóng: không có gì để đóng
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), webCloseTimeout)
	defer cancel()
	_ = sc.Call(ctx, gen, "close", map[string]any{"session": id}, nil)
}

// WebBusy: một lượt chạy (hoặc người dùng đang giữ máy) đang giữ khoá một thiết bị trình duyệt.
func (e *Engine) WebBusy() bool {
	for _, s := range e.Pool.States() {
		if isWebDevice(s.Device) && s.Health == HealthBusy {
			return true
		}
	}
	return false
}

// HandBackWeb trả mọi thiết bị trình duyệt người dùng đang giữ (phiên của chúng đã mất); trả các mã đã trả.
func (e *Engine) HandBackWeb() []string {
	var ids []string
	for _, s := range e.Pool.States() {
		if isWebDevice(s.Device) && e.HoldState(s.Device.ID) != HoldNone && e.HandBack(s.Device.ID) {
			ids = append(ids, s.Device.ID)
		}
	}
	return ids
}

// WebDown: sidecar thế hệ gen đã thoát, mọi phiên trình duyệt mất theo. Bỏ driver của mọi thiết bị trình duyệt
// (không chạy lệnh dọn cũ, không mở lại sidecar) rồi trả máy đang giữ. Thiết bị điện thoại không bị đụng.
// Trả các mã thiết bị đã trả lại cho người dùng.
func (e *Engine) WebDown(gen int) []string {
	e.Pool.DiscardWhere(isWebDevice)
	return e.HandBackWeb()
}

// BeginWebInstall nhận lượt cài bộ chạy: mỗi lúc một lượt, từ chối khi một lượt chạy web đang giữ thiết bị.
// Bên gọi gọi done khi lượt cài xong.
func (e *Engine) BeginWebInstall() (done func(), err error) {
	if e.Web == nil || e.Web.RT == nil {
		return nil, errNoWebRuntime()
	}
	if !e.Web.installing.CompareAndSwap(false, true) {
		return nil, apperr.New(CodeDeviceNotReady, "đang cài bộ chạy trình duyệt")
	}
	if e.WebBusy() {
		e.Web.installing.Store(false)
		return nil, apperr.New(CodeDeviceNotReady, "một lượt chạy trình duyệt đang giữ thiết bị: dừng lượt chạy hoặc trả máy rồi cài lại")
	}
	return func() { e.Web.installing.Store(false) }, nil
}

// ResetWebRestarts xoá bộ đếm khởi động lại của sidecar (sau Prepare hay cài bộ chạy thành công).
func (e *Engine) ResetWebRestarts() {
	if e.Web != nil && e.Web.Sidecar != nil {
		e.Web.Sidecar.ResetRestarts()
	}
}

// RequireSecretSafe: lượt mang biến bí mật (secrets hay ${NAME} khi điền) chỉ chạy trên hồ sơ họ Chromium, họ
// duy nhất chặn host ở tầng DNS (pw.Profile.SecretSafe). Thiết bị điện thoại luôn qua.
func (e *Engine) RequireSecretSafe(dev Device) error {
	if dev.Platform != PlatformWeb {
		return nil
	}
	p, err := e.webProfile(dev.ID)
	if err != nil {
		return err
	}
	if !p.SecretSafe() {
		return apperr.New(apperr.CodeInvalid, fmt.Sprintf("%s dùng %s: lượt có biến bí mật chỉ chạy trên hồ sơ Chromium, Chrome hoặc Edge "+
			"(chỉ các trình duyệt này chặn được host lạ ở tầng DNS)", dev.ID, p.Browser))
	}
	return nil
}
