package pw

import (
	"slices"
	"strings"
	"testing"

	"deskcore/apperr"
)

func validProfile() Profile {
	return Profile{
		ID: "web-staging", Name: "Staging", Browser: "chromium", Width: 1280, Height: 800,
		BaseURL: "https://staging.example.com", Headless: true, AllowedHosts: []string{"api.example.com"},
	}
}

func TestProfileValidateNormalizes(t *testing.T) {
	p := validProfile()
	p.Name = "  Staging  "
	p.AllowedHosts = []string{" API.Example.com. ", "api.example.com", "", "*.cdn.example.com", "localhost", "127.0.0.1"}
	if err := p.Validate(); err != nil {
		t.Fatal(err)
	}
	if p.Name != "Staging" || p.TestIDAttribute != DefaultTestIDAttribute {
		t.Fatalf("chuẩn hoá: %+v", p)
	}
	if want := []string{"api.example.com", "*.cdn.example.com", "localhost", "127.0.0.1"}; !slices.Equal(p.AllowedHosts, want) {
		t.Fatalf("hosts = %q, muốn %q", p.AllowedHosts, want)
	}
	q := validProfile()
	q.Browser, q.Channel = "chromium", "msedge"
	q.TestIDAttribute = "data-qa"
	if err := q.Validate(); err != nil || q.TestIDAttribute != "data-qa" {
		t.Fatalf("msedge + data-qa: %v", err)
	}
}

func TestProfileValidateRejects(t *testing.T) {
	cases := map[string]func(p *Profile){
		"mã không có tiền tố web-":    func(p *Profile) { p.ID = "staging" },
		"mã chữ hoa":                  func(p *Profile) { p.ID = "web-Staging" },
		"mã dài quá 40":               func(p *Profile) { p.ID = "web-" + strings.Repeat("a", 41) },
		"tên trống":                   func(p *Profile) { p.Name = " " },
		"trình duyệt lạ":              func(p *Profile) { p.Browser = "opera" },
		"kênh lạ":                     func(p *Profile) { p.Channel = "brave" },
		"kênh với firefox":            func(p *Profile) { p.Browser, p.Channel = "firefox", "msedge" },
		"viewport hẹp":                func(p *Profile) { p.Width = 319 },
		"viewport cao quá":            func(p *Profile) { p.Height = 2161 },
		"baseURL không scheme":        func(p *Profile) { p.BaseURL = "staging.example.com" },
		"baseURL file":                func(p *Profile) { p.BaseURL = "file:///etc" },
		"baseURL có tài khoản":        func(p *Profile) { p.BaseURL = "https://u:p@staging.example.com" },
		"host có scheme":              func(p *Profile) { p.AllowedHosts = []string{"https://a.com"} },
		"host có cổng":                func(p *Profile) { p.AllowedHosts = []string{"a.com:8080"} },
		"host có đường dẫn":           func(p *Profile) { p.AllowedHosts = []string{"a.com/x"} },
		"host gạch dưới":              func(p *Profile) { p.AllowedHosts = []string{"a_b.com"} },
		"wildcard trơn":               func(p *Profile) { p.AllowedHosts = []string{"*"} },
		"wildcard giữa":               func(p *Profile) { p.AllowedHosts = []string{"a.*.com"} },
		"wildcard TLD":                func(p *Profile) { p.AllowedHosts = []string{"*.com"} },
		"wildcard hậu tố công cộng":   func(p *Profile) { p.AllowedHosts = []string{"*.co.uk"} },
		"wildcard vercel.app":         func(p *Profile) { p.AllowedHosts = []string{"*.vercel.app"} },
		"wildcard github.io":          func(p *Profile) { p.AllowedHosts = []string{"*.github.io"} },
		"wildcard một nhãn":           func(p *Profile) { p.AllowedHosts = []string{"*.localhost"} },
		"IPv6":                        func(p *Profile) { p.AllowedHosts = []string{"::1"} },
		"thuộc tính test id có dấu ]": func(p *Profile) { p.TestIDAttribute = "data-x]" },
		"thuộc tính test id có phẩy":  func(p *Profile) { p.TestIDAttribute = "a,b" },
	}
	for name, mut := range cases {
		p := validProfile()
		mut(&p)
		if err := p.Validate(); apperr.CodeOf(err) != apperr.CodeInvalid {
			t.Errorf("%s: phải là invalid, được %v", name, err)
		}
	}
	// Wildcard trên tên miền đăng ký được thì hợp lệ.
	for _, h := range []string{"*.example.com", "*.example.co.uk", "*.my-app.vercel.app"} {
		p := validProfile()
		p.AllowedHosts = []string{h}
		if err := p.Validate(); err != nil {
			t.Errorf("%s: %v", h, err)
		}
	}
}

func TestProfileFingerprint(t *testing.T) {
	a := validProfile()
	b := validProfile()
	b.Name = "Tên khác"
	if a.Fingerprint() != b.Fingerprint() {
		t.Fatal("đổi tên không được đổi dấu")
	}
	for name, mut := range map[string]func(p *Profile){
		"viewport": func(p *Profile) { p.Width = 1024 },
		"hosts":    func(p *Profile) { p.AllowedHosts = []string{"x.example.com"} },
		"headless": func(p *Profile) { p.Headless = false },
		"channel":  func(p *Profile) { p.Channel = "chrome" },
		"testid":   func(p *Profile) { p.TestIDAttribute = "data-qa" },
		"baseURL":  func(p *Profile) { p.BaseURL = "https://other.example.com" },
	} {
		c := validProfile()
		mut(&c)
		if c.Fingerprint() == a.Fingerprint() {
			t.Errorf("đổi %s phải đổi dấu", name)
		}
	}
}
