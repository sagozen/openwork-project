package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPlatform(t *testing.T) {
	if platformFor("windows", "amd64") != "windows-amd64" || platformFor("darwin", "arm64") != "darwin-universal" {
		t.Fatal("platform sai")
	}
}

func TestDataDirs(t *testing.T) {
	cache := func() (string, error) { return "/c", nil }
	conf := func() (string, error) { return "/s", nil }
	if d, l := dataDirs("windows", "HSDesk", cache, conf); d != filepath.Join("/c", "HSDesk") || l != "" {
		t.Fatal(d, l)
	}
	if d, l := dataDirs("darwin", "HSDesk", cache, conf); d != filepath.Join("/s", "HSDesk") || l != filepath.Join("/c", "HSDesk") {
		t.Fatal("macOS không được dùng Caches", d, l)
	}
}

func TestMigrateLegacy(t *testing.T) {
	root := t.TempDir()
	from, to := filepath.Join(root, "old", "HSDesk"), filepath.Join(root, "new", "HSDesk")
	_ = os.MkdirAll(filepath.Join(from, "data"), 0o700)
	_ = os.WriteFile(filepath.Join(from, "data", "hsdesk.db"), []byte("x"), 0o600)
	migrateLegacy(from, to)
	if b, err := os.ReadFile(filepath.Join(to, "data", "hsdesk.db")); err != nil || string(b) != "x" {
		t.Fatal("chưa chuyển dữ liệu", err)
	}
	// Chỗ mới đã có => không ghi đè
	_ = os.MkdirAll(from, 0o700)
	migrateLegacy(from, to)
	if _, err := os.Stat(from); err != nil {
		t.Fatal("không được động vào thư mục cũ khi chỗ mới đã có")
	}
}
