package core

import (
	"crypto/ed25519"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"deskcore/apperr"
	"deskcore/config"
	"deskcore/store"
)

// Đăng nhập offline (BR-009): người đã đăng nhập thành công trên máy này đăng nhập lại được khi mất mạng, trong hạn offline,
// theo mật khẩu và trạng thái tài khoản ở lần kết nối cuối. Máy chỉ giữ giá trị kiểm PBKDF2 (không giữ mật khẩu) và ảnh chụp
// quyền do Worker ký Ed25519; cả hai được bảo vệ bằng DPAPI.

const verifierIter = 210_000

// Entitlement: ảnh chụp quyền Worker ký (worker/src/lib/entitlement.ts EntitlementPayload).
type Entitlement struct {
	V     int      `json:"v"`
	Typ   string   `json:"typ"`
	UID   string   `json:"uid"`
	TID   string   `json:"tid"`
	Role  string   `json:"role"`
	Name  string   `json:"name"`
	Perms []string `json:"perms"`
	Apps  []string `json:"apps"` // nil = mọi app bản quyền bật
	SV    int      `json:"sv"`
	Iat   int64    `json:"iat"`
}

func newVerifier(password string) (string, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	h, err := pbkdf2.Key(sha256.New, password, salt, verifierIter, 32)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("pbkdf2$%d$%s$%s", verifierIter, base64.RawURLEncoding.EncodeToString(salt), base64.RawURLEncoding.EncodeToString(h)), nil
}

func checkVerifier(password, verifier string) bool {
	parts := strings.Split(verifier, "$")
	if len(parts) != 4 || parts[0] != "pbkdf2" {
		return false
	}
	iter, err := strconv.Atoi(parts[1])
	if err != nil || iter < 1 {
		return false
	}
	salt, err1 := base64.RawURLEncoding.DecodeString(parts[2])
	want, err2 := base64.RawURLEncoding.DecodeString(parts[3])
	if err1 != nil || err2 != nil {
		return false
	}
	got, err := pbkdf2.Key(sha256.New, password, salt, iter, len(want))
	return err == nil && subtle.ConstantTimeCompare(got, want) == 1
}

// verifyEntitlement kiểm chữ ký Ed25519 (cùng khoá công khai với bản quyền) và loại token.
func verifyEntitlement(token string, pub ed25519.PublicKey) (*Entitlement, error) {
	if pub == nil {
		return nil, errors.New("no_public_key")
	}
	body, sigS, ok := strings.Cut(token, ".")
	if !ok {
		return nil, errors.New("bad_entitlement")
	}
	sig, err := base64.RawURLEncoding.DecodeString(sigS)
	if err != nil || !ed25519.Verify(pub, []byte(body), sig) {
		return nil, errors.New("bad_entitlement")
	}
	raw, err := base64.RawURLEncoding.DecodeString(body)
	if err != nil {
		return nil, errors.New("bad_entitlement")
	}
	var e Entitlement
	if err := json.Unmarshal(raw, &e); err != nil || e.V != 1 || e.Typ != "ent" || e.UID == "" {
		return nil, errors.New("bad_entitlement")
	}
	return &e, nil
}

func offlineKey(username string) string { return strings.ToLower(strings.TrimSpace(username)) }

func (a *App) loadOfflineCred(username string) (*store.OfflineCred, error) {
	sealed := a.st.Get().Offline[offlineKey(username)]
	if sealed == "" {
		return nil, nil
	}
	raw, err := base64.StdEncoding.DecodeString(sealed)
	if err != nil {
		return nil, err
	}
	plain, err := unprotect(raw)
	if err != nil {
		return nil, err
	}
	var c store.OfflineCred
	if err := json.Unmarshal(plain, &c); err != nil {
		return nil, err
	}
	return &c, nil
}

func (a *App) saveOfflineCred(c *store.OfflineCred) error {
	plain, err := json.Marshal(c)
	if err != nil {
		return err
	}
	sealed, err := protect(plain)
	if err != nil {
		return err
	}
	enc := base64.StdEncoding.EncodeToString(sealed)
	return a.st.Update(func(s *store.State) {
		if s.Offline == nil {
			s.Offline = map[string]string{}
		}
		s.Offline[offlineKey(c.Username)] = enc
	})
}

