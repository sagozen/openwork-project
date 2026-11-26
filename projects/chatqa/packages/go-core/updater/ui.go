package updater

import (
	"archive/zip"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// UIPointer: nội dung <data>/ui/current.json.
type UIPointer struct {
	Version string `json:"version"`
	CoreAPI int    `json:"coreApi"`
}

// InstallUI giải nén zip UI vào <root>/ui/<version> và trỏ current.json tới đó.
func InstallUI(root, zipPath, version string, coreAPI int) (string, error) {
	uiRoot := filepath.Join(root, "ui")
	dest := filepath.Join(uiRoot, version)
	_ = os.RemoveAll(dest)
	if err := extractZip(zipPath, dest); err != nil {
		_ = os.RemoveAll(dest)
		return "", err
	}
	if _, err := os.Stat(filepath.Join(dest, "index.html")); err != nil {
		_ = os.RemoveAll(dest)
		return "", errors.New("bad_bundle: thiếu index.html")
	}
	b, _ := json.Marshal(UIPointer{Version: version, CoreAPI: coreAPI})
	tmp := filepath.Join(uiRoot, "current.json.tmp")
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return "", err
	}
	if err := os.Rename(tmp, filepath.Join(uiRoot, "current.json")); err != nil {
		return "", err
	}
	pruneOldUI(uiRoot, version)
	return dest, nil
}

// pruneOldUI giữ lại bản hiện tại, xoá các bản cũ.
func pruneOldUI(uiRoot, keep string) {
	entries, _ := os.ReadDir(uiRoot)
	for _, e := range entries {
		if e.IsDir() && e.Name() != keep {
			_ = os.RemoveAll(filepath.Join(uiRoot, e.Name()))
		}
	}
}

func extractZip(zipPath, dest string) error {
	r, err := zip.OpenReader(zipPath)
	if err != nil {
		return err
	}
	defer r.Close()
	destAbs, _ := filepath.Abs(dest)
	for _, f := range r.File {
		target := filepath.Join(destAbs, filepath.FromSlash(f.Name))
		// Chống zip-slip: không cho file thoát khỏi thư mục đích
		if target != destAbs && !strings.HasPrefix(target, destAbs+string(os.PathSeparator)) {
			return fmt.Errorf("bad_bundle: đường dẫn không hợp lệ %q", f.Name)
		}
		if f.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		if err := writeZipFile(f, target); err != nil {
			return err
		}
	}
	return nil
}

func writeZipFile(f *zip.File, target string) error {
	rc, err := f.Open()
	if err != nil {
		return err
	}
	defer rc.Close()
	out, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	_, err = io.Copy(out, io.LimitReader(rc, 200<<20))
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	return err
}

// SwitchFS: fs.FS cho asset server của Wails. Phục vụ UI OTA nếu hợp lệ, ngược lại UI nhúng trong exe.
// Có thể đổi nguồn lúc chạy (sau khi cài UI mới) rồi reload cửa sổ.
type SwitchFS struct {
	mu       sync.RWMutex
	embedded fs.FS
	active   fs.FS
	version  string
	ota      bool
}

func NewSwitchFS(embedded fs.FS, embeddedVersion string) *SwitchFS {
	return &SwitchFS{embedded: embedded, active: embedded, version: embeddedVersion}
}

func (s *SwitchFS) Open(name string) (fs.File, error) {
	s.mu.RLock()
	a := s.active
	s.mu.RUnlock()
	return a.Open(name)
}

// Current trả version UI đang phục vụ và có phải bản OTA không.
func (s *SwitchFS) Current() (string, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.version, s.ota
}

// LoadOTA chọn UI OTA trong <root>/ui nếu: coreApi khớp, mới hơn UI nhúng, có index.html.
// Trả về false nếu tiếp tục dùng UI nhúng.
func (s *SwitchFS) LoadOTA(root string, coreAPI int, embeddedVersion string) bool {
	uiRoot := filepath.Join(root, "ui")
	b, err := os.ReadFile(filepath.Join(uiRoot, "current.json"))
	if err != nil {
		return false
	}
	var p UIPointer
	if json.Unmarshal(b, &p) != nil || p.CoreAPI != coreAPI || CompareSemver(p.Version, embeddedVersion) <= 0 {
		return false
	}
	dir := filepath.Join(uiRoot, p.Version)
	if _, err := os.Stat(filepath.Join(dir, "index.html")); err != nil {
		return false
	}
	s.mu.Lock()
	s.active, s.version, s.ota = os.DirFS(dir), p.Version, true
	s.mu.Unlock()
	return true
}
