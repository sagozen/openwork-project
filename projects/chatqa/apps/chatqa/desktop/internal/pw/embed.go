package pw

import (
	"bytes"
	"embed"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// Script Node của app (sidecar, bootstrap, bộ kiểm tra spec...), nhúng vào binary và ghi ra thư mục work
// của bộ chạy lúc dùng (Node tìm node_modules bằng cách đi ngược lên thư mục cha).
//
//go:embed js
var scripts embed.FS

// Install ghi các script nhúng (trừ file test) vào dir. File chỉ được ghi lại khi nội dung khác, qua file
// tạm rồi đổi tên, nên tiến trình đang đọc bản cũ không bao giờ thấy file dở.
func Install(dir string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	return fs.WalkDir(scripts, "js", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || strings.Contains(path.Base(p), ".test.") {
			return err
		}
		want, err := scripts.ReadFile(p)
		if err != nil {
			return err
		}
		dst := filepath.Join(dir, filepath.FromSlash(strings.TrimPrefix(p, "js/")))
		if have, err := os.ReadFile(dst); err == nil && bytes.Equal(have, want) {
			return nil
		}
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return err
		}
		tmp := dst + ".part"
		if err := os.WriteFile(tmp, want, 0o644); err != nil {
			return err
		}
		if err := os.Rename(tmp, dst); err != nil {
			_ = os.Remove(tmp)
			return err
		}
		return nil
	})
}

// StandaloneFixture: fixture ./chatqa rút gọn cho gói xuất chạy độc lập (test, expect, step bọc test.step), không có
// biến CQS_VAR_, ảnh live hay chặn host của app.
func StandaloneFixture() ([]byte, error) { return scripts.ReadFile("js/chatqa_standalone.ts") }
