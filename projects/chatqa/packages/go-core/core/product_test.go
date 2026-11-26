package core

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"slices"
	"testing"
	"testing/fstest"

	"deskcore/config"
	"deskcore/license"
	"deskcore/offline/memqueue"
	"deskcore/updater"
)

func newProductApp(t *testing.T, prd string) (*App, *fakeSrv) {
	t.Helper()
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	srv := fakeWorker(t, priv, "anhtung")
	srv.LicensePrd = prd
	t.Cleanup(srv.Close)
	a, err := New(updater.NewSwitchFS(fstest.MapFS{}, "0.1.0"), t.TempDir(), srv.URL, base64.StdEncoding.EncodeToString(pub), "", memqueue.New())
	if err != nil {
		t.Fatal(err)
	}
	_, _ = a.ActivateLicense("HSD-AAAAA-BBBBB-CCCCC-DDDDD")
	return a, srv
}

// Bản quyền của sản phẩm khác không mở được exe này, kể cả khi chữ ký đúng.
func TestLicenseOfAnotherProductIsInvalid(t *testing.T) {
	a, _ := newProductApp(t, "chatqa")
	if st := a.licenseInfo().Status; st != license.StatusInvalid {
		t.Fatalf("token chatqa trên exe %s phải không hợp lệ, got %s", config.Current.Code, st)
	}
}

// Token cũ không ghi sản phẩm là của hsdesk: máy HS Desk đã kích hoạt không phải kích hoạt lại.
func TestLegacyLicenseWithoutProductIsHSDesk(t *testing.T) {
	a, _ := newProductApp(t, "")
	if st := a.licenseInfo().Status; st != license.StatusValid {
		t.Fatalf("token không có prd phải dùng được cho hsdesk, got %s", st)
	}
}

// Máy gửi mã sản phẩm của exe ở mọi lần nói chuyện về bản quyền và đăng nhập.
func TestClientSendsProduct(t *testing.T) {
	a, srv := newProductApp(t, "hsdesk")
	if _, err := a.Login("lan", "x"); err != nil {
		t.Fatal(err)
	}
	if len(srv.Products) < 2 || slices.ContainsFunc(srv.Products, func(p string) bool { return p != config.Current.Code }) {
		t.Fatalf("mọi lần gọi phải kèm product %q: %v", config.Current.Code, srv.Products)
	}
}
