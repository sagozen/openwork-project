// localgrant: nạp một bản quyền và một tài khoản admin ĐÃ KÝ (Ed25519 bằng khoá riêng của Worker) vào state.json của
// một máy, để vào app mà KHÔNG cần gọi server license. Không đổi logic kiểm tra của app: chỉ sinh đúng những gì luồng
// đăng nhập offline (core/offline_auth.go) vốn đã chấp nhận — một license token hợp lệ và một ảnh chụp quyền ký Ed25519.
//
// PHẢI CHẠY TRÊN CHÍNH MÁY ĐÍCH: ảnh chụp quyền offline được bảo vệ bằng DPAPI (theo máy + tài khoản Windows), và
// license token gắn theo device hash của máy. Cấp cho máy khác thì truyền -device-hash của máy đó, nhưng khối offline
// vẫn phải được niêm trên máy đích nên hãy chạy tại đó.
//
// Khoá ký riêng đọc từ biến môi trường LICENSE_SIGNING_KEY (base64 của PKCS8, CÙNG khoá Worker dùng để ký bản quyền —
// xem hsrelease keygen). Mật khẩu admin đọc từ LOCAL_ADMIN_PASSWORD. Công cụ KHÔNG in khoá, mật khẩu hay token.
//
// Dùng (PowerShell trên máy đích):
//
//	$env:LICENSE_SIGNING_KEY="<base64 PKCS8>"; $env:LOCAL_ADMIN_PASSWORD="<mật khẩu>"
//	go run deskcore/cmd/localgrant -user admin_chatqa -company CHATQA -lic CHATQA_LOCAL
//
// Chạy lại bất cứ lúc nào để làm mới cửa sổ offline (xem ghi chú ở cuối khi chạy xong).
package main

import (
	"crypto/ed25519"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"deskcore/config"
	"deskcore/core"
	"deskcore/license"
	"deskcore/modules"
	"deskcore/store"
)

// verifierIter khớp core/offline_auth.go (giá trị kiểm PBKDF2 của mật khẩu offline); lệch là app từ chối mật khẩu.
const verifierIter = 210_000

func main() {
	user := flag.String("user", "admin_chatqa", "tên đăng nhập admin")
	name := flag.String("name", "", "tên hiển thị (mặc định = -user)")
	lic := flag.String("lic", "CHATQA_LOCAL", "mã license")
	tenant := flag.String("tenant", "", "mã tenant (mặc định = -lic)")
	company := flag.String("company", "CHATQA", "tên công ty hiện ở màn đăng nhập")
	product := flag.String("product", "chatqa", "mã sản phẩm (contracts/products.json)")
	dirName := flag.String("dir-name", "ChatQASoftware", "tên thư mục dữ liệu của sản phẩm")
	appsCSV := flag.String("apps", "cqs.tower,cqs.test,cqs.monitor", "app được bật, phân tách bằng dấu phẩy")
	dataDir := flag.String("data", "", "ghi thẳng vào thư mục dữ liệu này (bỏ qua -dir-name)")
	deviceHash := flag.String("device-hash", "", "device hash máy đích (mặc định: tính trên máy đang chạy)")
	years := flag.Int("years", 10, "số năm hiệu lực của license")
	dryRun := flag.Bool("dry-run", false, "chỉ kiểm tra và in tóm tắt, không ghi state.json")
	flag.Parse()

	if err := run(opts{
		user: *user, name: *name, lic: *lic, tenant: *tenant, company: *company, product: *product,
		dirName: *dirName, dataDir: *dataDir, deviceHash: *deviceHash, apps: splitCSV(*appsCSV), years: *years, dryRun: *dryRun,
		signingKeyB64: os.Getenv("LICENSE_SIGNING_KEY"), password: os.Getenv("LOCAL_ADMIN_PASSWORD"),
	}); err != nil {
		fmt.Fprintln(os.Stderr, "lỗi:", err)
		os.Exit(1)
	}
}

type opts struct {
	user, name, lic, tenant, company, product, dirName, dataDir, deviceHash string
	apps                                                                    []string
	years                                                                   int
	dryRun                                                                  bool
	signingKeyB64, password                                                 string
}