// rememberLogin lưu thông tin đăng nhập offline sau một lần đăng nhập online thành công (mật khẩu mới biết lúc này).
func (a *App) rememberLogin(username, password, entitlement string) error {
	if entitlement == "" {
		return nil
	}
	v, err := newVerifier(password)
	if err != nil {
		return err
	}
	return a.saveOfflineCred(&store.OfflineCred{Username: offlineKey(username), Verifier: v, Entitlement: entitlement, SavedAt: a.clock.Now()})
}

// refreshEntitlement cập nhật quyền mới nhất cho người đang đăng nhập (gia hạn phiên không có mật khẩu), giữ nguyên giá trị kiểm.
func (a *App) refreshEntitlement(username, entitlement string) {
	if entitlement == "" {
		return
	}
	if c, err := a.loadOfflineCred(username); err == nil && c != nil {
		c.Entitlement, c.SavedAt = entitlement, a.clock.Now()
		_ = a.saveOfflineCred(c)
	}
}

// forgetLogin xoá thông tin đăng nhập offline của một người (khoá tài khoản, đổi mật khẩu ở nơi khác) hoặc của tất cả (username = "").
func (a *App) forgetLogin(username string) {
	_ = a.st.Update(func(s *store.State) {
		if username == "" {
			s.Offline = nil
			return
		}
		delete(s.Offline, offlineKey(username))
	})
}

// loginOffline đăng nhập khi không gọi được máy chủ.
func (a *App) loginOffline(username, password string) (*store.User, error) {
	cred, err := a.loadOfflineCred(username)
	if err != nil || cred == nil {
		// Lần đầu trên máy này (hoặc dữ liệu hỏng): bắt buộc có mạng.
		return nil, apperr.New(apperr.CodeFirstLoginNeedsNetwork, "")
	}
	limit := time.Duration(config.AccountLimits.OfflineHours) * time.Hour
	if a.clock.OfflineAge() > limit {
		return nil, apperr.New(apperr.CodeOfflineExpired, "")
	}
	if cred.Failures >= config.AccountLimits.OfflineLoginMaxFailures {
		return nil, apperr.New(apperr.CodeOfflineAttemptsExceeded, "")
	}
	ent, err := verifyEntitlement(cred.Entitlement, a.licPub)
	if err != nil {
		return nil, apperr.New(apperr.CodeFirstLoginNeedsNetwork, "ảnh chụp quyền không hợp lệ")
	}
	if p := a.payload(); p == nil || p.Tenant != ent.TID {
		return nil, apperr.New(apperr.CodeInvalidCredentials, "")
	}
	// Ảnh chụp quyền có tuổi riêng: lần kết nối của NGƯỜI KHÁC trên cùng máy không làm mới nó. Quá hạn offline kể từ lúc ký
	// thì tài khoản có thể đã bị khoá hoặc đổi mật khẩu mà máy này không biết => phải đăng nhập online.
	if a.clock.Now()-ent.Iat > int64(limit/time.Second) {
		return nil, apperr.New(apperr.CodeOfflineExpired, "")
	}
	if !checkVerifier(password, cred.Verifier) {
		cred.Failures++
		_ = a.saveOfflineCred(cred)
		if cred.Failures >= config.AccountLimits.OfflineLoginMaxFailures {
			return nil, apperr.New(apperr.CodeOfflineAttemptsExceeded, "")
		}
		return nil, apperr.New(apperr.CodeInvalidCredentials, "")
	}
	if cred.Failures != 0 {
		cred.Failures = 0
		_ = a.saveOfflineCred(cred)
	}
	u := store.User{ID: ent.UID, Tenant: ent.TID, Name: ent.Name, Role: ent.Role, Apps: ent.Apps, Perms: ent.Perms}
	exp := min(a.clock.Anchor(), ent.Iat) + int64(limit/time.Second)
	if err := a.st.Update(func(s *store.State) {
		s.Session = &store.Session{Token: "", Exp: exp, User: u, SessionVersion: ent.SV, Offline: true}
	}); err != nil {
		return nil, err
	}
	return &u, nil
}
