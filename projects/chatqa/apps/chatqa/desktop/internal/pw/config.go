package pw

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
	"time"
)

// Video của lượt chạy spec (Record của lệnh chạy: "" | always | on-failure).
const (
	VideoOff       = "off"
	VideoOn        = "on"
	VideoOnFailure = "retain-on-failure"
)

// VideoFor đổi Record của lệnh chạy sang chế độ video của Playwright.
func VideoFor(record string) string {
	switch record {
	case "always":
		return VideoOn
	case "on-failure":
		return VideoOnFailure
	}
	return VideoOff
}

// Hạn thao tác và điều hướng trong spec, cùng giá trị với sidecar.
const (
	actionTimeoutMs     = 10_000
	navigationTimeoutMs = 25_000
	defaultTestTimeout  = 10 * time.Minute
)

// AllowedHosts: host được phép của hồ sơ (chữ thường, không trùng) cộng host của baseURL, cùng cách tính với
// allowedHosts trong guard.mjs. Đây là danh sách bộ kiểm tra spec, fixture và --host-resolver-rules dùng chung.
func AllowedHosts(p Profile) []string {
	seen := map[string]bool{}
	var out []string
	add := func(h string) {
		h = strings.TrimSuffix(strings.ToLower(strings.TrimSpace(h)), ".")
		h = strings.TrimSuffix(strings.TrimPrefix(h, "["), "]")
		if h != "" && !seen[h] {
			seen[h] = true
			out = append(out, h)
		}
	}
	for _, h := range p.AllowedHosts {
		add(h)
	}
	if u, err := url.Parse(p.BaseURL); err == nil {
		add(u.Hostname())
	}
	return out
}

// ConfigOptions: mọi thứ playwright.config.mjs của một lượt cần.
type ConfigOptions struct {
	Profile   Profile
	Video     string        // VideoOff | VideoOn | VideoOnFailure
	Timeout   time.Duration // hạn của một test; 0 = 10 phút
	Reporter  string        // đường dẫn reporter.mjs
	Report    string        // file NDJSON reporter ghi
	OutputDir string        // thư mục kết quả của Playwright (ảnh, video, trace)
}

// RenderConfig sinh playwright.config.mjs. Mọi giá trị đến từ hồ sơ hay đường dẫn đều qua json.Marshal (chuỗi JSON
// là biểu thức JS hợp lệ, Go thoát cả U+2028/U+2029), nên giá trị lạ trong hồ sơ không bao giờ thành mã.
// Cố định: retries 0, workers 1, không song song, trace chỉ giữ khi lỗi, không chụp ảnh tự động, chặn service worker
// và tải file. Chromium tải về luôn mở bằng channel 'chromium' (bản đầy đủ chạy headless); msedge/chrome dùng kênh
// của hồ sơ. Họ Chromium thêm --host-resolver-rules: mọi tên miền ngoài danh sách không phân giải được.
func RenderConfig(o ConfigOptions) ([]byte, error) {
	p := o.Profile
	timeout := o.Timeout
	if timeout <= 0 {
		timeout = defaultTestTimeout
	}
	video := o.Video
	if video != VideoOn && video != VideoOnFailure {
		video = VideoOff
	}
	use := map[string]any{
		"browserName":       p.Browser,
		"headless":          p.Headless,
		"viewport":          map[string]int{"width": p.Width, "height": p.Height},
		"baseURL":           p.BaseURL,
		"testIdAttribute":   firstNonEmpty(p.TestIDAttribute, DefaultTestIDAttribute),
		"trace":             "retain-on-failure",
		"video":             video,
		"screenshot":        "off",
		"serviceWorkers":    "block",
		"acceptDownloads":   false,
		"actionTimeout":     actionTimeoutMs,
		"navigationTimeout": navigationTimeoutMs,
	}
	chromium := p.Browser == "chromium"
	if chromium {
		use["channel"] = firstNonEmpty(p.Channel, "chromium")
	}
	strs, err := jsLiterals(AllowedHosts(p), chromium, use, timeout.Milliseconds(), o.Reporter, map[string]string{"output": o.Report}, o.OutputDir)
	if err != nil {
		return nil, err
	}
	var b bytes.Buffer
	fmt.Fprintf(&b, `// Sinh bởi ChatQA cho một lượt chạy; mọi giá trị là JSON. Không sửa tay.
import { resolverRules } from './guard.mjs';

const hosts = %s;
const chromiumFamily = %s;
const use = %s;
if (chromiumFamily) use.launchOptions = { args: ['--host-resolver-rules=' + resolverRules(hosts)] };

export default {
  testDir: '.',
  testMatch: ['flow.spec.ts'],
  timeout: %s,
  retries: 0,
  workers: 1,
  fullyParallel: false,
  forbidOnly: true,
  updateSnapshots: 'none',
  reporter: [[%s, %s]],
  outputDir: %s,
  use,
};
`, strs...)
	return b.Bytes(), nil
}

// RenderStandaloneConfig sinh playwright.config.ts của gói xuất chạy độc lập (npx playwright test ngoài app): testDir
// tests, trace chỉ giữ khi lỗi; có hồ sơ thì thêm trình duyệt, kênh msedge/chrome, headless, viewport, baseURL và
// testIdAttribute. Không có fixture chặn host, reporter hay biến của app. Mọi giá trị qua json.Marshal như RenderConfig.
func RenderStandaloneConfig(p *Profile) ([]byte, error) {
	use := map[string]any{"trace": "retain-on-failure"}
	meta := map[string]any{"exportedBy": "ChatQA"}
	if p != nil {
		use["browserName"] = p.Browser
		use["headless"] = p.Headless
		use["viewport"] = map[string]int{"width": p.Width, "height": p.Height}
		if p.BaseURL != "" {
			use["baseURL"] = p.BaseURL
		}
		if p.TestIDAttribute != "" {
			use["testIdAttribute"] = p.TestIDAttribute
		}
		if p.Browser == "chromium" && p.Channel != "" { // msedge/chrome có sẵn trên máy; chromium tải bằng npx playwright install
			use["channel"] = p.Channel
		}
		meta["profile"] = p.Name
	}
	strs, err := jsLiterals(use, meta)
	if err != nil {
		return nil, err
	}
	var b bytes.Buffer
	fmt.Fprintf(&b, `// Sinh bởi ChatQA khi xuất flow chạy độc lập; mọi giá trị là JSON. Chạy: npx playwright test
const use = %s;

export default {
  testDir: 'tests',
  retries: 0,
  reporter: 'list',
  metadata: %s,
  use,
};
`, strs...)
	return b.Bytes(), nil
}

// jsLiterals đổi từng giá trị thành biểu thức JS bằng json.Marshal (chuỗi JSON là biểu thức JS hợp lệ).
func jsLiterals(vals ...any) ([]any, error) {
	out := make([]any, len(vals))
	for i, v := range vals {
		b, err := json.Marshal(v)
		if err != nil {
			return nil, err
		}
		out[i] = string(b)
	}
	return out, nil
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}