func run(o opts) error {
	if strings.TrimSpace(o.signingKeyB64) == "" {
		return errors.New("thiếu LICENSE_SIGNING_KEY (base64 PKCS8 của khoá ký bản quyền)")
	}
	if o.password == "" {
		return errors.New("thiếu LOCAL_ADMIN_PASSWORD")
	}
	priv, err := loadSigningKey(o.signingKeyB64)
	if err != nil {
		return err
	}
	o.user = strings.ToLower(strings.TrimSpace(o.user))
	if o.user == "" {
		return errors.New("-user rỗng")
	}
	if o.name == "" {
		o.name = o.user
	}
	if o.tenant == "" {
		o.tenant = o.lic
	}

	dir := o.dataDir
	if dir == "" {
		if o.dirName == "" {
			return errors.New("thiếu -dir-name hoặc -data")
		}
		config.Use(config.Product{Code: o.product, Name: o.product, DirName: o.dirName})
		dir = config.DataDir()
	}

	dh := strings.TrimSpace(o.deviceHash)
	if dh == "" {
		if dh, err = license.DeviceHash(); err != nil {
			return fmt.Errorf("không tính được device hash (truyền -device-hash của máy đích): %w", err)
		}
	}

	now := time.Now().Unix()
	exp := now + int64(o.years)*365*24*3600
	devID := randID()

	licPayload := license.Payload{
		V: 1, Lic: o.lic, Tenant: o.tenant, Company: o.company, Dev: devID, DH: dh,
		Apps: o.apps, MaxDevices: 1, Exp: exp, RefreshBy: exp, Iat: now, Prd: o.product,
	}
	licToken, err := signToken(licPayload, priv)
	if err != nil {
		return err
	}

	ent := core.Entitlement{
		V: 1, Typ: "ent", UID: "local:" + o.user, TID: o.tenant, Role: modules.RoleAdmin,
		Name: o.name, Perms: []string{}, Apps: nil, SV: 1, Iat: now,
	}
	entToken, err := signToken(ent, priv)
	if err != nil {
		return err
	}

	verifier, err := makeVerifier(o.password)
	if err != nil {
		return err
	}
	cred := store.OfflineCred{Username: o.user, Verifier: verifier, Entitlement: entToken, SavedAt: now}
	sealed, err := sealCred(cred)
	if err != nil {
		return err
	}

	// Tự kiểm trước khi ghi: license token phải xác minh bằng khoá công khai tương ứng và hợp lệ trên máy này.
	pub := priv.Public().(ed25519.PublicKey)
	p, err := license.Verify(licToken, pub)
	if err != nil {
		return fmt.Errorf("license token tự sinh không xác minh được: %w", err)
	}
	if st := license.Evaluate(p, dh, time.Unix(now, 0)); st != license.StatusValid {
		return fmt.Errorf("license vừa ký không ở trạng thái valid (%s)", st)
	}

	if o.dryRun {
		printSummary(dir, dh, o, exp, false)
		return nil
	}

	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	st, err := store.Open(dir)
	if err != nil {
		return err
	}
	if err := st.Update(func(s *store.State) {
		s.LicenseToken = licToken
		s.DeviceID = "" // rỗng = app không gọi server để gia hạn/heartbeat; chỉ dùng bản quyền + đăng nhập offline
		if s.Offline == nil {
			s.Offline = map[string]string{}
		}
		s.Offline[o.user] = sealed
		if s.Overlay != nil && (s.Overlay.Kind == "revoked" || s.Overlay.Kind == "offline_locked") {
			s.Overlay = nil // mở lại màn bị khoá do lần cấp trước
		}
	}); err != nil {
		return err
	}
	printSummary(dir, dh, o, exp, true)
	return nil
}

// signToken: body = base64url(json(payload)), token = body + "." + base64url(Ed25519(body)). Khớp license.Verify và
// core.verifyEntitlement.
func signToken(payload any, priv ed25519.PrivateKey) (string, error) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	body := base64.RawURLEncoding.EncodeToString(raw)
	sig := ed25519.Sign(priv, []byte(body))
	return body + "." + base64.RawURLEncoding.EncodeToString(sig), nil
}

// makeVerifier sinh giá trị kiểm PBKDF2 của mật khẩu (không lưu mật khẩu), khớp core.newVerifier.
func makeVerifier(password string) (string, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	h, err := pbkdf2.Key(sha256.New, password, salt, verifierIter, 32)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("pbkdf2$%d$%s$%s", verifierIter,
		base64.RawURLEncoding.EncodeToString(salt), base64.RawURLEncoding.EncodeToString(h)), nil
}

// sealCred niêm ảnh chụp quyền offline giống core.saveOfflineCred: base64.Std(DPAPI(json(cred))).
func sealCred(cred store.OfflineCred) (string, error) {
	plain, err := json.Marshal(cred)
	if err != nil {
		return "", err
	}
	sealed, err := core.Protect(plain)
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(sealed), nil
}

func loadSigningKey(b64 string) (ed25519.PrivateKey, error) {
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(b64))
	if err != nil {
		return nil, errors.New("LICENSE_SIGNING_KEY không phải base64 hợp lệ")
	}
	k, err := x509.ParsePKCS8PrivateKey(raw)
	if err != nil {
		return nil, fmt.Errorf("LICENSE_SIGNING_KEY không phải PKCS8: %w", err)
	}
	priv, ok := k.(ed25519.PrivateKey)
	if !ok {
		return nil, errors.New("LICENSE_SIGNING_KEY không phải khoá Ed25519")
	}
	return priv, nil
}

func randID() string {
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

func splitCSV(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if t := strings.TrimSpace(p); t != "" {
			out = append(out, t)
		}
	}
	return out
}

func printSummary(dir, dh string, o opts, exp int64, wrote bool) {
	head := "Đã kiểm (dry-run), CHƯA ghi"
	if wrote {
		head = "Đã ghi"
	}
	fmt.Printf("%s state.json tại: %s\n", head, dir)
	fmt.Printf("  license   : %s (tenant %s, công ty %s)\n", o.lic, o.tenant, o.company)
	fmt.Printf("  app bật   : %s\n", strings.Join(o.apps, ", "))
	fmt.Printf("  admin     : %s (vai admin)\n", o.user)
	fmt.Printf("  máy đích  : device hash %s… \n", safePrefix(dh))
	fmt.Printf("  hiệu lực  : tới %s\n", time.Unix(exp, 0).Format("2006-01-02"))
	if wrote {
		fmt.Println("Mở app rồi đăng nhập bằng tài khoản admin ở trên (mật khẩu từ LOCAL_ADMIN_PASSWORD) — không cần mạng.")
		fmt.Printf("Cửa sổ đăng nhập offline là %d giờ kể từ lúc cấp; đăng nhập lại sau mốc đó cần chạy lại localgrant.\n",
			config.AccountLimits.OfflineHours)
	}
}

func safePrefix(s string) string {
	if len(s) > 12 {
		return s[:12]
	}
	return s
}
