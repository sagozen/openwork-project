package updater

import (
	"archive/zip"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"testing/fstest"
)

func makeZip(t *testing.T, path string, files map[string]string) {
	t.Helper()
	f, _ := os.Create(path)
	w := zip.NewWriter(f)
	for name, body := range files {
		fw, _ := w.Create(name)
		_, _ = fw.Write([]byte(body))
	}
	_ = w.Close()
	_ = f.Close()
}

func TestDownloadVerifies(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	payload := []byte("exe-bytes")
	sum := sha256.Sum256(payload)
	sha := hex.EncodeToString(sum[:])
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(payload) }))
	defer srv.Close()
	dir := t.TempDir()

	if err := Download(context.Background(), srv.Client(), srv.URL, filepath.Join(dir, "ok"), sha, SignDigest(priv, sha), pub); err != nil {
		t.Fatal(err)
	}
	// Chữ ký sai
	_, otherPriv, _ := ed25519.GenerateKey(rand.Reader)
	if err := Download(context.Background(), srv.Client(), srv.URL, filepath.Join(dir, "bad"), sha, SignDigest(otherPriv, sha), pub); err == nil {
		t.Fatal("phải từ chối chữ ký sai")
	}
	// Checksum sai (manifest ký đúng nhưng file khác)
	fake := hex.EncodeToString(make([]byte, 32))
	if err := Download(context.Background(), srv.Client(), srv.URL, filepath.Join(dir, "bad2"), fake, SignDigest(priv, fake), pub); err == nil {
		t.Fatal("phải từ chối checksum sai")
	}
	if _, err := os.Stat(filepath.Join(dir, "bad2")); !os.IsNotExist(err) {
		t.Fatal("file hỏng phải bị xoá")
	}
}

func TestInstallUIAndSwitch(t *testing.T) {
	root := t.TempDir()
	zp := filepath.Join(root, "ui.zip")
	makeZip(t, zp, map[string]string{"index.html": "OTA", "assets/app.js": "x"})

	embedded := fstest.MapFS{"index.html": {Data: []byte("EMBED")}}
	s := NewSwitchFS(embedded, "1.0.0")
	if _, err := InstallUI(root, zp, "1.0.1", 1); err != nil {
		t.Fatal(err)
	}

	if s.LoadOTA(root, 2, "1.0.0") {
		t.Fatal("coreApi khác thì không được nạp")
	}
	if s.LoadOTA(root, 1, "1.0.1") {
		t.Fatal("UI OTA không mới hơn UI nhúng thì bỏ qua")
	}
	if !s.LoadOTA(root, 1, "1.0.0") {
		t.Fatal("phải nạp UI OTA")
	}
	b, _ := fs.ReadFile(s, "index.html")
	if string(b) != "OTA" {
		t.Fatalf("đang phục vụ %q", b)
	}
	if v, ota := s.Current(); v != "1.0.1" || !ota {
		t.Fatal("Current sai")
	}
}

func TestZipSlipRejected(t *testing.T) {
	root := t.TempDir()
	zp := filepath.Join(root, "evil.zip")
	makeZip(t, zp, map[string]string{"index.html": "x", "../../evil.txt": "pwn"})
	if _, err := InstallUI(root, zp, "9.9.9", 1); err == nil {
		t.Fatal("phải chặn zip-slip")
	}
}

func TestCompareSemver(t *testing.T) {
	if CompareSemver("1.10.0", "1.9.0") <= 0 || CompareSemver("v1.0.0", "1.0.0") != 0 || CompareSemver("1.0", "1.0.1") >= 0 {
		t.Fatal("semver sai")
	}
}
