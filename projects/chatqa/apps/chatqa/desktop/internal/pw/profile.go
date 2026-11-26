package pw

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net"
	"net/url"
	"regexp"
	"strings"

	"golang.org/x/net/publicsuffix"

	"deskcore/apperr"
)

// DefaultTestIDAttribute: thuộc tính getByTestId dùng khi hồ sơ không đặt.
const DefaultTestIDAttribute = "data-testid"

var (
	profileIDRe = regexp.MustCompile(`^web-[a-z0-9-]{1,40}$`)
	hostLabelRe = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)
	testIDRe    = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_:.-]{0,63}$`)
)

// Profile: một hồ sơ trình duyệt, cũng là một thiết bị web trong fleet. JSON này đồng thời là tham số
// profile của lệnh open gửi sidecar.
type Profile struct {
	ID              string   `json:"id"`
	Name            string   `json:"name"`
	Browser         string   `json:"browser"` // chromium | firefox | webkit
	Channel         string   `json:"channel"` // "" (chromium tải về) | msedge | chrome, chỉ với chromium
	Width           int      `json:"width"`
	Height          int      `json:"height"`
	BaseURL         string   `json:"baseURL"`
	Headless        bool     `json:"headless"`
	AllowedHosts    []string `json:"allowedHosts"` // tên host hoặc *.domain; host của BaseURL luôn được phép
	TestIDAttribute string   `json:"testIdAttribute"`
}

func invalid(msg string) error { return apperr.New(apperr.CodeInvalid, msg) }

// Validate chuẩn hoá (cắt khoảng trắng, host chữ thường, thuộc tính test id mặc định) rồi kiểm tra hồ sơ.
func (p *Profile) Validate() error {
	p.ID = strings.TrimSpace(p.ID)
	p.Name = strings.TrimSpace(p.Name)
	p.BaseURL = strings.TrimSpace(p.BaseURL)
	p.TestIDAttribute = strings.TrimSpace(p.TestIDAttribute)
	if p.TestIDAttribute == "" {
		p.TestIDAttribute = DefaultTestIDAttribute
	}
	if !profileIDRe.MatchString(p.ID) {
		return invalid("mã hồ sơ phải có dạng web-<chữ thường, số, gạch ngang> (tối đa 40 ký tự)")
	}
	if p.Name == "" || len([]rune(p.Name)) > 80 {
		return invalid("tên hồ sơ trống hoặc dài quá 80 ký tự")
	}
	if !isBrowser(p.Browser) {
		return invalid("trình duyệt phải là chromium, firefox hoặc webkit")
	}
	switch p.Channel {
	case "":
	case "msedge", "chrome":
		if p.Browser != "chromium" {
			return invalid("kênh " + p.Channel + " chỉ dùng với chromium")
		}
	default:
		return invalid("kênh trình duyệt phải trống, msedge hoặc chrome")
	}
	if p.Width < 320 || p.Width > 3840 || p.Height < 240 || p.Height > 2160 {
		return invalid("viewport phải trong 320..3840 x 240..2160")
	}
	u, err := url.Parse(p.BaseURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || u.User != nil {
		return invalid("baseURL phải là http(s)://host[...] và không chứa tài khoản")
	}
	hosts := make([]string, 0, len(p.AllowedHosts))
	seen := map[string]bool{}
	for _, h := range p.AllowedHosts {
		h = strings.TrimSuffix(strings.ToLower(strings.TrimSpace(h)), ".")
		if h == "" || seen[h] {
			continue
		}
		if err := validHost(h); err != nil {
			return err
		}
		seen[h] = true
		hosts = append(hosts, h)
	}
	p.AllowedHosts = hosts
	if !testIDRe.MatchString(p.TestIDAttribute) {
		return invalid("thuộc tính test id không hợp lệ")
	}
	return nil
}

// validHost: tên host, địa chỉ IPv4, hoặc *.domain. Wildcard phải nằm trên một tên miền đăng ký được
// (không phải hậu tố công cộng): *.vercel.app hay *.github.io mở cửa cho mọi người dùng của dịch vụ đó.
func validHost(h string) error {
	if ip := net.ParseIP(h); ip != nil && ip.To4() != nil {
		return nil
	}
	domain, wild := strings.CutPrefix(h, "*.")
	if len(domain) > 253 || strings.Contains(domain, "*") {
		return invalid("host không hợp lệ: " + h)
	}
	for _, label := range strings.Split(domain, ".") {
		if !hostLabelRe.MatchString(label) {
			return invalid("host không hợp lệ: " + h)
		}
	}
	if wild {
		if !strings.Contains(domain, ".") {
			return invalid("wildcard phải trên một tên miền cụ thể: " + h)
		}
		if _, err := publicsuffix.EffectiveTLDPlusOne(domain); err != nil {
			return invalid("wildcard trên hậu tố công cộng không được phép: " + h)
		}
	}
	return nil
}

// SecretSafe: hồ sơ thuộc họ Chromium (chromium tải về, chrome, msedge), họ duy nhất có ranh giới host ở tầng
// DNS (--host-resolver-rules). Firefox/WebKit chỉ có route/WebSocket/popup nên vẫn lọt request (chuyển hướng,
// gợi ý DNS); lượt có biến bí mật (secrets hay ${NAME} khi điền) chỉ được chạy trên hồ sơ SecretSafe.
func (p Profile) SecretSafe() bool { return p.Browser == "chromium" }

// Fingerprint: dấu của mọi trường ảnh hưởng tới trình duyệt đang mở (đổi tên không đổi dấu). Pool so dấu
// để biết phải mở lại phiên.
func (p Profile) Fingerprint() string {
	q := p
	q.Name = ""
	b, _ := json.Marshal(q) // struct chỉ gồm kiểu cơ bản, không thể lỗi
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:8])
}
