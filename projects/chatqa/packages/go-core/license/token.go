// Package license: định danh máy, kiểm tra license token (Ed25519) và đánh giá trạng thái.
package license

import (
	"crypto/ed25519"
	"deskcore/config"
	"encoding/base64"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"time"
)

// Payload khớp worker/src/routes/license.ts (LicensePayload).
type Payload struct {
	V          int      `json:"v"`
	Lic        string   `json:"lic"`
	Tenant     string   `json:"tenant"`
	Company    string   `json:"company"` // tên công ty để hiện ở màn đăng nhập
	Dev        string   `json:"dev"`
	DH         string   `json:"dh"`
	Apps       []string `json:"apps"`
	MaxDevices int      `json:"maxDevices"`
	Exp        int64    `json:"exp"`
	RefreshBy  int64    `json:"refreshBy"`
	Iat        int64    `json:"iat"`
	// Prd: sản phẩm của bản quyền (contracts/products.json). Token cũ không có = config.DefaultProduct.
	Prd string `json:"prd,omitempty"`
}

// Product: sản phẩm của bản quyền, token cũ không ghi thì là config.DefaultProduct.
func (p *Payload) Product() string {
	if p.Prd == "" {
		return config.DefaultProduct
	}
	return p.Prd
}

func (p *Payload) HasApp(code string) bool { return slices.Contains(p.Apps, code) }

type Status string

const (
	StatusNone           Status = "none"
	StatusValid          Status = "valid"
	StatusNeedsRefresh   Status = "needs_refresh" // vẫn dùng được, nên gọi refresh khi có mạng
	StatusOfflineExpired Status = "offline_expired"
	StatusExpired        Status = "expired"
	StatusInvalid        Status = "invalid"
)

// RefreshInterval: bao lâu thì gia hạn token một lần khi có mạng.
const RefreshInterval = 6 * time.Hour

var ErrBadToken = errors.New("license token không hợp lệ")

// DecodePublicKey đọc khoá công khai base64 (32 byte).
func DecodePublicKey(b64 string) (ed25519.PublicKey, error) {
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(b64))
	if err != nil || len(raw) != ed25519.PublicKeySize {
		return nil, errors.New("public key không hợp lệ")
	}
	return ed25519.PublicKey(raw), nil
}

// Verify kiểm tra chữ ký và giải mã payload. Không kiểm tra thời hạn (xem Evaluate).
func Verify(token string, pub ed25519.PublicKey) (*Payload, error) {
	body, sigS, ok := strings.Cut(token, ".")
	if !ok {
		return nil, ErrBadToken
	}
	sig, err := base64.RawURLEncoding.DecodeString(sigS)
	if err != nil || !ed25519.Verify(pub, []byte(body), sig) {
		return nil, ErrBadToken
	}
	raw, err := base64.RawURLEncoding.DecodeString(body)
	if err != nil {
		return nil, ErrBadToken
	}
	var p Payload
	if err := json.Unmarshal(raw, &p); err != nil || p.V != 1 {
		return nil, ErrBadToken
	}
	return &p, nil
}

// Evaluate xác định trạng thái license trên máy này tại thời điểm now.
func Evaluate(p *Payload, deviceHash string, now time.Time) Status {
	if p == nil {
		return StatusNone
	}
	if p.DH != deviceHash {
		return StatusInvalid // token chép từ máy khác
	}
	t := now.Unix()
	switch {
	case t >= p.Exp:
		return StatusExpired
	case t >= p.RefreshBy:
		return StatusOfflineExpired
	case t >= p.Iat+int64(RefreshInterval.Seconds()):
		return StatusNeedsRefresh
	default:
		return StatusValid
	}
}

// Usable: các trạng thái vẫn cho phép làm việc.
func (s Status) Usable() bool { return s == StatusValid || s == StatusNeedsRefresh }
