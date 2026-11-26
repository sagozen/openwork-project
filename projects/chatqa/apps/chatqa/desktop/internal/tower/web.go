package tower

import (
	"context"
	"errors"
	"log"
	"slices"
	"sync"
	"time"

	"chatqa/internal/pw"
	"chatqa/internal/testengine"
	"deskcore/apperr"
)

const (
	// profileReleaseWait: xoá hồ sơ chờ lượt chạy bị huỷ nhả thiết bị tối đa chừng này; quá thì thiết bị được nhả
	// khi lượt chạy thoát, xoá vẫn thành công.
	profileReleaseWait = 5 * time.Second
	webProgressEvery   = 250 * time.Millisecond
	// webDownDetail: lý do ghi khi máy trình duyệt đang giữ bị trả vì tiến trình điều khiển đã dừng.
	webDownDetail = "tiến trình điều khiển trình duyệt đã dừng nên máy được trả lại; giữ máy lại nếu cần điều khiển tiếp"
)

// BrowserProfiles: các hồ sơ trình duyệt đã lưu.
func (t *Tower) BrowserProfiles() ([]pw.Profile, error) { return t.Store.BrowserProfiles() }

// SaveProfile kiểm tra rồi lưu hồ sơ, sau đó đọc lại danh sách máy ngay: lệnh kế tiếp thấy cấu hình mới (Rev mới
// thì phiên trình duyệt cũ được mở lại) mà không chờ lượt đọc định kỳ.
func (t *Tower) SaveProfile(ctx context.Context, p pw.Profile) (pw.Profile, error) {
	saved, err := t.Store.SaveBrowserProfile(p, t.now())
	if err != nil {
		return pw.Profile{}, err
	}
	t.refreshFleet(ctx)
	return saved, nil
}

// DeleteProfile xoá hồ sơ mà không chờ lượt chạy đang dùng nó: xoá dòng, huỷ việc trên thiết bị, đọc lại danh sách
// (thiết bị thành disconnected), rồi nhả phiên trình duyệt trong tối đa profileReleaseWait.
func (t *Tower) DeleteProfile(ctx context.Context, id string) error {
	ed, edErr := t.Pool.EngineDevice(id) // đọc trước khi xoá: còn Rev của phiên đang mở
	if err := t.Store.DeleteBrowserProfile(id); err != nil {
		return err
	}
	if t.Engine.CancelDevice(id, testengine.ErrDeviceDisconnected) {
		_ = t.Store.AddEvent(Event{At: t.now(), Kind: "device_disconnected", DeviceID: id, Detail: "hồ sơ trình duyệt bị xoá giữa lượt chạy"})
	}
	t.refreshFleet(ctx)
	if edErr != nil || ed.Platform != testengine.PlatformWeb || !t.poolKnows(ed.ID) {
		return nil
	}
	rctx, cancel := context.WithTimeout(ctx, profileReleaseWait)
	defer cancel()
	if err := t.Engine.Pool.Discard(rctx, ed); err != nil && !errors.Is(err, context.DeadlineExceeded) {
		log.Printf("tower: nhả trình duyệt của hồ sơ đã xoá %s: %v", id, err)
	}
	return nil
}

// poolKnows: pool driver đã từng dùng thiết bị này (có phiên hoặc khoá để nhả).
func (t *Tower) poolKnows(id string) bool {
	for _, s := range t.Engine.Pool.States() {
		if s.Device.ID == id {
			return true
		}
	}
	return false
}

// WebRuntime: trạng thái bộ chạy trình duyệt (Node, gói npm, trình duyệt, kênh có sẵn).
func (t *Tower) WebRuntime() (pw.Status, error) {
	w := t.Engine.Web
	if w == nil || w.RT == nil {
		return pw.Status{}, apperr.New(pw.CodeRuntimeMissing, "bộ chạy trình duyệt chưa sẵn sàng")
	}
	return w.RT.Status(), nil
}

// InstallWebRuntime cài Node, Playwright và các trình duyệt browsers ở nền, mỗi lúc một lượt; tiến độ và kết quả
// qua Web.OnRuntime. Từ chối khi một lượt chạy web đang giữ thiết bị. Trước khi cài thì đóng sidecar (không cài
// đè file đang chạy); xong thì đọc lại danh sách máy.
func (t *Tower) InstallWebRuntime(browsers []string) error {
	for _, b := range browsers {
		if !slices.Contains(pw.Browsers, b) {
			return apperr.New(apperr.CodeInvalid, "trình duyệt tải về phải là chromium, firefox hoặc webkit: "+b)
		}
	}
	done, err := t.Engine.BeginWebInstall()
	if err != nil {
		return err
	}
	t.mu.Lock()
	ctx := t.ctx
	t.mu.Unlock()
	go func() {
		defer done()
		ev := testengine.WebRuntimeEvent{Finished: true}
		if err := t.installWeb(ctx, browsers); err != nil {
			ev.Code, ev.Error = apperr.CodeOf(err), err.Error()
			log.Printf("tower: cài bộ chạy trình duyệt: %v", err)
		}
		t.emitWeb(ev)
		t.refreshFleet(ctx)
	}()
	return nil
}

func (t *Tower) installWeb(ctx context.Context, browsers []string) error {
	w := t.Engine.Web
	if w.Sidecar != nil {
		_ = w.Sidecar.Close() // OnDown bỏ mọi phiên trình duyệt
	}
	var mu sync.Mutex
	last := map[string]time.Time{}
	progress := func(component string, done, total int64) {
		mu.Lock()
		defer mu.Unlock()
		now := time.Now()
		if done < total && now.Sub(last[component]) < webProgressEvery {
			return
		}
		last[component] = now
		t.emitWeb(testengine.WebRuntimeEvent{Component: component, Done: done, Total: total})
	}
	if err := w.RT.Ensure(ctx, browsers, progress); err != nil {
		return err
	}
	t.Engine.ResetWebRestarts()
	return nil
}

func (t *Tower) emitWeb(ev testengine.WebRuntimeEvent) {
	if w := t.Engine.Web; w != nil && w.OnRuntime != nil {
		w.OnRuntime(ev)
	}
}

// WebDown: Sidecar.OnDown. Bỏ mọi phiên trình duyệt, trả máy trình duyệt đang giữ (ghi lý do), rồi đọc lại danh sách
// máy. Không gọi Close hay Start của sidecar.
func (t *Tower) WebDown(gen int) {
	ids := t.Engine.WebDown(gen)
	for _, id := range ids {
		_ = t.Store.AddEvent(Event{At: t.now(), Kind: "hand_back", DeviceID: id, Detail: webDownDetail})
	}
	t.mu.Lock()
	ctx := t.ctx
	t.mu.Unlock()
	t.refreshFleet(ctx)
	if t.Live != nil {
		for _, id := range ids {
			t.Live.Kick(id)
		}
	}
}
