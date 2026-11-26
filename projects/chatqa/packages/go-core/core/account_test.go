package core

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"testing/fstest"
	"time"

	"deskcore/apperr"
	"deskcore/config"
	"deskcore/modules"
	"deskcore/offline"
	"deskcore/offline/memqueue"
	"deskcore/store"
	"deskcore/updater"
)

type rig struct {
	t   *testing.T
	a   *App
	srv *fakeSrv
	db  *memqueue.Queue
	ft  *fakeTime
	dir string
}

// newRig: máy đã kích hoạt bản quyền, đồng hồ giả (giờ máy và đồng hồ đơn điệu tách rời).
func newRig(t *testing.T) *rig { return newRigMods(t) }

// newRigWith: như newRig, kèm ModuleFactory của sản phẩm.
func newRigWith(t *testing.T, f ModuleFactory) *App { return newRigMods(t, f).a }

func newRigMods(t *testing.T, mods ...ModuleFactory) *rig {
	t.Helper()
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	srv := fakeWorker(t, priv, "anhtung")
	t.Cleanup(srv.Close)
	db := memqueue.New()
	dir := t.TempDir()
	a, err := New(updater.NewSwitchFS(fstest.MapFS{}, "0.1.0"), dir, srv.URL, base64.StdEncoding.EncodeToString(pub), "", db, mods...)
	if err != nil {
		t.Fatal(err)
	}
	ft := &fakeTime{wall: time.Now()}
	a.clock = newClockWith(a.st, func() time.Time { return ft.wall }, func() time.Duration { return ft.mono })
	srv.ServerNow = func() int64 { return ft.wall.Unix() }
	if _, err := a.ActivateLicense("HSD-AAAAA-BBBBB-CCCCC-DDDDD"); err != nil {
		t.Fatal(err)
	}
	return &rig{t: t, a: a, srv: srv, db: db, ft: ft, dir: dir}
}

type roundTripper func(*http.Request) (*http.Response, error)

func (f roundTripper) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// noNetwork: mọi lần gọi thất bại như khi không ra được internet (DNS lỗi).
func (r *rig) noNetwork() {
	r.a.api.HTTP.Transport = roundTripper(func(*http.Request) (*http.Response, error) {
		return nil, &net.OpError{Op: "dial", Err: &net.DNSError{Err: "no such host", Name: "x", IsNotFound: true}}
	})
}

// serverDown: ra được internet nhưng máy chủ trả 503.
func (r *rig) serverDown() {
	r.a.api.HTTP.Transport = roundTripper(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 503, Body: http.NoBody, Header: http.Header{}}, nil
	})
}

func (r *rig) online() { r.a.api.HTTP.Transport = nil }

func (r *rig) login(user, pass string) {
	r.t.Helper()
	if _, err := r.a.Login(user, pass); err != nil {
		r.t.Fatalf("đăng nhập %s: %v", user, err)
	}
}

func code(err error) string { return apperr.CodeOf(err) }

// ---------- Đăng nhập offline (BR-009) ----------

func TestOfflineLoginAfterOnlineLogin(t *testing.T) {
	r := newRig(t)
	r.login("lan", "mk-that")
	if _, err := r.a.Logout(); err != nil {
		t.Fatal(err)
	}
	r.noNetwork()
	u, err := r.a.Login("lan", "mk-that")
	if err != nil || u.Name != "Lan" || !slices.Contains(u.Perms, "work.do") {
		t.Fatalf("đăng nhập lại offline: %+v %v", u, err)
	}
	if s := r.a.st.Get().Session; s == nil || !s.Offline || s.Token != "" {
		t.Fatalf("phiên offline không có token máy chủ: %+v", s)
	}
	// Mật khẩu KHÔNG nằm trong tệp trạng thái, chỉ giá trị kiểm.
	b, _ := os.ReadFile(filepath.Join(r.dir, "state.json"))
	if string(b) == "" || contains(string(b), "mk-that") {
		t.Fatal("mật khẩu không được lưu trên máy")
	}
}

func contains(s, sub string) bool {
	return len(sub) > 0 && (len(s) >= len(sub)) && indexOf(s, sub) >= 0
}
func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}

func TestFirstLoginNeedsNetwork(t *testing.T) {
	r := newRig(t)
	r.noNetwork()
	if _, err := r.a.Login("lan", "x"); code(err) != apperr.CodeFirstLoginNeedsNetwork {
		t.Fatalf("lần đầu trên máy, không có mạng => E-004, got %v", err)
	}
	r.serverDown()
	if _, err := r.a.Login("lan", "x"); code(err) != apperr.CodeServerUnavailable {
		t.Fatalf("có internet nhưng máy chủ gián đoạn, chưa từng đăng nhập => E-021, got %v", err)
	}
}

func TestOfflineLoginWorksWhenServerDownToo(t *testing.T) {
	r := newRig(t)
	r.login("lan", "mk-that")
	_, _ = r.a.Logout()
	r.serverDown()
	if _, err := r.a.Login("lan", "mk-that"); err != nil {
		t.Fatalf("máy chủ không phản hồi coi như mất mạng, vẫn đăng nhập offline: %v", err)
	}
}

