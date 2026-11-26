package core

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"deskcore/apperr"
	"deskcore/license"
	"deskcore/offline"
	"deskcore/offline/memqueue"
	"deskcore/store"
	"deskcore/updater"
)

func jsonInt(n int64) string { b, _ := json.Marshal(n); return string(b) }

func TestActivateLoginFlow(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	srv := fakeWorker(t, priv, "anhtung")
	defer srv.Close()

	ui := updater.NewSwitchFS(fstest.MapFS{"index.html": {Data: []byte("x")}}, "0.1.0")
	a, err := New(ui, t.TempDir(), srv.URL, base64.StdEncoding.EncodeToString(pub), "", memqueue.New())
	if err != nil {
		t.Fatal(err)
	}

	st, _ := a.GetState()
	if st.License.Status != license.StatusNone || st.User != nil {
		t.Fatalf("trạng thái đầu sai: %+v", st.License)
	}
	if _, err := a.Login("lan", "x"); err == nil {
		t.Fatal("chưa kích hoạt thì không được đăng nhập")
	}
	if _, err := a.ActivateLicense("sai"); err == nil {
		t.Fatal("key sai phải lỗi")
	}
	info, err := a.ActivateLicense("hsd-aaaaa-bbbbb-ccccc-ddddd")
	if err != nil || info.Status != license.StatusValid {
		t.Fatalf("kích hoạt lỗi: %v %+v", err, info)
	}
	if _, err := a.Login("lan", "x"); err != nil {
		t.Fatal(err)
	}
	st, _ = a.GetState()
	if st.User == nil || st.User.Name != "Lan" || len(st.License.Apps) != 2 {
		t.Fatalf("state sau đăng nhập sai: %+v", st)
	}
	g, err := a.GoogleToken()
	if err != nil || g.AccessToken != "ya29.x" {
		t.Fatalf("google token: %v", err)
	}
	if _, err := a.CallAPI("GET", "/../sys/tenants", ""); err == nil {
		t.Fatal("CallAPI phải chặn đường dẫn ngoài /v1/")
	}
	if _, err := a.Logout(); err != nil {
		t.Fatal(err)
	}
	if st, _ = a.GetState(); st.User != nil {
		t.Fatal("đăng xuất chưa xoá phiên")
	}
}

func TestTokenFromOtherKeyRejected(t *testing.T) {
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	otherPub, _, _ := ed25519.GenerateKey(rand.Reader)
	srv := fakeWorker(t, priv, "anhtung")
	defer srv.Close()
	ui := updater.NewSwitchFS(fstest.MapFS{}, "0.1.0")
	a, _ := New(ui, t.TempDir(), srv.URL, base64.StdEncoding.EncodeToString(otherPub), "", memqueue.New())
	if _, err := a.ActivateLicense("HSD-AAAAA-BBBBB-CCCCC-DDDDD"); err == nil {
		t.Fatal("token ký bằng khoá lạ phải bị từ chối")
	}
}

