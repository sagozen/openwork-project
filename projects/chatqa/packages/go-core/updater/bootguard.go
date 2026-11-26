package updater

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// BootGuard: phát hiện exe mới không khởi động được để quay về bản cũ.
//
//   - Mỗi lần mở app: Begin() tăng attempts cho version hiện tại.
//   - UI tải xong (GetState lần đầu): MarkOK() đặt attempts = 0, xoá exe.old.
//   - Mở app mà attempts đã >= MaxBootAttempts và còn exe.old => Rollback, ghi Skip để không tải lại bản lỗi.
type BootGuard struct {
	path string
	st   bootState
}

type bootState struct {
	Version  string `json:"version"`
	Attempts int    `json:"attempts"`
	Skip     string `json:"skip,omitempty"` // version bị quay lui, không tự tải lại
}

const MaxBootAttempts = 2

func OpenBootGuard(dataDir string) *BootGuard {
	g := &BootGuard{path: filepath.Join(dataDir, "update_boot.json")}
	if b, err := os.ReadFile(g.path); err == nil {
		_ = json.Unmarshal(b, &g.st)
	}
	return g
}

func (g *BootGuard) save() {
	b, _ := json.Marshal(g.st)
	_ = os.WriteFile(g.path, b, 0o600)
}

// Begin ghi nhận 1 lần khởi động. Trả true nếu nên quay về bản cũ.
func (g *BootGuard) Begin(version string, hasOld bool) (rollback bool) {
	if g.st.Version != version {
		g.st.Version, g.st.Attempts = version, 0
	}
	if g.st.Attempts >= MaxBootAttempts && hasOld {
		g.st.Skip, g.st.Attempts = version, 0
		g.save()
		return true
	}
	g.st.Attempts++
	g.save()
	return false
}

// MarkOK: bản hiện tại chạy ổn.
func (g *BootGuard) MarkOK() {
	g.st.Attempts = 0
	g.save()
}

// Skipped: version đã bị quay lui (không tự tải lại).
func (g *BootGuard) Skipped(version string) bool { return version != "" && g.st.Skip == version }