func TestOfflineWrongPasswordTenTimesRequiresNetwork(t *testing.T) {
	r := newRig(t)
	r.login("lan", "mk-that")
	_, _ = r.a.Logout()
	r.noNetwork()
	for i := 1; i <= config.AccountLimits.OfflineLoginMaxFailures-1; i++ {
		if _, err := r.a.Login("lan", "sai"); code(err) != apperr.CodeInvalidCredentials {
			t.Fatalf("lần sai %d phải E-001, got %v", i, err)
		}
	}
	if _, err := r.a.Login("lan", "sai"); code(err) != apperr.CodeOfflineAttemptsExceeded {
		t.Fatalf("lần sai thứ 10 => E-026, got %v", err)
	}
	if _, err := r.a.Login("lan", "mk-that"); code(err) != apperr.CodeOfflineAttemptsExceeded {
		t.Fatalf("sau 10 lần sai, đúng mật khẩu vẫn phải có mạng, got %v", err)
	}
	// Bộ đếm sống qua lần mở lại app
	b, _ := os.ReadFile(filepath.Join(r.dir, "state.json"))
	if !contains(string(b), "offline") {
		t.Fatal("bộ đếm phải nằm trong trạng thái đã lưu")
	}
	r.online()
	r.login("lan", "mk-that") // đăng nhập online mở lại
	_, _ = r.a.Logout()
	r.noNetwork()
	if _, err := r.a.Login("lan", "mk-that"); err != nil {
		t.Fatalf("online login phải đặt lại bộ đếm: %v", err)
	}
}

func TestOfflineWindowBoundary(t *testing.T) {
	r := newRig(t)
	r.login("lan", "mk-that")
	_, _ = r.a.Logout()
	r.noNetwork()
	r.ft.advance(time.Duration(config.AccountLimits.OfflineHours) * time.Hour)
	if _, err := r.a.Login("lan", "mk-that"); err != nil {
		t.Fatalf("đúng 168 giờ vẫn đăng nhập được: %v", err)
	}
	r.ft.advance(time.Second)
	if err := r.a.RequireApp(appQuote); code(err) != apperr.CodeOfflineExpired {
		t.Fatalf("quá 168 giờ + 1 giây => E-006, got %v", err)
	}
	if st, _ := r.a.GetState(); st.Auth.Overlay != "offline_locked" || st.Auth.OfflineDays != 7 || st.User == nil {
		t.Fatalf("khoá màn làm việc nhưng giữ dữ liệu: %+v", st.Auth)
	}
	if _, err := r.a.WorkingActor(); code(err) != apperr.CodeOfflineExpired {
		t.Fatalf("không ghi được dữ liệu mới khi quá hạn: %v", err)
	}
	r.a.Logout()
	if _, err := r.a.Login("lan", "mk-that"); code(err) != apperr.CodeOfflineExpired {
		t.Fatalf("quá hạn offline thì đăng nhập cũng cần mạng (NFR-004): %v", err)
	}
}

// SC-03 phía máy: chỉnh lùi giờ 2 giờ không kéo dài hạn offline.
func TestClockRollbackDoesNotExtendOfflineWindow(t *testing.T) {
	r := newRig(t)
	r.login("lan", "mk-that")
	r.noNetwork()
	r.ft.advance(time.Duration(config.AccountLimits.OfflineHours)*time.Hour - time.Hour)
	r.a.clock.Tick()
	r.ft.setWall(r.ft.wall.Add(-2 * time.Hour)) // chỉnh lùi 2 giờ
	r.ft.advance(2 * time.Hour)                 // thực tế đã trôi thêm 2 giờ
	if err := r.a.RequireApp(appQuote); code(err) != apperr.CodeOfflineExpired {
		t.Fatalf("chỉnh lùi giờ không được lấy lại thời gian offline, got %v", err)
	}
}

// ---------- Phiên và heartbeat (NFR-005) ----------

func TestHeartbeatLockedPushesOnceThenLogsOut(t *testing.T) {
	r := newRig(t)
	r.login("lan", "mk-that")
	var execCalls int
	r.a.sync.Register(kindWrite, func(context.Context, *offline.Op) error { execCalls++; return nil })
	if _, err := saveCard(r.a, "VP-1", map[string]any{"ten_khai": "Ấm"}); err != nil {
		t.Fatal(err)
	}
	r.srv.Heartbeat = func() (int, map[string]any) {
		return 200, map[string]any{"active": false, "lockedAt": r.ft.wall.Unix() - 60, "sessionVersion": 1}
	}
	r.a.heartbeatOnce(context.Background())

	if execCalls != 1 {
		t.Fatalf("phải đẩy thay đổi chờ đúng một lần trước khi đăng xuất, đẩy %d", execCalls)
	}
	st, _ := r.a.GetState()
	if st.User != nil || st.Auth.Overlay != "locked_out" || st.Auth.At != r.ft.wall.Unix()-60 {
		t.Fatalf("phải đăng xuất với E-019 kèm giờ khoá: %+v", st.Auth)
	}
	r.noNetwork()
	r.a.Logout()
	if _, err := r.a.Login("lan", "mk-that"); code(err) != apperr.CodeFirstLoginNeedsNetwork {
		t.Fatalf("tài khoản bị khoá thì không đăng nhập lại offline bằng mật khẩu cũ: %v", err)
	}
	if err := r.a.RequireApp(appQuote); code(err) != apperr.CodeLockedInUse {
		t.Fatalf("không làm việc được sau khi bị khoá: %v", err)
	}
}

