package core

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"deskcore/apperr"
	"deskcore/cloud"
	"deskcore/config"
	"deskcore/license"
	"deskcore/modules"
	"deskcore/netprog"
	"deskcore/offline"
	"deskcore/store"
)

// Phiên đăng nhập, heartbeat và các trạng thái toàn cục (E-005, E-006, E-016, E-019).

// AuthState: những gì UI cần để hiện hộp thoại / khoá màn toàn cục (xem web/src/platform/types.ts).
type AuthState struct {
	// Overlay: "" | expired (E-005) | offline_locked (E-006) | revoked (E-016) | locked_out (E-019).
	Overlay string `json:"overlay"`
	// At: giờ máy chủ của sự kiện (E-019: lúc bị khoá).
	At int64 `json:"at"`
	// OfflineDays: số ngày máy chưa kết nối (E-006 {n}).
	OfflineDays int `json:"offlineDays"`
	// OfflineLeftSec: còn bao nhiêu giây tới hạn offline; âm = đã quá hạn.
	OfflineLeftSec int64 `json:"offlineLeftSec"`
	// MustChangePassword: vừa đăng nhập bằng mật khẩu tạm, chỉ được đổi mật khẩu.
	MustChangePassword bool `json:"mustChangePassword"`
	// Pending: số thay đổi còn chờ đồng bộ (để cảnh báo khi đăng xuất).
	Pending int `json:"pending"`
	// Review: số thao tác đang chờ admin hoặc không được công nhận (E-018).
	Review int `json:"review"`
}

// apiErr đổi lỗi Worker thành lỗi có mã kèm tham số (minutes, lockedAt...) dạng "code: k=v,k=v" để UI điền {mm}, {dd/mm hh:mm}.
func apiErr(err error) error {
	var ae *cloud.APIError
	if !errors.As(err, &ae) || len(ae.Body) == 0 {
		return err
	}
	keys := make([]string, 0, len(ae.Body))
	for k := range ae.Body {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, fmt.Sprintf("%s=%v", k, ae.Body[k]))
	}
	return apperr.New(ae.Code, strings.Join(parts, ","))
}

func (a *App) offlineLimit() time.Duration {
	return time.Duration(config.AccountLimits.OfflineHours) * time.Hour
}

// trustedNow: giờ tin cậy theo thang giờ máy chủ.
func (a *App) trustedNow() int64 { return a.clock.Now() }

// licenseGuard: bản quyền máy dùng được. Token hết hạn offline (RefreshBy) mà máy vẫn trong 7 x 24 giờ tính theo đồng hồ tin cậy
// thì vẫn dùng; quá hạn thì báo E-006 thay vì "chưa có bản quyền".
func (a *App) licenseGuard() error {
	switch st := a.licenseInfo().Status; {
	case st.Usable():
		return nil
	case st == license.StatusOfflineExpired:
		if a.offlineExpired() {
			return apperr.New(apperr.CodeOfflineExpired, fmt.Sprintf("%d", int(a.clock.OfflineAge()/(24*time.Hour))))
		}
		return nil
	}
	return apperr.New(apperr.CodeNotLicensed, "máy chưa có bản quyền")
}

// offlineExpired: quá hạn làm việc offline (E-006).
func (a *App) offlineExpired() bool {
	return a.clock.Known() && a.clock.OfflineAge() > a.offlineLimit()
}

func (a *App) setOverlay(o *store.Overlay) {
	_ = a.st.Update(func(s *store.State) { s.Overlay = o })
	a.Emit("auth:state", a.authState(true))
}

// authState tổng hợp trạng thái toàn cục. online=false nghĩa là chưa biết/không có mạng.
func (a *App) authState(online bool) AuthState {
	st := a.st.Get()
	out := AuthState{}
	if st.Session != nil {
		out.MustChangePassword = st.Session.MustChangePassword
	}
	if a.clock.Known() {
		age := a.clock.OfflineAge()
		out.OfflineDays = int(age / (24 * time.Hour))
		out.OfflineLeftSec = int64((a.offlineLimit() - age) / time.Second)
	}
	if c, err := a.db.Counts(a.context()); err == nil {
		out.Pending, out.Review = c.Pending, c.Review+c.Rejected
	}
	switch {
	case st.Overlay != nil && (st.Overlay.Kind == "revoked" || st.Overlay.Kind == "locked_out"):
		out.Overlay, out.At = st.Overlay.Kind, st.Overlay.At
	case a.offlineExpired():
		out.Overlay = "offline_locked"
	case st.Overlay != nil:
		out.Overlay, out.At = st.Overlay.Kind, st.Overlay.At
	case st.Session != nil && st.Session.Exp <= a.trustedNow() && online:
		out.Overlay = "expired" // phiên hết hạn mà có mạng: đăng nhập lại, giữ nguyên việc đang làm
	}
	return out
}

