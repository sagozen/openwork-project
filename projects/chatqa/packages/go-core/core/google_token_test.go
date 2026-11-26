package core

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"testing"
	"testing/fstest"
	"time"

	"deskcore/offline/memqueue"
	"deskcore/updater"
)

// Admin nối lại Drive bằng tài khoản khác: máy đang chạy phải dùng token mới sau tối đa googleTokenMaxAge, không giữ
// token cũ tới gần hết hạn (~1 giờ) rồi đồng bộ lỗi "không thấy thư mục gốc" suốt khoảng đó.
func TestGoogleTokenRefetchedAfterMaxAge(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	srv := fakeWorker(t, priv, "anhtung")
	defer srv.Close()
	clock := time.Now().Unix()
	old := nowUnix
	nowUnix = func() int64 { return clock }
	defer func() { nowUnix = old }()

	ui := updater.NewSwitchFS(fstest.MapFS{"index.html": {Data: []byte("x")}}, "0.1.0")
	a, err := New(ui, t.TempDir(), srv.URL, base64.StdEncoding.EncodeToString(pub), "", memqueue.New())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := a.ActivateLicense("hsd-aaaaa-bbbbb-ccccc-ddddd"); err != nil {
		t.Fatal(err)
	}
	if _, err := a.Login("lan", "x"); err != nil {
		t.Fatal(err)
	}

	g, err := a.GoogleToken()
	if err != nil || g.AccessToken != "ya29.x" {
		t.Fatalf("token đầu: %v %+v", err, g)
	}
	srv.mu.Lock()
	srv.GoogleAccessToken = "ya29.moi" // admin vừa nối lại bằng tài khoản khác
	srv.mu.Unlock()

	clock += 60
	if g, _ = a.GoogleToken(); g.AccessToken != "ya29.x" || srv.GoogleTokenHits != 1 {
		t.Fatalf("trong %v phải dùng lại token đã cache: %q, %d lần xin", googleTokenMaxAge, g.AccessToken, srv.GoogleTokenHits)
	}
	clock += int64(googleTokenMaxAge / time.Second)
	if g, _ = a.GoogleToken(); g.AccessToken != "ya29.moi" || srv.GoogleTokenHits != 2 {
		t.Fatalf("quá %v phải xin token mới: %q, %d lần xin", googleTokenMaxAge, g.AccessToken, srv.GoogleTokenHits)
	}
}