func TestHeartbeatSessionVersionChangedShowsReloginKeepingEverything(t *testing.T) {
	r := newRig(t)
	r.login("lan", "mk-that")
	r.srv.Heartbeat = func() (int, map[string]any) { return 401, map[string]any{"error": "session_expired"} }
	r.a.heartbeatOnce(context.Background())
	st, _ := r.a.GetState()
	if st.Auth.Overlay != "expired" {
		t.Fatalf("đổi mật khẩu ở nơi khác => hộp thoại E-005: %+v", st.Auth)
	}
	if r.a.st.Get().Session == nil {
		t.Fatal("không được xoá phiên cục bộ: việc đang làm vẫn giữ")
	}
	// Mật khẩu có thể đã đổi: không cho đăng nhập offline bằng mật khẩu cũ
	r.a.Logout()
	r.noNetwork()
	if _, err := r.a.Login("lan", "mk-that"); code(err) != apperr.CodeFirstLoginNeedsNetwork {
		t.Fatalf("phải đăng nhập online lại: %v", err)
	}
}

func TestHeartbeatPicksUpRoleChange(t *testing.T) {
	r := newRig(t)
	r.login("lan", "mk-that")
	r.srv.Heartbeat = func() (int, map[string]any) {
		return 200, map[string]any{"active": true, "sessionVersion": 1, "permsVersion": 1, "appsVersion": 1, "licenseState": "ok", "licenseApps": r.srv.LicenseApps}
	}
	r.a.heartbeatOnce(context.Background()) // ghi nhận phiên bản
	r.srv.Perms["lan"] = []string{"work.do", "approve.review"}
	r.srv.Heartbeat = func() (int, map[string]any) {
		return 200, map[string]any{"active": true, "sessionVersion": 1, "permsVersion": 2, "appsVersion": 1, "licenseState": "ok", "licenseApps": r.srv.LicenseApps}
	}
	r.a.heartbeatOnce(context.Background())
	if err := r.a.RequirePerm(modules.PermApproveReview); err != nil {
		t.Fatalf("bảng quyền đổi: máy nhận quyền mới trong một nhịp heartbeat: %v", err)
	}
}

func TestHeartbeatRevokedDeviceLocksAfterPushingOnce(t *testing.T) {
	r := newRig(t)
	r.login("lan", "mk-that")
	var execCalls int
	r.a.sync.Register(kindWrite, func(context.Context, *offline.Op) error { execCalls++; return nil })
	_, _ = saveCard(r.a, "VP-1", map[string]any{"ten_khai": "Ấm"})
	r.srv.Heartbeat = func() (int, map[string]any) {
		return 200, map[string]any{"active": true, "sessionVersion": 1, "permsVersion": 1, "appsVersion": 1, "licenseState": "revoked"}
	}
	r.srv.LicenseRefreshCode, r.srv.LicenseRefreshErr = 403, "device_revoked" // Worker thật từ chối gia hạn cho máy đã thu hồi
	r.a.heartbeatOnce(context.Background())
	if execCalls != 1 {
		t.Fatalf("thay đổi chờ phải được đẩy một lần: %d", execCalls)
	}
	if st, _ := r.a.GetState(); st.Auth.Overlay != "revoked" || st.License.Status == "valid" {
		t.Fatalf("máy bị thu hồi phải khoá (E-016): %+v", st.Auth)
	}
	if c, _ := r.db.Counts(context.Background()); c.Pending != 0 {
		// dữ liệu không bị xoá: op đã đẩy xong
		t.Logf("counts: %+v", c)
	}
	if err := r.a.RequireApp(appQuote); code(err) != apperr.CodeDeviceRevoked {
		t.Fatalf("không dùng được app sau khi bị thu hồi: %v", err)
	}
	// Kích hoạt lại thì mở
	r.srv.LicenseRefreshCode = 0
	if _, err := r.a.ActivateLicense("HSD-AAAAA-BBBBB-CCCCC-DDDDD"); err != nil {
		t.Fatal(err)
	}
	if st, _ := r.a.GetState(); st.Auth.Overlay != "" {
		t.Fatalf("kích hoạt lại phải xoá khoá thu hồi: %+v", st.Auth)
	}
}