// session: phiên còn hạn theo đồng hồ tin cậy (dùng để gọi máy chủ).
func (a *App) session() *store.Session {
	s := a.st.Get().Session
	if s == nil || s.Exp <= a.trustedNow() {
		return nil
	}
	return s
}

// sessionUser: người đang làm việc.
//   - Phiên còn hạn => có.
//   - Phiên hết hạn + MẤT MẠNG => vẫn có người dùng. Chưa quá hạn offline thì làm việc được (BR-009); quá hạn thì
//     màn làm việc bị khoá bằng E-006 (workGuard) nhưng dữ liệu còn nguyên, nên không đẩy về trang đăng nhập.
//   - Phiên hết hạn + có mạng => phải đăng nhập lại (E-005).
func (a *App) sessionUser(online bool) *store.User {
	s := a.st.Get().Session
	if s == nil {
		return nil
	}
	if s.Exp > a.trustedNow() || !online {
		u := s.User
		return &u
	}
	return nil
}

// noteContact ghi nhận một lần nói chuyện thành công với máy chủ: đặt lại đồng hồ offline.
// Trước khi đặt lại, nhớ lần mất liên lạc dài nhất chưa báo (ServerContact).
func (a *App) noteContact(serverNow int64) {
	if serverNow <= 0 {
		return
	}
	if a.clock.Known() {
		since, age := a.clock.Anchor(), a.clock.OfflineAge()
		a.mu.Lock()
		if age > a.gapAge {
			a.gapSince, a.gapAge = since, age
		}
		a.mu.Unlock()
	}
	a.clock.Contact(serverNow)
}

// Login đăng nhập bằng tên đăng nhập duy nhất toàn hệ thống (công ty suy ra từ tài khoản).
// Mất mạng hoặc máy chủ gián đoạn: đăng nhập lại offline nếu đã từng đăng nhập thành công trên máy này (BR-009).
func (a *App) Login(username, password string) (*store.User, error) {
	ctx, op := netprog.Begin(a.context(), OpLogin, "Đang đăng nhập")
	u, err := a.login(ctx, username, password)
	op.End(err)
	return u, err
}

func (a *App) login(ctx context.Context, username, password string) (*store.User, error) {
	if err := a.licenseGuard(); err != nil {
		return nil, err
	}
	p := a.payload()
	if p == nil {
		return nil, errors.New("device_not_licensed: máy chưa có bản quyền")
	}
	r, err := a.api.Login(ctx, username, password, p.Dev, p.DH)
	if err != nil {
		switch reach := cloud.ReachOf(err); reach {
		case cloud.ReachOK:
			return nil, apiErr(err)
		default:
			u, offErr := a.loginOffline(username, password)
			if offErr == nil {
				return u, nil
			}
			if apperr.CodeOf(offErr) == apperr.CodeFirstLoginNeedsNetwork {
				if reach == cloud.ReachServerDown {
					return nil, apperr.New(apperr.CodeServerUnavailable, "")
				}
				return nil, apperr.New(apperr.CodeFirstLoginNeedsNetwork, "")
			}
			return nil, offErr
		}
	}
	u := toUser(r.User)
	if p.Tenant != u.Tenant {
		// Worker đã chặn; giữ lại làm lớp phòng thủ và báo cùng câu E-001 để không lộ tài khoản có ở công ty khác.
		return nil, errors.New("invalid_credentials: tài khoản không thuộc công ty của bản quyền này")
	}
	a.noteContact(r.ServerNow)
	if err := a.st.Update(func(st *store.State) {
		st.Session = &store.Session{Token: r.Token, Exp: r.Exp, User: u, Username: strings.ToLower(strings.TrimSpace(username)),
			SessionVersion: r.SessionVersion, MustChangePassword: r.MustChangePassword}
		if st.Overlay != nil && st.Overlay.Kind != "revoked" { // máy bị thu hồi chỉ mở lại khi kích hoạt lại bản quyền
			st.Overlay = nil
		}
	}); err != nil {
		return nil, err
	}
	if !r.MustChangePassword {
		_ = a.rememberLogin(username, password, r.Entitlement) // thông tin đăng nhập offline: không chặn đăng nhập nếu lưu lỗi
	}
	a.sync.ClearNeedsLogin()
	a.Emit("auth:state", a.authState(true))
	return &u, nil
}

