package core

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"testing/fstest"
	"time"

	"deskcore/offline/memqueue"
	"deskcore/updater"
)

// Có exe mới => tải nền => "ready" => bấm khởi động lại => đổi exe + mở lại + thoát.
func TestBinaryUpdateDownloadThenRestart(t *testing.T) {
	relPub, relPriv, _ := ed25519.GenerateKey(rand.Reader)
	newExe := []byte("HSDesk v9.9.9")
	sum := sha256.Sum256(newExe)
	sha := hex.EncodeToString(sum[:])

	mux := http.NewServeMux()
	var srvURL string
	mux.HandleFunc("GET /api/v1/updates/stable", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"ui": nil, "bin": map[string]any{
			"version": "9.9.9", "coreApi": 1, "url": srvURL + "/dl/exe", "sha256": sha,
			"sig": updater.SignDigest(relPriv, sha), "size": len(newExe), "mandatory": true, "notes": "Sửa lỗi gộp lô",
		}})
	})
	mux.HandleFunc("GET /dl/exe", func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(newExe) })
	srv := httptest.NewServer(mux)
	defer srv.Close()
	srvURL = srv.URL

	dir := t.TempDir()
	a, err := New(updater.NewSwitchFS(fstest.MapFS{}, "0.1.0"), dir, srv.URL, "", base64.StdEncoding.EncodeToString(relPub), memqueue.New())
	if err != nil {
		t.Fatal(err)
	}
	exe := filepath.Join(dir, "HSDesk.exe")
	_ = os.WriteFile(exe, []byte("HSDesk v0.1.0"), 0o755)
	a.bin = &updater.Binary{Exe: exe}
	var events []UpdateInfo
	a.Emit = func(ev string, d any) {
		if ev == "update:status" {
			events = append(events, d.(UpdateInfo))
		}
	}
	relaunched, quit := 0, 0
	a.relaunch = func() error { relaunched++; return nil }
	a.Quit = func() { quit++ }

	if _, err := a.CheckUpdate(); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		if st := a.UpdateStatus(); st.Bin != nil && st.Bin.State == "ready" {
			if !st.Bin.Mandatory || st.Bin.Version != "9.9.9" {
				t.Fatalf("status: %+v", st.Bin)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("tải nền chưa xong: %+v", a.UpdateStatus().Bin)
		}
		time.Sleep(20 * time.Millisecond)
	}
	if len(events) == 0 {
		t.Fatal("phải phát sự kiện update:status cho UI")
	}
	// Trong lúc tải, exe đang chạy không bị đụng
	if b, _ := os.ReadFile(exe); string(b) != "HSDesk v0.1.0" {
		t.Fatal("chưa khởi động lại thì không được thay exe")
	}

	if err := a.ApplyUpdate("bin"); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(exe); string(b) != "HSDesk v9.9.9" {
		t.Fatalf("exe sau cập nhật: %q", b)
	}
	if relaunched != 1 || quit != 1 || !a.SkipCloseGuard {
		t.Fatalf("relaunch=%d quit=%d skip=%v", relaunched, quit, a.SkipCloseGuard)
	}
}