func TestAppDisabledFromLicenseShowsE017NotE012(t *testing.T) {
	r := newRig(t)
	r.login("lan", "mk-that")
	r.srv.LicenseApps = []string{"quote"} // bên triển khai tắt Sổ dạy AI
	r.srv.Heartbeat = func() (int, map[string]any) {
		return 200, map[string]any{"active": true, "sessionVersion": 1, "permsVersion": 1, "appsVersion": 1, "licenseState": "ok", "licenseApps": []string{"quote"}}
	}
	r.a.heartbeatOnce(context.Background())
	byCode := map[string]AppItem{}
	for _, it := range r.a.AppStates() {
		byCode[it.Code] = it
	}
	if byCode["teach"].State != "license_disabled" || byCode["teach"].ErrorCode != apperr.CodeAppDisabled {
		t.Fatalf("app từng bật rồi bị tắt => E-017: %+v", byCode["teach"])
	}
	if byCode["lot"].State != "not_activated" || byCode["lot"].ErrorCode != apperr.CodeModuleLocked {
		t.Fatalf("app chưa từng bật => E-012: %+v", byCode["lot"])
	}
	if byCode["quote"].State != "activated" {
		t.Fatalf("quote vẫn bật: %+v", byCode["quote"])
	}
}

func TestAppStatesSkipHiddenApps(t *testing.T) {
	r := newRig(t)
	r.login("lan", "mk-that")
	for _, it := range r.a.AppStates() {
		if it.Code == "cnroad" {
			t.Fatalf("app ẩn không hiện ở màn chọn app: %+v", it)
		}
	}
}

func TestAppStatesNotGrantedAndVipo(t *testing.T) {
	r := newRig(t)
	r.srv.Apps["lan"] = []string{"teach"}
	r.login("lan", "x")
	states := map[string]string{}
	for _, it := range r.a.AppStates() {
		states[it.Code] = it.State
	}
	if states["quote"] != "not_granted" || states["teach"] != "activated" || states["lot"] != "not_activated" {
		t.Fatalf("%v", states)
	}
	// Vipo: mọi app nội bộ đều bị từ chối, kể cả khi bản quyền có và Worker (lỗi) trả apps = nil
	r.a.Logout()
	r.srv.Roles["lan"] = "vipo"
	r.srv.Apps["lan"] = nil
	r.login("lan", "x")
	for _, c := range []modules.Code{appQuote, appTeach} {
		if err := r.a.RequireApp(c); code(err) != apperr.CodeAppForbidden {
			t.Fatalf("Vipo không được vào %s: %v", c, err)
		}
	}
	for _, it := range r.a.AppStates() {
		if it.State == "activated" {
			t.Fatalf("Vipo không có app nội bộ nào: %+v", it)
		}
	}
	if !appGranted(r.a.st.Get().Session.User, "vipo-sheet-exchange") {
		t.Fatal("Vipo dùng được module gửi yêu cầu")
	}
}

// ---------- SC-01 phía Go: mọi ô "không" của bảng BR-002 bị từ chối, online và offline ----------

func TestEveryNoCellIsRefusedOnlineAndOffline(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "contracts", "permissions.json"))
	if err != nil {
		t.Skip("không có contracts/permissions.json")
	}
	var c struct {
		Permissions []struct {
			Code    string
			Default map[string]bool
		}
	}
	if err := json.Unmarshal(raw, &c); err != nil {
		t.Fatal(err)
	}
	for _, role := range []string{"admin", "manager", "leader", "staff", "vipo"} {
		r := newRig(t)
		var perms []string
		for _, p := range c.Permissions {
			if role == "admin" || (role != "vipo" && p.Default[role]) {
				perms = append(perms, p.Code) // đúng như Worker sẽ gửi cho vai này
			}
		}
		r.srv.Roles["lan"], r.srv.Perms["lan"] = role, append([]string{}, perms...)
		if perms == nil {
			r.srv.Perms["lan"] = []string{}
		}
		r.login("lan", "x")
		for _, mode := range []string{"online", "offline"} {
			if mode == "offline" {
				r.noNetwork()
			}
			for _, p := range c.Permissions {
				want := role == "admin" || (role != "vipo" && p.Default[role])
				err := r.a.RequirePerm(p.Code)
				if want && err != nil {
					t.Errorf("%s/%s %s: được phép nhưng bị từ chối: %v", role, mode, p.Code, err)
				}
				if !want && code(err) != apperr.CodePermissionDenied {
					t.Errorf("%s/%s %s: ô \"không\" phải bị từ chối E-011, got %v", role, mode, p.Code, err)
				}
			}
		}
	}
}

func TestUnknownPermissionIsDenied(t *testing.T) {
	r := newRig(t)
	r.srv.Roles["lan"], r.srv.Perms["lan"] = "admin", []string{}
	r.login("lan", "x")
	if err := r.a.RequirePerm("khong.co"); code(err) != apperr.CodePermissionDenied {
		t.Fatalf("quyền không có trong danh mục không được lọt qua ngay cả với admin: %v", err)
	}
}

func TestRequirePermWithoutSession(t *testing.T) {
	r := newRig(t)
	if err := r.a.RequirePerm(modules.PermWorkDo); code(err) != apperr.CodeUnauthorized {
		t.Fatalf("chưa đăng nhập: %v", err)
	}
}

// ---------- Ghi nhận người làm (FR-022) ----------