// ChangePassword đổi mật khẩu (cần mạng, E-020). Các máy khác và mọi phiên web phải đăng nhập lại; phiên này nhận token mới.
func (a *App) ChangePassword(current, next, confirm string) (*store.User, error) {
	ctx, op := netprog.Begin(a.context(), OpChangePassword, "Đang đổi mật khẩu")
	u, err := a.changePassword(ctx, current, next, confirm)
	op.End(err)
	return u, err
}

func (a *App) changePassword(ctx context.Context, current, next, confirm string) (*store.User, error) {
	s := a.st.Get().Session
	if s == nil {
		return nil, apperr.New(apperr.CodeUnauthorized, "")
	}
	r, err := a.api.ChangePassword(ctx, current, next, confirm)
	if err != nil {
		if cloud.IsOffline(err) {
			if cloud.ReachOf(err) == cloud.ReachServerDown {
				return nil, apperr.New(apperr.CodeServerUnavailable, "")
			}
			return nil, apperr.New(apperr.CodeNeedNetwork, "")
		}
		return nil, apiErr(err)
	}
	u := toUser(r.User)
	a.noteContact(r.ServerNow)
	if err := a.st.Update(func(st *store.State) {
		st.Session = &store.Session{Token: r.Token, Exp: r.Exp, User: u, Username: s.Username, SessionVersion: r.SessionVersion}
		st.Overlay = nil
	}); err != nil {
		return nil, err
	}
	_ = a.rememberLogin(s.Username, next, r.Entitlement)
	a.Emit("auth:state", a.authState(true))
	return &u, nil
}

// Logout đăng xuất và trả số thay đổi còn chờ đồng bộ để UI báo. Dữ liệu vẫn giữ trên máy và được đẩy lên khi máy kết nối,
// dù chưa ai đăng nhập lại (BR-017).
func (a *App) Logout() (int, error) {
	a.mu.Lock()
	a.gtok = nil
	a.mu.Unlock()
	if err := a.st.Update(func(st *store.State) {
		st.Session = nil
		if st.Overlay != nil && st.Overlay.Kind == "expired" { // hộp "phiên hết hạn" chỉ có nghĩa khi còn phiên; để lại thì che cả màn kích hoạt
			st.Overlay = nil
		}
	}); err != nil {
		return 0, err
	}
	a.sync.Trigger()
	c, _ := a.db.Counts(a.context())
	a.Emit("auth:state", a.authState(true))
	return c.Pending + c.Review, nil
}

// AuthState cho UI.
func (a *App) AuthState() AuthState { return a.authState(a.online(a.context())) }

// ---------- Vòng nền: đồng hồ, heartbeat, gia hạn bản quyền ----------

func (a *App) runLoops() {
	tick := time.NewTicker(time.Minute)
	defer tick.Stop()
	hb := time.Duration(config.AccountLimits.RevocationHeartbeatMinutes) * time.Minute
	lic := time.Duration(config.AccountLimits.LicenseRefreshHours) * time.Hour / 12 // kiểm tra mỗi 30 phút, gia hạn khi tới hạn
	var lastHB, lastLic time.Time
	for {
		a.clock.Tick()
		now := time.Now()
		if now.Sub(lastLic) >= lic {
			lastLic = now
			if a.st.Get().DeviceID != "" && a.licenseInfo().Status != license.StatusValid {
				_ = a.refreshLicense(a.context())
			}
		}
		if now.Sub(lastHB) >= hb {
			lastHB = now
			a.heartbeatOnce(a.context())
		}
		select {
		case <-a.context().Done():
			a.clock.Tick()
			return
		case <-tick.C:
		}
	}
}

