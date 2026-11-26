package main

import (
	"crypto/ed25519"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"deskcore/core"
	"deskcore/license"
	"deskcore/modules"
	"deskcore/store"
)

// Kiểm công cụ sinh đúng những gì luồng đăng nhập offline của app (core/offline_auth.go) chấp nhận: một license token
// hợp lệ, một ảnh chụp quyền ký đúng, và một giá trị kiểm mật khẩu khớp.
func TestRunSeedsAcceptableState(t *testing.T) {
	pub, keyB64 := genKey(t)
	dir := t.TempDir()
	const password = "Abcd@1234"
	const user = "admin_chatqa"
	// device hash cố định để test không phụ thuộc máy chạy.
	deviceHash := strings.Repeat("ab", 32)

	err := run(opts{
		user: "  Admin_CHATQA ", lic: "CHATQA_LOCAL", company: "CHATQA", product: "chatqa",
		apps: []string{"cqs.tower", "cqs.test", "cqs.monitor"}, years: 10,
		dataDir: dir, deviceHash: deviceHash, signingKeyB64: keyB64, password: password,
	})
	if err != nil {
		t.Fatalf("run: %v", err)
	}

	st, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	s := st.Get()

	// 1. License token xác minh và ở trạng thái valid trên máy đích; không để DeviceID để app khỏi gọi server.
	if s.DeviceID != "" {
		t.Errorf("DeviceID phải rỗng, có %q", s.DeviceID)
	}
	p, err := license.Verify(s.LicenseToken, pub)
	if err != nil {
		t.Fatalf("license.Verify: %v", err)
	}
	if got := license.Evaluate(p, deviceHash, time.Now()); got != license.StatusValid {
		t.Errorf("trạng thái license = %s, muốn valid", got)
	}
	if p.Lic != "CHATQA_LOCAL" || p.Tenant != "CHATQA_LOCAL" || p.Prd != "chatqa" {
		t.Errorf("payload sai: %+v", p)
	}

	// 2. Ảnh chụp quyền offline giải niêm được, chữ ký đúng, là ent admin cùng tenant.
	sealed := s.Offline[user] // phải lưu theo tên chữ thường đã trim
	if sealed == "" {
		t.Fatalf("không có ảnh chụp quyền cho %q (keys=%v)", user, keysOf(s.Offline))
	}
	raw, err := base64.StdEncoding.DecodeString(sealed)
	if err != nil {
		t.Fatal(err)
	}
	plain, err := core.Unprotect(raw)
	if err != nil {
		t.Fatal(err)
	}
	var cred store.OfflineCred
	if err := json.Unmarshal(plain, &cred); err != nil {
		t.Fatal(err)
	}
	if cred.Username != user {
		t.Errorf("cred.Username = %q, muốn %q", cred.Username, user)
	}
	ent := verifyEnt(t, cred.Entitlement, pub)
	if ent.TID != p.Tenant {
		t.Errorf("tenant ảnh chụp quyền %q khác license %q", ent.TID, p.Tenant)
	}
	if modules.NormalizeRole(ent.Role) != modules.RoleAdmin {
		t.Errorf("vai = %q, muốn admin", ent.Role)
	}

	// 3. Giá trị kiểm khớp mật khẩu đúng, từ chối mật khẩu sai (như core.checkVerifier).
	if !checkVerifier(password, cred.Verifier) {
		t.Error("verifier không khớp mật khẩu đúng")
	}
	if checkVerifier("sai-mat-khau", cred.Verifier) {
		t.Error("verifier khớp nhầm mật khẩu sai")
	}
}

func TestRunRejectsBadInput(t *testing.T) {
	_, keyB64 := genKey(t)
	for _, tc := range []struct {
		name string
		o    opts
	}{
		{"thiếu khoá", opts{password: "x", dataDir: t.TempDir(), deviceHash: "ab"}},
		{"thiếu mật khẩu", opts{signingKeyB64: keyB64, dataDir: t.TempDir(), deviceHash: "ab"}},
		{"khoá rác", opts{signingKeyB64: "!!!", password: "x", dataDir: t.TempDir(), deviceHash: "ab"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := run(tc.o); err == nil {
				t.Error("muốn lỗi, được nil")
			}
		})
	}
}

func TestDryRunDoesNotWrite(t *testing.T) {
	_, keyB64 := genKey(t)
	dir := t.TempDir()
	err := run(opts{
		user: "admin_chatqa", lic: "CHATQA_LOCAL", apps: []string{"cqs.tower"}, years: 1,
		dataDir: dir, deviceHash: strings.Repeat("cd", 32), signingKeyB64: keyB64, password: "Abcd@1234", dryRun: true,
	})
	if err != nil {
		t.Fatalf("run dry: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "state.json")); !os.IsNotExist(err) {
		t.Errorf("dry-run không được ghi state.json (err=%v)", err)
	}
}

func genKey(t *testing.T) (ed25519.PublicKey, string) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	pkcs8, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	return pub, base64.StdEncoding.EncodeToString(pkcs8)
}

// verifyEnt lặp lại core.verifyEntitlement để xác nhận token ký đúng và đủ trường.
func verifyEnt(t *testing.T, token string, pub ed25519.PublicKey) core.Entitlement {
	t.Helper()
	body, sigS, ok := strings.Cut(token, ".")
	if !ok {
		t.Fatal("ảnh chụp quyền thiếu dấu chấm")
	}
	sig, err := base64.RawURLEncoding.DecodeString(sigS)
	if err != nil || !ed25519.Verify(pub, []byte(body), sig) {
		t.Fatal("chữ ký ảnh chụp quyền sai")
	}
	raw, err := base64.RawURLEncoding.DecodeString(body)
	if err != nil {
		t.Fatal(err)
	}
	var e core.Entitlement
	if err := json.Unmarshal(raw, &e); err != nil || e.V != 1 || e.Typ != "ent" || e.UID == "" {
		t.Fatalf("ảnh chụp quyền không hợp lệ: %+v (%v)", e, err)
	}
	return e
}

// checkVerifier lặp lại core.checkVerifier.
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

func keysOf(m map[string]string) []string {
	var ks []string
	for k := range m {
		ks = append(ks, k)
	}
	return ks
}