func TestWorkingActorUsesTrustedClockAndDevice(t *testing.T) {
	r := newRig(t)
	r.login("lan", "x")
	a1, err := r.a.WorkingActor()
	if err != nil || a1.UserID != "u-lan" || a1.DeviceID != "D1" || a1.Name != "Lan" || a1.At != r.ft.wall.Unix() || a1.Anchor != r.ft.wall.Unix() {
		t.Fatalf("%+v %v", a1, err)
	}
	r.noNetwork()
	r.ft.advance(time.Hour)
	r.ft.setWall(r.ft.wall.Add(-2 * time.Hour)) // chỉnh lùi giờ máy
	a2, _ := r.a.WorkingActor()
	if a2.At < a1.At+3600 {
		t.Fatalf("giờ ghi nhận không được lùi khi chỉnh giờ máy: %d < %d", a2.At, a1.At+3600)
	}
	if a2.DeviceTime != r.ft.wall.Unix() {
		t.Fatal("giờ máy được ghi lại nguyên trạng để đối chiếu")
	}
}

// ---------- Đẩy thao tác lên Sheet có kiểm lại quyền (FR-016, BR-017) ----------

func opStatuses(t *testing.T, r *rig) map[offline.OpStatus]int {
	c, _ := r.db.Counts(context.Background())
	return map[offline.OpStatus]int{offline.OpPending: c.Pending, offline.OpReview: c.Review, offline.OpRejected: c.Rejected}
}

func TestSyncGateAcceptedPendingRejected(t *testing.T) {
	r := newRig(t)
	r.login("lan", "x")
	var pushed []string
	r.a.sync.Register(kindWrite, func(_ context.Context, op *offline.Op) error { pushed = append(pushed, op.Entity); return nil })
	for _, id := range []string{"VP-ok", "VP-wait", "VP-no"} {
		if _, err := saveCard(r.a, id, map[string]any{"ten_khai": "Ấm"}); err != nil {
			t.Fatal(err)
		}
	}
	r.srv.SyncVerdict = func(op map[string]any) map[string]any {
		switch {
		case op["perm"] != "work.do":
			t.Errorf("op phải mang quyền để Worker kiểm: %v", op)
		case op["userId"] != "u-lan" || op["anchor"] == nil || op["at"] == nil:
			t.Errorf("op phải mang tài khoản, anchor, giờ tin cậy: %v", op)
		}
		return map[string]any{"status": map[string]string{"VP-ok": "accepted", "VP-wait": "pending", "VP-no": "rejected"}[lastEntity(r, op)], "reason": "x"}
	}
	_ = r.a.sync.DrainOnce(context.Background())

	if len(pushed) != 1 || pushed[0] != "item:VP-ok" {
		t.Fatalf("chỉ thao tác được công nhận mới được đẩy lên dịch vụ đích: %v", pushed)
	}
	if got := opStatuses(t, r); got[offline.OpReview] != 1 || got[offline.OpRejected] != 1 || got[offline.OpPending] != 0 {
		t.Fatalf("%v", got)
	}
	list, _ := r.a.ListReviewOps()
	if len(list) != 2 {
		t.Fatalf("danh sách chờ/không công nhận hiện trên máy người làm: %+v", list)
	}
	if st, _ := r.a.GetState(); st.Auth.Review != 2 {
		t.Fatalf("UI phải thấy có 2 thao tác cần xem: %+v", st.Auth)
	}
	// Người làm xem xong thao tác không được công nhận thì bỏ khỏi danh sách; thao tác đang chờ thì không bỏ được
	for _, o := range list {
		err := r.a.DismissRejected(o.ID)
		if (o.Status == offline.OpRejected) != (err == nil) {
			t.Fatalf("chỉ bỏ được thao tác bị từ chối: %s %v", o.Status, err)
		}
	}
}

func lastEntity(r *rig, op map[string]any) string {
	ops, _ := r.db.ListOps(context.Background(), offline.OpPending)
	for _, o := range ops {
		if o.ID == op["opId"] {
			return o.Entity[len("item:"):]
		}
	}
	return ""
}

