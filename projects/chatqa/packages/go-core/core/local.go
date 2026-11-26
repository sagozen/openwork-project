package core

import (
	"context"
	"slices"
	"time"

	"deskcore/apperr"
	"deskcore/modules"
	"deskcore/netprog"
	"deskcore/offline"
	"deskcore/store"
)

func (a *App) setupSync() {
	a.sync = offline.NewSyncer(a.db)
	a.sync.Gate = a.authorizeOp
	a.sync.OnStatus = func(st offline.Status) { a.Emit("sync:status", st) }

	// Phần riêng của sản phẩm: đăng ký cách đẩy thao tác + tạo Service phân hệ. Thêm app mới: docs/ADD_APP.md.
	if a.newModules != nil {
		a.Modules = a.newModules(ModuleDeps{Host: a, Sync: a.sync, GoogleToken: a.GoogleToken, SaveGoogleResources: a.SaveGoogleResources, AIMessages: a.api.AIMessages, AIChat: a.api.AIChat, AIMessagesStream: a.api.AIMessagesStream, Cloud: a.api})
	}
	// Chưa đăng nhập: không kéo dữ liệu mới về (mọi bộ kéo AddPull qua PullAllowed; Pull cũ bọc thêm cho ai gọi thẳng).
	signedIn := func() bool { return a.session() != nil }
	a.sync.PullAllowed = signedIn
	if pull := a.sync.Pull; pull != nil {
		a.sync.Pull = func(ctx context.Context) error {
			if !signedIn() {
				return nil
			}
			return pull(ctx)
		}
	}
}

func firstFactory(mods []ModuleFactory) ModuleFactory {
	if len(mods) == 0 {
		return nil
	}
	return mods[0]
}

// ---------- modules.Host: lõi cấp cho các phân hệ ----------

// Context: context sống theo cửa sổ app.
func (a *App) Context() context.Context { return a.context() }

// ServerSkew: giờ máy lệch bao nhiêu giây so với giờ máy chủ (BR-hs-suggest-024 f); known=false khi chưa từng kết nối.
func (a *App) ServerSkew() (int64, bool) { return a.clock.ServerSkew() }

// RequireApp: máy có bản quyền dùng được VÀ bản quyền bật phân hệ `code` VÀ người đang làm việc được cấp app đó.
// Kiểm tra ở Go (không chỉ ẩn trên UI) => UI OTA lỗi/sửa đổi cũng không mở được phân hệ chưa mua.
// Lỗi: device_revoked (E-016) | locked_in_use | offline_expired (E-006) | device_not_licensed | module_locked (E-012) |
// app_disabled (E-017) | app_forbidden (E-013).
func (a *App) RequireApp(code modules.Code) error {
	if err := a.workGuard(); err != nil {
		return err
	}
	if err := a.licenseGuard(); err != nil {
		return err
	}
	if p := a.payload(); p == nil || !p.HasApp(string(code)) {
		if slices.Contains(a.st.Get().SeenApps, string(code)) {
			return apperr.New(apperr.CodeAppDisabled, string(code))
		}
		return apperr.New(apperr.CodeModuleLocked, string(code))
	}
	// Quyền theo người dùng (admin cấp ở Cài đặt). Chưa đăng nhập thì để hàm nghiệp vụ báo unauthorized.
	if s := a.st.Get().Session; s != nil && !appGranted(s.User, string(code)) {
		return apperr.New(apperr.CodeAppForbidden, string(code))
	}
	return nil
}

// appGranted: người dùng được cấp app. Vipo (BR-013) chỉ có các module riêng của mình, không app nội bộ nào.
func appGranted(u store.User, code string) bool {
	if modules.NormalizeRole(u.Role) == modules.RoleVipo {
		return slices.Contains(modules.VipoModules, code)
	}
	return u.CanUse(code)
}

// ---------- Đồng bộ (dùng chung mọi phân hệ) ----------

func (a *App) SyncStatus() offline.Status { return a.sync.Status() }

// SyncNow: đồng bộ ngay (tối đa 30 giây), trả trạng thái sau đó.
func (a *App) SyncNow() offline.Status {
	ctx, cancel := context.WithTimeout(a.context(), 30*time.Second)
	defer cancel()
	ctx, op := netprog.Begin(ctx, OpSyncNow, "Đang đồng bộ với Drive")
	err := a.sync.DrainOnce(ctx)
	op.End(err)
	return a.sync.Status()
}

// IssueResolver: cách chọn bản cho một loại thao tác có kho xung đột riêng của sản phẩm (vd đẩy mục lên Drive: bảng
// conflicts, phiên bản, thông báo). Đăng ký bằng RouteSyncIssues lúc tạo phân hệ.
type IssueResolver func(ctx context.Context, op *offline.Op, keepMine bool) error

// RouteSyncIssues: thao tác loại kind được chọn bản qua fn thay cho cách chung (đẩy lại / bỏ rồi kéo về). Thao tác
// loại đó đang xung đột không hiện trong ListSyncIssues: sản phẩm hiện chúng ở màn xung đột riêng.
func (a *App) RouteSyncIssues(kind string, fn IssueResolver) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.resolvers == nil {
		a.resolvers = map[string]IssueResolver{}
	}
	a.resolvers[kind] = fn
}