// heartbeatOnce: NFR-005. Có phiên và có mạng thì hỏi máy chủ tài khoản còn hoạt động, quyền/app có đổi, máy còn bản quyền.
func (a *App) heartbeatOnce(ctx context.Context) {
	s := a.st.Get()
	if s.Session == nil || s.DeviceID == "" {
		return // chưa đăng nhập
	}
	if s.Session.Offline || s.Session.Token == "" {
		// Phiên dựng lại từ ảnh chụp quyền khi mất mạng: không có token máy chủ để hỏi. Có mạng lại thì bắt đăng nhập online
		// (E-005, giữ nguyên việc đang làm) để nhận khoá, hạ vai, đổi mật khẩu thay vì chờ tối đa 7 ngày.
		if a.online(ctx) {
			a.setOverlay(&store.Overlay{Kind: "expired"})
		}
		return
	}
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	hb, err := a.api.Heartbeat(ctx, s.DeviceID, a.devHash)
	if err != nil {
		a.onSessionError(err, s.Session)
		return
	}
	a.noteContact(hb.ServerNow)
	if !hb.Active {
		a.handleLockedOut(hb.LockedAt, s.Session)
		return
	}
	a.applyHeartbeat(ctx, s.Session, hb)
}

// onSessionError: lỗi từ máy chủ khi hỏi bằng phiên. Mất mạng thì bỏ qua (làm việc offline theo BR-009).
func (a *App) onSessionError(err error, sess *store.Session) {
	if cloud.IsOffline(err) {
		return
	}
	var ae *cloud.APIError
	if !errors.As(err, &ae) {
		return
	}
	switch {
	case ae.Code == "locked_in_use":
		at, _ := ae.Body["lockedAt"].(float64)
		a.handleLockedOut(int64(at), sess)
	case ae.Status == 401: // session_expired (đổi mật khẩu/thu hồi ở nơi khác) hoặc token hết hạn
		if sess.Username != "" {
			a.forgetLogin(sess.Username) // mật khẩu có thể đã đổi: bắt đăng nhập online lại thay vì cho dùng mật khẩu cũ offline
		}
		a.setOverlay(&store.Overlay{Kind: "expired"})
	}
}

// handleLockedOut: tài khoản đang đăng nhập vừa bị khoá. Đẩy thay đổi chờ lên MỘT lần rồi đăng xuất (E-019, BR-017).
func (a *App) handleLockedOut(lockedAt int64, sess *store.Session) {
	a.pushOnce()
	if sess != nil && sess.Username != "" {
		a.forgetLogin(sess.Username) // khoá rồi thì không được đăng nhập lại offline bằng mật khẩu cũ
	}
	_ = a.st.Update(func(st *store.State) {
		st.Session = nil
		st.Overlay = &store.Overlay{Kind: "locked_out", At: lockedAt}
	})
	a.mu.Lock()
	a.gtok = nil
	a.mu.Unlock()
	a.Emit("auth:state", a.authState(true))
}

// handleRevoked: máy bị thu hồi bản quyền (E-016). Đẩy một lần rồi khoá màn làm việc, dữ liệu vẫn giữ.
func (a *App) handleRevoked() {
	a.pushOnce()
	a.forgetLogin("")
	_ = a.st.Update(func(st *store.State) {
		st.LicenseToken = ""
		st.Session = nil
		st.Overlay = &store.Overlay{Kind: "revoked"}
	})
	a.Emit("auth:state", a.authState(true))
}

// pushOnce đẩy hàng đợi một lượt (tối đa 20 giây), bằng phiên hoặc chữ ký máy.
func (a *App) pushOnce() {
	ctx, cancel := context.WithTimeout(a.context(), 20*time.Second)
	defer cancel()
	_ = a.sync.DrainOnce(ctx)
}

func (a *App) applyHeartbeat(ctx context.Context, sess *store.Session, hb *cloud.HeartbeatResp) {
	changed := false
	_ = a.st.Update(func(st *store.State) {
		if st.Session == nil {
			return
		}
		if hb.Token != "" {
			st.Session.Token, st.Session.Exp = hb.Token, hb.Exp
		}
		// Lần đầu thì ghi nhận; sau đó khác nhau nghĩa là quyền/app của người này hoặc bảng quyền đã đổi.
		if st.Session.PermsVersion != 0 && st.Session.PermsVersion != hb.PermsVersion {
			changed = true
		}
		if st.Session.AppsVersion != 0 && st.Session.AppsVersion != hb.AppsVersion {
			changed = true
		}
		st.Session.PermsVersion, st.Session.AppsVersion = hb.PermsVersion, hb.AppsVersion
		if st.Session.SessionVersion == 0 {
			st.Session.SessionVersion = hb.SessionVersion
		}
	})
	if changed {
		a.refreshSession(ctx) // hạ vai, bỏ app, đổi bảng quyền: nhận quyền mới trong tối đa 15 phút
	}
	switch hb.LicenseState {
	case "revoked":
		a.handleRevoked()
		return
	case "suspended", "expired":
		_ = a.refreshLicense(ctx) // 403 => token bị xoá, máy khoá
	case "ok":
		if p := a.payload(); p != nil && !sameSet(p.Apps, hb.LicenseApps) {
			_ = a.refreshLicense(ctx) // bên triển khai bật/tắt app: nhận ngay thay vì đợi 6 giờ
		}
	}
	a.pollDecisions(ctx)
	a.sync.Trigger()
	a.Emit("auth:state", a.authState(true))
}

