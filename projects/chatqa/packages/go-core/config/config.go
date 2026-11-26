// Package config: phiên bản, địa chỉ máy chủ, khoá công khai, thư mục dữ liệu.
package config

import (
	"os"
	"path/filepath"
	"runtime"
)

// Các biến dưới đây được ghi đè lúc build bằng -ldflags "-X deskcore/config.Version=1.2.3 ...".
var (
	// Version của exe (cũng là version UI nhúng sẵn).
	Version = "0.1.0"
	// APIBase: Cloudflare Worker.
	APIBase = "http://127.0.0.1:8787"
	// Channel OTA: stable | beta.
	Channel = "stable"
)

// Platform cho manifest OTA: windows-amd64 | darwin-universal.
// Trước đây cố định "windows-amd64" => bản macOS sẽ tải nhầm exe Windows.
var Platform = platformFor(runtime.GOOS, runtime.GOARCH)

func platformFor(goos, goarch string) string {
	if goos == "darwin" {
		return "darwin-universal" // 1 bản cho Intel + Apple Silicon (lipo)
	}
	return goos + "-" + goarch
}

// DataDir: nơi giữ CSDL, state.json, bản cập nhật tải sẵn (tên thư mục theo sản phẩm, Current.DirName).
//
//	Windows: %LOCALAPPDATA%\<DirName>
//	macOS:   ~/Library/Application Support/<DirName>
//	         (bản cũ dùng ~/Library/Caches - macOS có thể tự dọn => tự chuyển sang khi mở app)
//
// Chưa gọi Use => panic: thiếu tên thư mục thì sẽ ghi thẳng vào %LOCALAPPDATA% (lỗi lập trình, phải lộ ngay).
func DataDir() string {
	if Current.DirName == "" {
		panic("chưa gọi config.Use(product) trước DataDir")
	}
	dir, legacy := dataDirs(runtime.GOOS, Current.DirName, os.UserCacheDir, os.UserConfigDir)
	if legacy != "" {
		migrateLegacy(legacy, dir)
	}
	_ = os.MkdirAll(dir, 0o700)
	return dir
}

func dataDirs(goos, name string, cacheDir, configDir func() (string, error)) (dir, legacy string) {
	pick := func(f func() (string, error)) string {
		if b, err := f(); err == nil {
			return filepath.Join(b, name)
		}
		return filepath.Join(os.TempDir(), name)
	}
	if goos == "windows" {
		return pick(cacheDir), "" // UserCacheDir = %LOCALAPPDATA% trên Windows
	}
	dir = pick(configDir)
	if goos == "darwin" {
		legacy = pick(cacheDir)
	}
	return dir, legacy
}

// migrateLegacy: chuyển thư mục cũ sang chỗ mới nếu chỗ mới chưa có gì.
func migrateLegacy(from, to string) {
	if _, err := os.Stat(from); err != nil {
		return
	}
	if _, err := os.Stat(to); err == nil {
		return
	}
	_ = os.MkdirAll(filepath.Dir(to), 0o700)
	_ = os.Rename(from, to)
}