func (a *App) resolver(kind string) IssueResolver {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.resolvers[kind]
}

// DiscardFunc: cách sản phẩm bỏ một thao tác (admin bỏ khi chờ công nhận, máy chủ không công nhận rồi người làm bỏ
// khỏi danh sách). Sản phẩm phải xoá Op VÀ đưa dữ liệu trên máy về trạng thái không còn chờ đẩy (vd mục Drive về bản
// trên Drive, giữ bản bị bỏ trong lịch sử), để thay đổi đã bỏ không bị xếp lại dưới tên người khác.
type DiscardFunc func(ctx context.Context, op *offline.Op) error

// RouteDiscard: bỏ thao tác loại kind qua fn thay cho xoá Op trơn.
func (a *App) RouteDiscard(kind string, fn DiscardFunc) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.discards == nil {
		a.discards = map[string]DiscardFunc{}
	}
	a.discards[kind] = fn
}

func (a *App) discard(ctx context.Context, op *offline.Op) error {
	a.mu.Lock()
	fn := a.discards[op.Kind]
	a.mu.Unlock()
	if fn != nil {
		return fn(ctx, op)
	}
	return a.db.Discard(ctx, op.ID)
}

// CountOnClose: chỉ thao tác có kind thoả fn được tính vào số "Còn {n} mục chưa lên Drive" khi đóng app (E-008);
// CloseGuard.Total vẫn đếm mọi thao tác. nil = đếm mọi thao tác.
func (a *App) CountOnClose(fn func(kind string) bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.closeKind = fn
}

// closePending: (số thao tác tính vào hộp đóng app, tổng số thao tác chưa xong) - đang chờ, lỗi hoặc xung đột.
func (a *App) closePending(ctx context.Context) (n, total int) {
	a.mu.Lock()
	keep := a.closeKind
	a.mu.Unlock()
	for _, st := range []offline.OpStatus{offline.OpPending, offline.OpFailed, offline.OpConflict} {
		ops, err := a.db.ListOps(ctx, st)
		if err != nil {
			continue
		}
		total += len(ops)
		for _, o := range ops {
			if keep == nil || keep(o.Kind) {
				n++
			}
		}
	}
	return n, total
}

// ListSyncIssues: thao tác lỗi hoặc xung đột cần người xử lý (trừ xung đột do sản phẩm tự quản, RouteSyncIssues).
func (a *App) ListSyncIssues() ([]offline.Op, error) {
	all, err := a.syncIssues()
	if err != nil {
		return nil, err
	}
	out := all[:0]
	for _, op := range all {
		if op.Status == offline.OpConflict && a.resolver(op.Kind) != nil {
			continue
		}
		out = append(out, op)
	}
	return out, nil
}

func (a *App) syncIssues() ([]offline.Op, error) {
	ctx := a.context()
	conflicts, err := a.db.ListOps(ctx, offline.OpConflict)
	if err != nil {
		return nil, err
	}
	failed, err := a.db.ListOps(ctx, offline.OpFailed)
	if err != nil {
		return nil, err
	}
	return append(conflicts, failed...), nil
}

// ResolveSyncIssue: keepMine=true => ghi đè bằng bản trên máy; false => bỏ, lấy lại bản trên dịch vụ đích.
// Loại thao tác đã RouteSyncIssues thì chuyển cho sản phẩm (kể cả khi UI cũ gọi bằng mã thao tác).
func (a *App) ResolveSyncIssue(id string, keepMine bool) error {
	ctx := a.context()
	ops, err := a.syncIssues()
	if err != nil {
		return err
	}
	var op *offline.Op
	for i := range ops {
		if ops[i].ID == id {
			op = &ops[i]
		}
	}
	if op == nil {
		return offline.ErrNotFound
	}
	if fn := a.resolver(op.Kind); fn != nil {
		if err := fn(ctx, op, keepMine); err != nil {
			return err
		}
		a.sync.Trigger()
		return nil
	}
	if !keepMine {
		if err := a.db.Discard(ctx, id); err != nil {
			return err
		}
		// Lấy bản trên dịch vụ đích: kéo ngay mọi bộ kéo.
		go func() { _ = a.sync.PullNow(a.context(), "") }()
		a.sync.Trigger()
		return nil
	}
	payload, err := a.sync.KeepMinePayload(op)
	if err != nil {
		return err
	}
	if err := a.db.Requeue(ctx, id, payload); err != nil {
		return err
	}
	a.sync.Trigger()
	return nil
}

// FlushBeforeQuit: khi đóng app, thử đồng bộ nốt (tối đa timeout), trả số thao tác còn lại.
func (a *App) FlushBeforeQuit(timeout time.Duration) offline.Counts {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	_ = a.sync.DrainOnce(ctx)
	c, _ := a.db.Counts(context.Background())
	return c
}