func sameSet(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	m := map[string]bool{}
	for _, x := range a {
		m[x] = true
	}
	for _, y := range b {
		if !m[y] {
			return false
		}
	}
	return true
}

// refreshSession lấy phiên mới và quyền hiện hành (vai, app, bảng quyền) từ máy chủ.
func (a *App) refreshSession(ctx context.Context) {
	sess := a.session()
	if sess == nil || sess.Token == "" {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	r, err := a.api.RefreshSession(ctx)
	if err != nil {
		a.onSessionError(err, sess)
		return
	}
	a.noteContact(r.ServerNow)
	_ = a.st.Update(func(st *store.State) {
		if st.Session == nil {
			return
		}
		st.Session.Token, st.Session.Exp = r.Token, r.Exp
		if r.User != nil {
			st.Session.User = toUser(*r.User)
		}
	})
	a.refreshEntitlement(sess.Username, r.Entitlement)
}

func toUser(u cloud.UserInfo) store.User {
	return store.User{ID: u.ID, Tenant: u.Tenant, Name: u.Name, Role: u.Role, Apps: u.Apps, Perms: u.Perms}
}

// ---------- Ai làm gì (FR-022) ----------

// WorkingActor: người đang làm việc, máy này, giờ tin cậy. Gắn vào mọi thao tác ghi.
func (a *App) WorkingActor() (offline.Actor, error) {
	if err := a.workGuard(); err != nil {
		return offline.Actor{}, err
	}
	st := a.st.Get()
	if st.Session == nil {
		return offline.Actor{}, apperr.New(apperr.CodeUnauthorized, "chưa đăng nhập")
	}
	if st.Session.MustChangePassword {
		return offline.Actor{}, apperr.New(apperr.CodePasswordChangeRequired, "")
	}
	return offline.Actor{
		UserID: st.Session.User.ID, Name: st.Session.User.Name, DeviceID: st.DeviceID,
		At: a.clock.Now(), Anchor: a.clock.Anchor(), DeviceTime: a.clock.wall().Unix(),
	}, nil
}

// workGuard: các điều kiện chặn mọi việc làm: máy bị thu hồi, tài khoản vừa bị khoá, quá hạn offline.
func (a *App) workGuard() error {
	if o := a.st.Get().Overlay; o != nil {
		switch o.Kind {
		case "revoked":
			return apperr.New(apperr.CodeDeviceRevoked, "")
		case "locked_out":
			return apperr.New(apperr.CodeLockedInUse, "")
		}
	}
	if a.offlineExpired() {
		return apperr.New(apperr.CodeOfflineExpired, fmt.Sprintf("%d", int(a.clock.OfflineAge()/(24*time.Hour))))
	}
	return nil
}

// ---------- Quyền (NFR-002) ----------

// RequirePerm: người đang làm việc có quyền `perm` theo ảnh chụp quyền của vai. Không có quyền => permission_denied (E-011).
// Vai Vipo không có quyền nào trong bảng; admin luôn có mọi quyền (store.User.Has).
func (a *App) RequirePerm(perm string) error {
	if err := a.workGuard(); err != nil {
		return err
	}
	st := a.st.Get()
	if st.Session == nil {
		return apperr.New(apperr.CodeUnauthorized, "chưa đăng nhập")
	}
	if st.Session.MustChangePassword {
		return apperr.New(apperr.CodePasswordChangeRequired, "") // mật khẩu tạm: chỉ được đổi mật khẩu
	}
	if !modulesKnownPerm(perm) || !st.Session.User.Has(perm) {
		return apperr.New(apperr.CodePermissionDenied, perm)
	}
	return nil
}

func modulesKnownPerm(perm string) bool {
	for _, p := range modules.Perms {
		if p == perm {
			return true
		}
	}
	return false
}
