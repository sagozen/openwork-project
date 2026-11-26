package testengine

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"

	"chatqa/internal/pw"
	"deskcore/apperr"
	"deskcore/core"
)

// Thông tin đăng nhập dùng trong flow được tham chiếu theo tên biến (${USERNAME}, ${PASSWORD}). Giá trị nằm
// trong kho bí mật của hệ điều hành và chỉ được đưa vào RunConfig.Env lúc chạy; không bao giờ nằm trong flow,
// log, báo cáo, lịch sử chat hay prompt LLM.

var secretNameRe = regexp.MustCompile(`^[A-Z_][A-Z0-9_]{0,63}$`)

// Secrets: kho bí mật theo tên biến.
type Secrets interface {
	Get(name string) (string, error)
	Set(name, value string) error
	Delete(name string) error
	Names() ([]string, error) // chỉ tên, không bao giờ trả giá trị
}

// ValidVarName: tên biến của người dùng (env của lượt chạy, env mặc định, tên bí mật): chữ hoa, số, gạch dưới, và không
// thuộc tên dành riêng (NODE_*, PLAYWRIGHT_*, PWDEBUG, PW_*, CQS_*, DYLD_*, LD_*, *_PROXY). Biến của flow web đi vào một
// tiến trình Node thật, nên các tên điều khiển Node, Playwright, app hay trình nạp thư viện bị từ chối ngay lúc ghi. Giá
// trị đã lưu từ trước dưới tên như vậy vẫn dùng được cho mobile (chạy trong app) và không bao giờ vào tiến trình con.
func ValidVarName(name string) error {
	if err := varNameFormat(name); err != nil {
		return err
	}
	if pw.ReservedVar(name) {
		return apperr.New(apperr.CodeInvalid, "tên biến "+name+" dành riêng (NODE_*, PLAYWRIGHT_*, PWDEBUG, PW_*, CQS_*, DYLD_*, LD_*, *_PROXY)")
	}
	return nil
}

// varNameFormat: chỉ kiểm dạng tên biến (chữ hoa, số, gạch dưới), không xét tên dành riêng.
func varNameFormat(name string) error {
	if !secretNameRe.MatchString(name) {
		return apperr.New(apperr.CodeInvalid, "tên biến "+name+": chỉ gồm chữ hoa, số và _ (vd PASSWORD)")
	}
	return nil
}

func checkSecret(name, value string) error {
	if err := ValidVarName(name); err != nil {
		return err
	}
	if value == "" || strings.ContainsAny(value, "\r\n\x00") {
		return apperr.New(apperr.CodeInvalid, "giá trị trống hoặc có ký tự xuống dòng")
	}
	return nil
}

// fileSecrets: một tệp JSON được niêm phong bằng core.Protect (DPAPI theo tài khoản Windows). Dùng trên Windows;
// trên Linux chỉ để phát triển (Protect không mã hoá ở đó).
type fileSecrets struct {
	path string
	mu   sync.Mutex
}

func (s *fileSecrets) load() (map[string]string, error) {
	m := map[string]string{}
	sealed, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return m, nil
	}
	if err != nil {
		return nil, err
	}
	plain, err := core.Unprotect(sealed)
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(plain, &m); err != nil {
		return nil, err
	}
	return m, nil
}

func (s *fileSecrets) save(m map[string]string) error {
	plain, err := json.Marshal(m)
	if err != nil {
		return err
	}
	sealed, err := core.Protect(plain)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return err
	}
	return writeAtomic(s.path, sealed, 0o600)
}

func (s *fileSecrets) Get(name string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	m, err := s.load()
	if err != nil {
		return "", err
	}
	v, ok := m[name]
	if !ok {
		return "", apperr.New(CodeSecretMissing, name)
	}
	return v, nil
}

func (s *fileSecrets) Set(name, value string) error {
	if err := checkSecret(name, value); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	m, err := s.load()
	if err != nil {
		return err
	}
	m[name] = value
	return s.save(m)
}

func (s *fileSecrets) Delete(name string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	m, err := s.load()
	if err != nil {
		return err
	}
	delete(m, name)
	return s.save(m)
}

func (s *fileSecrets) Names() ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	m, err := s.load()
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(m))
	for k := range m {
		names = append(names, k)
	}
	sort.Strings(names)
	return names, nil
}

// SecretMissingError: lỗi secret_missing kèm cách xử lý. Giá trị bí mật không đi qua AI/MCP nên không có tool đặt chúng;
// người dùng đặt trong app, còn AI chỉ chọn theo tên. Liệt kê tên đang có để AI chọn đúng hoặc báo người dùng.
func SecretMissingError(name string, s Secrets) error {
	msg := name + ": chưa có trong kho bí mật. Người dùng đặt giá trị trong app ChatQASoftware (AI/MCP không đặt được bí mật)"
	if s != nil {
		if names, err := FlowSecretNames(s); err == nil {
			if len(names) > 0 {
				msg += "; tên đang có: " + strings.Join(names, ", ")
			} else {
				msg += "; kho đang trống"
			}
		}
	}
	return apperr.New(CodeSecretMissing, msg+". Giá trị không bí mật (vd tài khoản test) truyền qua env")
}

const (
	CodeSecretMissing     = "secret_missing"      // flow cần biến chưa có trong kho bí mật
	CodeSecretStoreFailed = "secret_store_failed" // kho bí mật của hệ điều hành từ chối ghi
)

// ReservedSecretPrefix: tên bắt đầu bằng tiền tố này là khoá của app (khoá ký webhook của Giám sát), dùng chung kho với
// biến bí mật của flow nhưng không bao giờ là biến của flow: không liệt kê, không đặt, không xoá, không đưa vào lượt chạy.
const ReservedSecretPrefix = "WEBHOOK_"

// Khoá S3 của đồng bộ nhóm: hai tên dành riêng chính xác (không phải tiền tố), cùng luật với WEBHOOK_. Chỉ đặt/xoá qua
// hàm riêng của đồng bộ; giá trị vẫn nằm trong SecretValues nên lớp che xoá được nếu lọt vào log hay kết quả tool.
const (
	SyncAccessKeyName = "SYNC_S3_ACCESS_KEY"
	SyncSecretKeyName = "SYNC_S3_SECRET_KEY"
)

// ReservedSecretNames: mô tả các tên dành riêng cho câu báo lỗi.
const ReservedSecretNames = ReservedSecretPrefix + "..., " + SyncAccessKeyName + ", " + SyncSecretKeyName

// IsReservedSecret: tên là khoá của app (WEBHOOK_*, SYNC_S3_ACCESS_KEY, SYNC_S3_SECRET_KEY), không phải biến của flow.
func IsReservedSecret(name string) bool {
	return strings.HasPrefix(name, ReservedSecretPrefix) || name == SyncAccessKeyName || name == SyncSecretKeyName
}

// FlowSecretNames: tên biến bí mật của flow (bỏ khoá của app).
func FlowSecretNames(s Secrets) ([]string, error) {
	names, err := s.Names()
	if err != nil {
		return nil, err
	}
	out := names[:0:0]
	for _, n := range names {
		if !IsReservedSecret(n) {
			out = append(out, n)
		}
	}
	return out, nil
}
