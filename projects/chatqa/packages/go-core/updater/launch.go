package updater

import (
	"crypto/ed25519"
	"os"
)

// OnLaunch: gọi đầu main(), TRƯỚC khi mở cửa sổ.
//   - Exe hiện tại khởi động lỗi liên tiếp => quay về exe.old.
//   - Có bản đã tải sẵn, mới hơn, chữ ký đúng => đổi exe.
//
// Trả true khi đã mở tiến trình mới (relaunch) => main phải thoát ngay.
func OnLaunch(b *Binary, g *BootGuard, version string, pub ed25519.PublicKey, relaunch func() error) bool {
	_, oldErr := os.Stat(b.OldPath())
	if g.Begin(version, oldErr == nil) {
		if b.Rollback() == nil && relaunch() == nil {
			return true
		}
	}
	s := b.LoadStaged()
	if s == nil {
		return false
	}
	if pub == nil || CompareSemver(s.Version, version) <= 0 || g.Skipped(s.Version) || b.VerifyStaged(s, pub) != nil {
		b.DiscardStaged()
		return false
	}
	if b.Swap() != nil {
		return false
	}
	// Exe trên đĩa đã là bản mới; mở lại không được thì bản cũ (đang trong RAM) chạy tiếp, lần sau sẽ là bản mới.
	return relaunch() == nil
}