// ---------- Đóng app khi còn thay đổi chờ đồng bộ (FR-009, E-008) ----------

// EventClosePending: sự kiện UI hiện hộp "Còn {n} mục chưa lên Drive" với "Đợi đồng bộ" / "Vẫn đóng".
const EventClosePending = "sync:close_pending"

// CloseFlush: thời gian thử đẩy nốt trước khi hỏi người dùng.
const CloseFlush = 5 * time.Second

// CloseGuard: dữ liệu của EventClosePending. Waiting = đang "Đợi đồng bộ" (app tự đóng khi đẩy xong).
type CloseGuard struct {
	Pending int  `json:"pending"` // số mục chưa lên Drive (CountOnClose)
	Total   int  `json:"total"`   // mọi thao tác chưa xong (kể cả Google Sheet)
	Waiting bool `json:"waiting"`
}

// BeforeClose: Wails OnBeforeClose. Còn thay đổi chờ thì thử đẩy nốt CloseFlush; vẫn còn thì giữ cửa sổ và phát
// EventClosePending để UI hỏi. Dữ liệu đã nằm an toàn trong máy; đóng thì lần mở sau app tự đồng bộ tiếp.
// Bấm đóng lần nữa trong CloseAgain sau khi đã hỏi = "Vẫn đóng" (không bao giờ kẹt cửa sổ nếu UI chưa hiện được hộp).
func (a *App) BeforeClose() (prevent bool) {
	if a.SkipCloseGuard || a.closing.Load() {
		return false // thoát để cập nhật exe (đã đồng bộ nốt trong ApplyUpdate) hoặc người dùng đã chọn
	}
	if at := a.askedAt.Load(); at != 0 && time.Since(time.Unix(0, at)) < CloseAgain {
		a.closing.Store(true)
		return false
	}
	a.FlushBeforeQuit(CloseFlush)
	n, total := a.closePending(context.Background())
	if n == 0 {
		return false
	}
	a.askedAt.Store(time.Now().UnixNano())
	a.Emit(EventClosePending, CloseGuard{Pending: n, Total: total, Waiting: a.waiting.Load()})
	return true
}

// CloseAgain: bấm đóng lần nữa trong khoảng này sau khi đã hỏi thì đóng luôn.
const CloseAgain = time.Minute

// ConfirmClose: trả lời hộp E-008. wait=false ("Vẫn đóng") đóng ngay; wait=true ("Đợi đồng bộ") đẩy tiếp và tự đóng
// khi không còn thay đổi đẩy được (lỗi cần người xử lý vẫn nằm trên máy), mỗi lượt phát lại số còn chờ cho UI.
func (a *App) ConfirmClose(wait bool) {
	if !wait {
		a.closing.Store(true)
		a.Quit()
		return
	}
	if !a.waiting.CompareAndSwap(false, true) {
		return // đang đợi rồi
	}
	go a.waitThenClose()
}

// closeRetry: giãn cách giữa các lượt đẩy khi đang "Đợi đồng bộ".
var closeRetry = 5 * time.Second

func (a *App) waitThenClose() {
	defer a.waiting.Store(false)
	for {
		ctx, cancel := context.WithTimeout(a.context(), 30*time.Second)
		_ = a.sync.DrainOnce(ctx)
		cancel()
		c, err := a.db.Counts(context.Background())
		n, total := a.closePending(context.Background())
		if err == nil && (c.Pending == 0 || n == 0) {
			a.closing.Store(true)
			a.Quit()
			return
		}
		a.Emit(EventClosePending, CloseGuard{Pending: n, Total: total, Waiting: true})
		select {
		case <-a.context().Done():
			return
		case <-time.After(closeRetry):
		}
	}
}

// ---------- Liên lạc với máy chủ bản quyền (E-021 của đồng bộ Drive) ----------

// ServerContact: lần nói chuyện được cuối với Worker (heartbeat, gia hạn, đăng nhập), theo đồng hồ tin cậy.
type ServerContact struct {
	LastAt int64         // giờ máy chủ lần cuối (0 = chưa từng)
	Age    time.Duration // thời gian đã trôi từ đó
	// GapSince/GapAge: lần mất liên lạc dài nhất đã kết thúc mà sản phẩm chưa báo Worker (0 = không có). Giữ lại vì
	// heartbeat có thể nối lại trước lượt báo trạng thái đồng bộ kế tiếp.
	GapSince int64
	GapAge   time.Duration
}

// ServerContact: xem kiểu ServerContact.
func (a *App) ServerContact() ServerContact {
	a.mu.Lock()
	since, gap := a.gapSince, a.gapAge
	a.mu.Unlock()
	return ServerContact{LastAt: a.clock.Anchor(), Age: a.clock.OfflineAge(), GapSince: since, GapAge: gap}
}

// ServerGapReported: Worker đã nhận báo mất liên lạc bắt đầu từ since: quên mốc đó (mốc mới hơn thì giữ).
func (a *App) ServerGapReported(since int64) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.gapSince == since {
		a.gapSince, a.gapAge = 0, 0
	}
}
