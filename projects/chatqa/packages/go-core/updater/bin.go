package updater

import (
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
)

// Cập nhật exe theo kiểu "tải nền - khởi động lại để áp dụng":
//
//	1. Có bản mới => tải nền vào <exe>.new + <exe>.new.json (đã kiểm chữ ký). Người dùng vẫn làm việc.
//	2. UI báo "Đã sẵn sàng - Khởi động lại". Bấm => đồng bộ nốt, đổi exe, mở exe mới, thoát.
//	   Bấm "Để sau" => lần mở app kế tiếp tự áp dụng trước khi hiện cửa sổ.
//	3. Bắt buộc (mandatory) => UI đếm ngược rồi tự khởi động lại.
//	4. Exe mới không lên được 2 lần liên tiếp => tự quay về exe cũ (BootGuard).
//
// Windows cho đổi tên exe đang chạy (không cho ghi đè), nên: exe -> exe.old, exe.new -> exe.
// Yêu cầu app cài theo user (%LOCALAPPDATA%\Programs\<thư mục sản phẩm>) để có quyền ghi.

// Staged: thông tin bản exe đã tải sẵn.
type Staged struct {
	Version   string `json:"version"`
	SHA256    string `json:"sha256"`
	Sig       string `json:"sig"`
	Notes     string `json:"notes"`
	Mandatory bool   `json:"mandatory"`
}

// Binary thao tác trên 1 file exe cụ thể (thường là os.Executable()).
type Binary struct{ Exe string }

func Current() (*Binary, error) {
	exe, err := os.Executable()
	if err != nil {
		return nil, err
	}
	if p, err := filepath.EvalSymlinks(exe); err == nil {
		exe = p
	}
	return &Binary{Exe: exe}, nil
}

func (b *Binary) NewPath() string  { return b.Exe + ".new" }
func (b *Binary) metaPath() string { return b.Exe + ".new.json" }
func (b *Binary) OldPath() string  { return b.Exe + ".old" }

// SaveStaged ghi thông tin sau khi đã tải xong và kiểm chữ ký file .new.
func (b *Binary) SaveStaged(s Staged) error {
	data, _ := json.Marshal(s)
	tmp := b.metaPath() + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, b.metaPath())
}

// LoadStaged: bản đã tải sẵn (nil nếu không có).
func (b *Binary) LoadStaged() *Staged {
	data, err := os.ReadFile(b.metaPath())
	if err != nil {
		return nil
	}
	var s Staged
	if json.Unmarshal(data, &s) != nil || s.Version == "" {
		return nil
	}
	if _, err := os.Stat(b.NewPath()); err != nil {
		return nil
	}
	return &s
}

func (b *Binary) DiscardStaged() {
	_ = os.Remove(b.NewPath())
	_ = os.Remove(b.metaPath())
}

// VerifyStaged kiểm lại sha256 + chữ ký ngay trước khi áp dụng (file có thể bị sửa trên đĩa).
func (b *Binary) VerifyStaged(s *Staged, pub ed25519.PublicKey) error {
	sha, _, err := FileSHA256(b.NewPath())
	if err != nil {
		return err
	}
	if sha != s.SHA256 {
		return fmt.Errorf("bad_checksum: bản tải sẵn bị thay đổi")
	}
	return VerifyDigest(pub, sha, s.Sig)
}

// Swap: exe -> exe.old, exe.new -> exe. Lỗi giữa chừng thì hoàn tác.
func (b *Binary) Swap() error {
	_ = os.Remove(b.OldPath())
	if err := os.Rename(b.Exe, b.OldPath()); err != nil {
		return fmt.Errorf("apply_failed: %w", err)
	}
	if err := os.Rename(b.NewPath(), b.Exe); err != nil {
		_ = os.Rename(b.OldPath(), b.Exe)
		return fmt.Errorf("apply_failed: %w", err)
	}
	_ = os.Remove(b.metaPath())
	return nil
}

// Rollback: quay về exe.old (exe lỗi đổi tên thành .bad).
func (b *Binary) Rollback() error {
	if _, err := os.Stat(b.OldPath()); err != nil {
		return errors.New("no_old: không còn bản cũ")
	}
	bad := b.Exe + ".bad"
	_ = os.Remove(bad)
	if err := os.Rename(b.Exe, bad); err != nil {
		return err
	}
	if err := os.Rename(b.OldPath(), b.Exe); err != nil {
		_ = os.Rename(bad, b.Exe)
		return err
	}
	return nil
}

// Cleanup xoá file thừa sau khi bản hiện tại đã chạy ổn (.old, .bad, file tải dở).
func (b *Binary) Cleanup() {
	for _, p := range []string{b.OldPath(), b.Exe + ".bad", b.NewPath() + ".part"} {
		_ = os.Remove(p)
	}
}

// WaitPIDFlag: tiến trình mới chờ tiến trình cũ thoát hẳn (tránh vướng khoá "chỉ 1 cửa sổ").
const WaitPIDFlag = "--desk-wait-pid"

// Relaunch mở exe (bản mới), truyền PID hiện tại để nó chờ. Bên gọi tự thoát app ngay sau đó.
func (b *Binary) Relaunch() error {
	return exec.Command(b.Exe, WaitPIDFlag, strconv.Itoa(os.Getpid())).Start()
}

// WaitPIDFromArgs: gọi đầu main(); nếu có cờ thì chờ tiến trình cũ thoát (tối đa 20 giây).
func WaitPIDFromArgs(args []string) {
	for i, a := range args {
		if a == WaitPIDFlag && i+1 < len(args) {
			if pid, err := strconv.Atoi(args[i+1]); err == nil && pid > 0 {
				waitPID(pid)
			}
		}
	}
}