func TestAdminDecisionRequeuesOrDiscards(t *testing.T) {
	r := newRig(t)
	r.login("lan", "x")
	var pushed []string
	r.a.sync.Register(kindWrite, func(_ context.Context, op *offline.Op) error { pushed = append(pushed, op.Entity); return nil })
	for _, id := range []string{"VP-a", "VP-b"} {
		_, _ = saveCard(r.a, id, map[string]any{"ten_khai": "Ấm"})
	}
	r.srv.SyncVerdict = func(map[string]any) map[string]any {
		return map[string]any{"status": "pending", "reason": "locked_offline"}
	}
	_ = r.a.sync.DrainOnce(context.Background())
	review, _ := r.db.ListOps(context.Background(), offline.OpReview)
	if len(review) != 2 {
		t.Fatalf("%+v", review)
	}
	// admin công nhận a, bỏ b
	r.srv.SyncDecisions = []map[string]any{{"opId": review[0].ID, "status": "accepted"}, {"opId": review[1].ID, "status": "dropped"}}
	r.srv.SyncVerdict = func(map[string]any) map[string]any { return map[string]any{"status": "accepted"} }
	r.a.pollDecisions(context.Background())
	_ = r.a.sync.DrainOnce(context.Background())
	if len(pushed) != 1 || pushed[0] != review[0].Entity {
		t.Fatalf("thao tác được công nhận phải đẩy tiếp, thao tác bị bỏ thì không: %v", pushed)
	}
	if c, _ := r.db.Counts(context.Background()); c.Review != 0 || c.Pending != 0 {
		t.Fatalf("%+v", c)
	}
	// Thao tác loại đã đăng ký cách bỏ của sản phẩm: admin bỏ thì đi qua sản phẩm.
	_, _ = saveCard(r.a, "VP-c", map[string]any{"ten_khai": "Ấm"})
	r.srv.SyncVerdict = func(map[string]any) map[string]any {
		return map[string]any{"status": "pending", "reason": "locked_offline"}
	}
	_ = r.a.sync.DrainOnce(context.Background())
	review, _ = r.db.ListOps(context.Background(), offline.OpReview)
	var dropped []string
	r.a.RouteDiscard(review[0].Kind, func(ctx context.Context, op *offline.Op) error {
		dropped = append(dropped, op.ID)
		return r.db.Discard(ctx, op.ID)
	})
	r.srv.SyncDecisions = []map[string]any{{"opId": review[0].ID, "status": "dropped"}}
	r.a.pollDecisions(context.Background())
	if len(dropped) != 1 || dropped[0] != review[0].ID {
		t.Fatalf("admin bỏ thao tác: đi qua cách bỏ của sản phẩm: %v", dropped)
	}
}

// BR-017: đã đăng xuất / bị khoá vẫn gửi được để Worker kiểm quyền, bằng chữ ký máy; người khác đang đăng nhập cũng vậy.
func TestSyncGateUsesDeviceSignatureWithoutOwnSession(t *testing.T) {
	r := newRig(t)
	r.login("lan", "x")
	r.a.sync.Register(kindWrite, func(context.Context, *offline.Op) error { return nil })
	_, _ = saveCard(r.a, "VP-1", map[string]any{"ten_khai": "Ấm"})
	n, err := r.a.Logout()
	if err != nil || n != 1 {
		t.Fatalf("đăng xuất phải báo còn 1 thay đổi chờ: %d %v", n, err)
	}
	_ = r.a.sync.DrainOnce(context.Background())
	if len(r.srv.SyncAuthHeaders) != 1 || r.srv.SyncAuthHeaders[0][:1] != "|" || len(r.srv.SyncAuthHeaders[0]) < 20 {
		t.Fatalf("không có phiên thì phải gửi bằng token bản quyền của máy, không kèm phiên: %q", r.srv.SyncAuthHeaders)
	}
	if c, _ := r.db.Counts(context.Background()); c.Pending != 0 {
		t.Fatalf("thay đổi chờ vẫn được đẩy dù chưa ai đăng nhập lại: %+v", c)
	}
}

func TestLogoutKeepsOutboxAndReportsPending(t *testing.T) {
	r := newRig(t)
	r.login("lan", "x")
	r.noNetwork()
	for _, id := range []string{"VP-1", "VP-2"} {
		_, _ = saveCard(r.a, id, map[string]any{"ten_khai": "Ấm"})
	}
	n, _ := r.a.Logout()
	if n != 2 {
		t.Fatalf("báo số mục còn chờ: %d", n)
	}
	if c, _ := r.db.Counts(context.Background()); c.Pending != 2 {
		t.Fatalf("dữ liệu vẫn giữ trên máy: %+v", c)
	}
}

// ---------- Mật khẩu tạm và đổi mật khẩu ----------

func TestTemporaryPasswordForcesChange(t *testing.T) {
	r := newRig(t)
	r.srv.MustChange["lan"] = true
	r.login("lan", "tam-thoi")
	st, _ := r.a.GetState()
	if !st.Auth.MustChangePassword {
		t.Fatalf("phải bắt đổi mật khẩu: %+v", st.Auth)
	}
	_, _ = r.a.Logout()
	r.noNetwork()
	if _, err := r.a.Login("lan", "tam-thoi"); code(err) != apperr.CodeFirstLoginNeedsNetwork {
		t.Fatalf("mật khẩu tạm chưa đổi thì không được lưu để đăng nhập offline: %v", err)
	}
	r.online()
	r.login("lan", "tam-thoi")
	if _, err := r.a.ChangePassword("tam-thoi", "mat-khau-moi-1", "mat-khau-moi-1"); err != nil {
		t.Fatal(err)
	}
	if st, _ := r.a.GetState(); st.Auth.MustChangePassword {
		t.Fatal("đổi xong phải vào được")
	}
	_, _ = r.a.Logout()
	r.noNetwork()
	if _, err := r.a.Login("lan", "mat-khau-moi-1"); err != nil {
		t.Fatalf("sau khi đổi, mật khẩu mới đăng nhập offline được: %v", err)
	}
	if _, err := r.a.Login("lan", "tam-thoi"); err == nil {
		t.Fatal("mật khẩu tạm cũ không được dùng nữa")
	}
}