func TestOfflineSessionAndLocalSave(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	srv := fakeWorker(t, priv, "anhtung")
	db := memqueue.New()
	ui := updater.NewSwitchFS(fstest.MapFS{}, "0.1.0")
	a, err := New(ui, t.TempDir(), srv.URL, base64.StdEncoding.EncodeToString(pub), "", db)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := a.ActivateLicense("HSD-AAAAA-BBBBB-CCCCC-DDDDD"); err != nil {
		t.Fatal(err)
	}
	if _, err := a.Login("lan", "x"); err != nil {
		t.Fatal(err)
	}
	a.sync.Register(kindWrite, func(context.Context, *offline.Op) error { return nil })
	// Có sẵn đề xuất AI cho VP-1
	if _, err := saveCard(a, "VP-1", map[string]any{"ma_hs": "8516.79.10", "ten_khai": "Ấm đun"}); err != nil {
		t.Fatal(err)
	}

	// Mất mạng + phiên đã hết hạn
	srv.Close()
	_ = a.st.Update(func(st *store.State) { st.Session.Exp = time.Now().Unix() - 10 })
	st, _ := a.GetState()
	if !st.Offline || st.User == nil || st.User.Name != "Lan" {
		t.Fatalf("offline phải vẫn làm việc được: offline=%v user=%+v", st.Offline, st.User)
	}
	r, err := saveCard(a, "VP-1", map[string]any{"ma_hs": "8516.79.90", "ten_khai": "Ấm đun"})
	if err != nil || r.Op.Status != offline.OpPending || !strings.Contains(string(r.Op.Payload), "8516.79.90") {
		t.Fatalf("lưu offline: %+v %v", r, err)
	}
	if r.Actor.Name != "Lan" || r.Op.ActorUserID != r.Actor.UserID {
		t.Fatalf("người làm offline phải lấy từ ảnh chụp quyền: %+v", r.Actor)
	}
	// Thử đồng bộ khi offline: không mất gì
	if s := a.SyncNow(); s.Pending < 1 {
		t.Fatalf("hàng đợi phải còn: %+v", s)
	}

	// Có mạng lại mà phiên hết hạn => phải đăng nhập lại
	srv2 := fakeWorker(t, priv, "anhtung")
	defer srv2.Close()
	a.api.Base = srv2.URL
	if st, _ := a.GetState(); st.Offline || st.User != nil {
		t.Fatalf("online + phiên hết hạn => cần đăng nhập: offline=%v user=%+v", st.Offline, st.User)
	}
}

// Bản quyền chỉ bật quote + teach: lõi phải chặn phân hệ khác (không chỉ ẩn trên UI).
func TestRequireApp(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	srv := fakeWorker(t, priv, "anhtung")
	defer srv.Close()
	a, _ := New(updater.NewSwitchFS(fstest.MapFS{}, "0.1.0"), t.TempDir(), srv.URL, base64.StdEncoding.EncodeToString(pub), "", memqueue.New())
	if apperr.CodeOf(a.RequireApp(appQuote)) != apperr.CodeNotLicensed {
		t.Fatal("chưa kích hoạt => device_not_licensed")
	}
	if _, err := a.ActivateLicense("HSD-AAAAA-BBBBB-CCCCC-DDDDD"); err != nil {
		t.Fatal(err)
	}
	if err := a.RequireApp(appQuote); err != nil {
		t.Fatal(err)
	}
	if apperr.CodeOf(a.RequireApp("lot")) != apperr.CodeModuleLocked {
		t.Fatal("App 2 không có trong bản quyền => module_locked")
	}
	if _, err := a.WorkingActor(); apperr.CodeOf(err) != apperr.CodeUnauthorized {
		t.Fatal("chưa đăng nhập")
	}
}

// Bản quyền máy có App 1 nhưng owner chỉ cấp App 4 cho người này => App 1 bị chặn (app_forbidden).
func TestRequireAppPerUser(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	srv := fakeWorker(t, priv, "anhtung")
	defer srv.Close()
	a, _ := New(updater.NewSwitchFS(fstest.MapFS{}, "0.1.0"), t.TempDir(), srv.URL, base64.StdEncoding.EncodeToString(pub), "", memqueue.New())
	if _, err := a.ActivateLicense("HSD-AAAAA-BBBBB-CCCCC-DDDDD"); err != nil {
		t.Fatal(err)
	}
	u, err := a.Login("chi-teach", "x")
	if err != nil || len(u.Apps) != 1 {
		t.Fatalf("%+v %v", u, err)
	}
	if apperr.CodeOf(a.RequireApp(appQuote)) != apperr.CodeAppForbidden {
		t.Fatal("người dùng không được cấp App 1 => app_forbidden")
	}
	if err := a.RequireApp(appTeach); err != nil {
		t.Fatal(err)
	}
	if _, err := saveCard(a, "VP-1", nil); apperr.CodeOf(err) != apperr.CodeAppForbidden {
		t.Fatalf("Service cũng phải chặn: %v", err)
	}
}
