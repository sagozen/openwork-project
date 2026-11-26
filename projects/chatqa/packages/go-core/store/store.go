// Package store lưu trạng thái cục bộ (license token, phiên đăng nhập) vào state.json.
package store

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"

	"deskcore/modules"
)

type User struct {
	ID     string `json:"id"`
	Tenant string `json:"tenant"`
	Name   string `json:"name"`
	Role   string `json:"role"`
	// Apps: app người này được dùng; nil = mọi app bản quyền bật. Lưu offline cùng phiên.
	Apps []string `json:"apps"`
	// Perms: quyền thao tác của vai (contracts/permissions.json), vd "approve.review". Admin có mọi quyền.
	Perms []string `json:"perms"`
}

// Has: có quyền thao tác `perm`. Phiên lưu từ bản trước có thể còn vai "owner" (= admin).
func (u User) Has(perm string) bool {
	if modules.NormalizeRole(u.Role) == modules.RoleAdmin {
		return true
	}
	for _, p := range u.Perms {
		if p == perm {
			return true
		}
	}
	return false
}

// CanUse: người dùng được phép dùng app `code` (chưa xét bản quyền máy).
func (u User) CanUse(code string) bool {
	if u.Apps == nil {
		return true
	}
	for _, a := range u.Apps {
		if a == code {
			return true
		}
	}
	return false
}

type Session struct {
	Token string `json:"token"`
	Exp   int64  `json:"exp"` // giờ máy chủ
	User  User   `json:"user"`
	// Username: tên đăng nhập đã gõ (khoá của thông tin đăng nhập offline).
	Username string `json:"username,omitempty"`
	// SessionVersion/PermsVersion/AppsVersion: phiên bản lần kết nối cuối, để heartbeat biết khi nào cần làm mới.
	SessionVersion int   `json:"sessionVersion,omitempty"`
	PermsVersion   int   `json:"permsVersion,omitempty"`
	AppsVersion    int64 `json:"appsVersion,omitempty"`
	// Offline: phiên dựng lại từ ảnh chụp quyền khi đăng nhập lúc mất mạng (không có token máy chủ).
	Offline bool `json:"offline,omitempty"`
	// MustChangePassword: đăng nhập bằng mật khẩu tạm, chỉ được đổi mật khẩu.
	MustChangePassword bool `json:"mustChangePassword,omitempty"`
}

// Clock: đồng hồ tin cậy cho chế độ offline (BR-009, SC-03). Chỉnh lùi giờ máy không làm thời gian offline ngắn đi.
type Clock struct {
	ServerNow   int64 `json:"serverNow"`   // giờ máy chủ lần kết nối cuối
	ConnectWall int64 `json:"connectWall"` // giờ máy lúc đó
	HighWall    int64 `json:"highWall"`    // giờ máy cao nhất từng thấy
	Skew        int64 `json:"skew"`        // phần giờ máy đã bị chỉnh lùi, cộng lại để giờ không lùi
	Elapsed     int64 `json:"elapsed"`     // giây đã trôi từ lần kết nối cuối theo đồng hồ đơn điệu
	TickWall    int64 `json:"tickWall"`    // giờ máy ở lần ghi gần nhất
}

// OfflineCred: thông tin để đăng nhập lại khi mất mạng cho một người đã từng đăng nhập thành công trên máy này.
// Mật khẩu KHÔNG được lưu, chỉ lưu giá trị kiểm PBKDF2 có muối riêng; cả khối được bảo vệ bằng DPAPI trên Windows.
type OfflineCred struct {
	Username    string `json:"username"`
	Verifier    string `json:"verifier"`    // pbkdf2$iter$salt$hash
	Entitlement string `json:"entitlement"` // ảnh chụp quyền ký Ed25519 của Worker
	Failures    int    `json:"failures"`    // số lần sai khi offline; đủ giới hạn thì chỉ đăng nhập online mới mở lại (E-026)
	SavedAt     int64  `json:"savedAt"`
}

// Overlay: trạng thái toàn cục UI phải hiện (hộp thoại / khoá màn), để mở lại app vẫn thấy đúng.
type Overlay struct {
	Kind string `json:"kind"`         // expired | revoked | locked_out | app_disabled
	At   int64  `json:"at,omitempty"` // giờ máy chủ của sự kiện (vd lúc bị khoá)
	App  string `json:"app,omitempty"`
}

type State struct {
	LicenseToken string `json:"licenseToken,omitempty"`
	DeviceID     string `json:"deviceId,omitempty"`
	// DevicesUsed: số máy đã dùng lúc nhận bản quyền gần nhất (hiện ở màn kích hoạt).
	DevicesUsed int      `json:"devicesUsed,omitempty"`
	Session     *Session `json:"session,omitempty"`
	Clock       *Clock   `json:"clock,omitempty"`
	// Offline: ảnh chụp đăng nhập offline, mã hoá/bảo vệ (xem core/protect_*.go). Khoá = tên đăng nhập chữ thường.
	Offline map[string]string `json:"offline,omitempty"`
	// SeenApps: các app từng được bản quyền bật trên máy, để phân biệt "chưa kích hoạt" với "bị tắt khỏi bản quyền".
	SeenApps []string `json:"seenApps,omitempty"`
	Overlay  *Overlay `json:"overlay,omitempty"`
}

func (s State) clone() State {
	if s.Session != nil {
		cp := *s.Session
		if cp.User.Apps != nil {
			cp.User.Apps = append([]string{}, cp.User.Apps...)
		}
		cp.User.Perms = append([]string(nil), cp.User.Perms...)
		s.Session = &cp
	}
	if s.Clock != nil {
		cp := *s.Clock
		s.Clock = &cp
	}
	if s.Overlay != nil {
		cp := *s.Overlay
		s.Overlay = &cp
	}
	if s.Offline != nil {
		m := make(map[string]string, len(s.Offline))
		for k, v := range s.Offline {
			m[k] = v
		}
		s.Offline = m
	}
	s.SeenApps = append([]string(nil), s.SeenApps...)
	return s
}

type Store struct {
	path string
	mu   sync.Mutex
	s    State
}

func Open(dir string) (*Store, error) {
	st := &Store{path: filepath.Join(dir, "state.json")}
	b, err := os.ReadFile(st.path)
	if err == nil {
		_ = json.Unmarshal(b, &st.s) // file hỏng => coi như chưa kích hoạt, không chặn mở app
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	return st, nil
}

// Get trả BẢN SAO (sửa kết quả không ảnh hưởng store).
func (st *Store) Get() State {
	st.mu.Lock()
	defer st.mu.Unlock()
	return st.s.clone()
}

// Update sửa trạng thái và ghi file nguyên tử (ghi tạm + fsync + rename).
// Ghi lỗi => trạng thái trong bộ nhớ giữ nguyên (không lệch với file).
func (st *Store) Update(fn func(*State)) error {
	st.mu.Lock()
	defer st.mu.Unlock()
	next := st.s.clone()
	fn(&next)
	b, err := json.MarshalIndent(next, "", "  ")
	if err != nil {
		return err
	}
	if err := writeFileSync(st.path, b); err != nil {
		return err
	}
	st.s = next
	return nil
}

func writeFileSync(path string, b []byte) error {
	tmp := path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.Write(b); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