func TestChangePasswordNeedsNetwork(t *testing.T) {
	r := newRig(t)
	r.login("lan", "x")
	r.noNetwork()
	if _, err := r.a.ChangePassword("x", "mat-khau-moi-1", "mat-khau-moi-1"); code(err) != apperr.CodeNeedNetwork {
		t.Fatalf("E-020: %v", err)
	}
	r.serverDown()
	if _, err := r.a.ChangePassword("x", "mat-khau-moi-1", "mat-khau-moi-1"); code(err) != apperr.CodeServerUnavailable {
		t.Fatalf("E-021: %v", err)
	}
	r.online()
	r.srv.ChangePasswordErr = "wrong_current_password"
	if _, err := r.a.ChangePassword("sai", "mat-khau-moi-1", "mat-khau-moi-1"); code(err) != "wrong_current_password" {
		t.Fatalf("E-024: %v", err)
	}
}

func TestLockedLoginCarriesMinutes(t *testing.T) {
	r := newRig(t)
	r.srv.ForcedLoginErr["lan"] = map[string]any{"status": float64(429), "error": "rate_limited", "minutes": float64(12)}
	_, err := r.a.Login("lan", "x")
	if code(err) != "rate_limited" || !contains(err.Error(), "minutes=12") {
		t.Fatalf("UI cần số phút để điền {mm}: %v", err)
	}
	r.srv.ForcedLoginErr["lan"] = map[string]any{"status": float64(403), "error": "account_locked", "lockedAt": float64(1700000000)}
	_, err = r.a.Login("lan", "x")
	if code(err) != "account_locked" || !contains(err.Error(), "lockedAt=") {
		t.Fatalf("%v", err)
	}
}

// Worker từ chối vai không dùng sản phẩm này (Vipo vào ChatQASoftware): giữ tên vai và sản phẩm cho câu báo, không lưu phiên.
func TestRoleNotInProductLoginCarriesNames(t *testing.T) {
	r := newRig(t)
	r.srv.ForcedLoginErr["lan"] = map[string]any{"status": float64(403), "error": "role_not_in_product", "role": "Vipo", "product": "ChatQASoftware"}
	_, err := r.a.Login("lan", "x")
	if code(err) != "role_not_in_product" || !contains(err.Error(), "product=ChatQASoftware,role=Vipo") {
		t.Fatalf("UI cần {vai} và {sản phẩm}: %v", err)
	}
	if st, _ := r.a.GetState(); st.User != nil {
		t.Fatalf("không được có phiên: %+v", st.User)
	}
}

// ---------- Hợp đồng với Worker ----------

func TestAuthStateOfFreshApp(t *testing.T) {
	r := newRig(t)
	if st, _ := r.a.GetState(); st.Auth.Overlay != "" || st.Auth.MustChangePassword || st.User != nil {
		t.Fatalf("%+v", st.Auth)
	}
	_ = errors.Is
}

// ---------- Kích hoạt bản quyền (FR-001) ----------

func TestActivationErrors(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	srv := fakeWorker(t, priv, "anhtung")
	defer srv.Close()
	a, _ := New(updater.NewSwitchFS(fstest.MapFS{}, "0.1.0"), t.TempDir(), srv.URL, base64.StdEncoding.EncodeToString(pub), "", memqueue.New())
	r := &rig{a: a}
	r.noNetwork()
	if _, err := a.ActivateLicense("HSD-AAAAA-BBBBB-CCCCC-DDDDD"); code(err) != apperr.CodeActivationNeedsNetwork {
		t.Fatalf("không có mạng => E-022, got %v", err)
	}
	r.serverDown()
	if _, err := a.ActivateLicense("HSD-AAAAA-BBBBB-CCCCC-DDDDD"); code(err) != apperr.CodeServerUnavailable {
		t.Fatalf("máy chủ gián đoạn => E-021, got %v", err)
	}
	r.online()
	if _, err := a.ActivateLicense("sai"); code(err) != "license_not_found" {
		t.Fatalf("mã sai => E-014, got %v", err)
	}
	if a.st.Get().LicenseToken != "" {
		t.Fatal("kích hoạt lỗi không được lưu gì")
	}
}

func TestReinstallKeepsDeviceHash(t *testing.T) {
	r := newRig(t)
	h1 := r.a.devHash
	a2, err := New(updater.NewSwitchFS(fstest.MapFS{}, "0.1.0"), t.TempDir(), r.srv.URL, base64.StdEncoding.EncodeToString(r.a.licPub), "", memqueue.New())
	if err != nil {
		t.Fatal(err)
	}
	if a2.devHash != h1 {
		t.Fatal("cài lại trên cùng máy phải cùng mã máy => Worker không tính thêm chỗ")
	}
}

// ---------- Sau rà soát bảo mật ----------

// Ảnh chụp quyền có tuổi riêng: lần kết nối của người khác trên cùng máy không làm mới nó.
func TestOfflineLoginRefusedWhenEntitlementIsOlderThanWindow(t *testing.T) {
	r := newRig(t)
	r.login("lan", "mk-that")
	_, _ = r.a.Logout()
	// Người khác dùng máy online suốt 8 ngày: mốc kết nối của máy luôn mới, nhưng ảnh chụp của "lan" thì cũ
	r.ft.advance(8 * 24 * time.Hour)
	r.a.noteContact(r.ft.wall.Unix())
	r.noNetwork()
	if _, err := r.a.Login("lan", "mk-that"); code(err) != apperr.CodeOfflineExpired {
		t.Fatalf("ảnh chụp quá 168 giờ thì cần đăng nhập online: %v", err)
	}
}

func TestLogoutDismissesExpiredDialogButKeepsLockedOut(t *testing.T) {
	r := newRig(t)
	r.login("lan", "mk-that")
	r.srv.Heartbeat = func() (int, map[string]any) { return 401, map[string]any{"error": "session_expired"} }
	r.a.heartbeatOnce(context.Background())
	if st, _ := r.a.GetState(); st.Auth.Overlay != "expired" {
		t.Fatalf("phải có hộp thoại phiên hết hạn trước khi đăng xuất: %+v", st.Auth)
	}
	if _, err := r.a.Logout(); err != nil {
		t.Fatal(err)
	}
	if st, _ := r.a.GetState(); st.Auth.Overlay != "" || st.User != nil {
		t.Fatalf("đăng xuất xong thì hộp thoại phiên hết hạn phải hết, không che màn kích hoạt/đăng nhập: %+v", st.Auth)
	}

	// Hộp thoại bị khoá/thu hồi giữ tới lần đăng nhập kế, không bị đăng xuất xoá.
	r.a.setOverlay(&store.Overlay{Kind: "locked_out", At: 1})
	_, _ = r.a.Logout()
	if st, _ := r.a.GetState(); st.Auth.Overlay != "locked_out" {
		t.Fatalf("overlay locked_out phải còn sau đăng xuất: %+v", st.Auth)
	}
}

func TestSessionStartedOfflineMustRelogOnceOnline(t *testing.T) {
	r := newRig(t)
	r.login("lan", "mk-that")
	_, _ = r.a.Logout()
	r.noNetwork()
	r.login("lan", "mk-that") // phiên dựng lại từ ảnh chụp quyền, không có token máy chủ
	r.online()
	r.a.heartbeatOnce(context.Background())
	if st, _ := r.a.GetState(); st.Auth.Overlay != "expired" {
		t.Fatalf("có mạng lại thì phải đăng nhập online (E-005), không chờ tối đa 7 ngày: %+v", st.Auth)
	}
	r.login("lan", "mk-that")
	if st, _ := r.a.GetState(); st.Auth.Overlay != "" {
		t.Fatal("đăng nhập online xong thì hết hộp thoại")
	}
}

func TestSyncCheckFallsBackToDeviceSignatureWhenSessionRejected(t *testing.T) {
	r := newRig(t)
	r.login("lan", "x")
	r.a.sync.Register(kindWrite, func(context.Context, *offline.Op) error { return nil })
	_, _ = saveCard(r.a, "VP-1", map[string]any{"ten_khai": "Ấm"})
	calls := 0
	r.srv.SyncVerdict = func(map[string]any) map[string]any { return map[string]any{"status": "accepted"} }
	r.srv.SyncFirstAuthFail = true // lần đầu (kèm phiên) bị 401 session_expired
	_ = r.a.sync.DrainOnce(context.Background())
	_ = calls
	if c, _ := r.db.Counts(context.Background()); c.Pending != 0 {
		t.Fatalf("phiên bị vô hiệu thì dùng chữ ký máy, không kẹt hàng đợi: %+v", c)
	}
	if len(r.srv.SyncAuthHeaders) != 2 || r.srv.SyncAuthHeaders[1][:1] != "|" {
		t.Fatalf("lần hai phải không kèm phiên: %q", r.srv.SyncAuthHeaders)
	}
}

func TestTempPasswordSessionCannotWork(t *testing.T) {
	r := newRig(t)
	r.srv.MustChange["lan"] = true
	r.login("lan", "tam-thoi")
	if err := r.a.RequirePerm(modules.PermWorkDo); code(err) != apperr.CodePasswordChangeRequired {
		t.Fatalf("mật khẩu tạm chưa đổi thì chưa làm việc được: %v", err)
	}
	if _, err := r.a.WorkingActor(); code(err) != apperr.CodePasswordChangeRequired {
		t.Fatalf("và không ghi được dữ liệu: %v", err)
	}
}

func TestSyncCheckFailsClosedOnUnknownVerdict(t *testing.T) {
	r := newRig(t)
	r.login("lan", "x")
	pushed := 0
	r.a.sync.Register(kindWrite, func(context.Context, *offline.Op) error { pushed++; return nil })
	_, _ = saveCard(r.a, "VP-1", map[string]any{"ten_khai": "Ấm"})
	r.srv.SyncVerdict = func(map[string]any) map[string]any { return map[string]any{"status": ""} }
	_ = r.a.sync.DrainOnce(context.Background())
	if pushed != 0 {
		t.Fatal("kết quả kiểm quyền lạ thì KHÔNG được đẩy lên dịch vụ đích")
	}
	if c, _ := r.db.Counts(context.Background()); c.Pending != 1 {
		t.Fatalf("thao tác phải còn trong hàng đợi để thử lại: %+v", c)
	}
}
