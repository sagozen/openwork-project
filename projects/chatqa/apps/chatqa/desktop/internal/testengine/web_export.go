package testengine

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"chatqa/internal/pw"
	"deskcore/apperr"
)

// Xuất chạy độc lập: spec đã lưu chạy được bằng npx playwright test ngoài ChatQA (máy khác, CI). Gói zip có spec nguyên
// văn, fixture ./chatqa rút gọn (cùng tên export, không có gì của app), playwright.config.ts theo hồ sơ, package.json ghim
// @playwright/test và README liệt kê tên biến spec đọc. Không bao giờ có giá trị biến, trace hay file của lượt chạy.

// specEnvRe: process.env.TÊN trong spec. Bộ kiểm tra an toàn chỉ cho process.env ở dạng này (giá trị của fill,
// pressSequentially, keyboard.type), nên quét chữ cho đúng tập tên spec đọc mà không cần bộ chạy web.
var specEnvRe = regexp.MustCompile(`process\.env\.([A-Z_][A-Z0-9_]*)`)

// ExportSpec ghi <ExportsDir>/<app>-<flow>-standalone-<ngày giờ>.zip cho flow web name của app, cấu hình theo hồ sơ p
// (nil = không gắn hồ sơ: không baseURL, trình duyệt mặc định của Playwright). Trả đường dẫn đã ghi. Flow không phải
// .spec.ts là invalid, không có là not_found; spec chứa giá trị bí mật dạng chữ bị từ chối kèm dòng.
func (e *Engine) ExportSpec(app, name string, p *pw.Profile) (string, error) {
	dir, err := e.Flows.appDir(app)
	if err != nil {
		return "", err
	}
	if !IsSpecName(name) {
		return "", apperr.New(apperr.CodeInvalid, fmt.Sprintf("%q không phải flow web .spec.ts; chỉ flow web xuất chạy độc lập được", name))
	}
	path, err := flowPath(dir, name)
	if err != nil {
		return "", err
	}
	if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
		return "", apperr.New(apperr.CodeNotFound, "flow "+name)
	}
	src, err := readFlowFile(path)
	if err != nil {
		return "", err
	}
	if err := specSecretLiteral(cleanName(name), src, e.SecretValues()); err != nil {
		return "", err
	}
	cfg, err := pw.RenderStandaloneConfig(p)
	if err != nil {
		return "", err
	}
	fixture, err := pw.StandaloneFixture()
	if err != nil {
		return "", err
	}
	version := pw.DefaultPins.Playwright
	if e.Web != nil && e.Web.RT != nil && e.Web.RT.Pins != nil {
		version = e.Web.RT.Pins.Playwright
	}
	pkg, err := json.MarshalIndent(map[string]any{
		"name": "chatqa-standalone", "private": true,
		"scripts":         map[string]string{"test": "playwright test"},
		"devDependencies": map[string]string{"@playwright/test": version},
	}, "", "  ")
	if err != nil {
		return "", err
	}
	base := filepath.Base(filepath.FromSlash(name))
	files := []struct {
		name string
		body []byte
	}{
		{"tests/" + base, src},
		{"tests/chatqa.ts", fixture},
		{"playwright.config.ts", cfg},
		{"package.json", append(pkg, '\n')},
		{"README.md", standaloneReadme(base, src, p)},
	}
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, f := range files {
		w, err := zw.CreateHeader(&zip.FileHeader{Name: f.name, Method: zip.Deflate, Modified: e.now()})
		if err != nil {
			return "", err
		}
		if _, err := w.Write(f.body); err != nil {
			return "", err
		}
	}
	if err := zw.Close(); err != nil {
		return "", err
	}
	if err := os.MkdirAll(e.ExportsDir, 0o755); err != nil {
		return "", err
	}
	dest := filepath.Join(e.ExportsDir, fmt.Sprintf("%s-%s-standalone-%s.zip", safeName(app), specBase(name), e.now().Format("060102-150405")))
	if err := writeAtomic(dest, buf.Bytes(), 0o644); err != nil {
		return "", err
	}
	return dest, nil
}

// standaloneReadme: cách chạy gói và tên các biến spec đọc (không bao giờ có giá trị).
func standaloneReadme(spec string, src []byte, p *pw.Profile) []byte {
	seen := map[string]bool{}
	var names []string
	for _, m := range specEnvRe.FindAllStringSubmatch(string(src), -1) {
		if !seen[m[1]] {
			seen[m[1]] = true
			names = append(names, m[1])
		}
	}
	sort.Strings(names)
	install := "npx playwright install chromium"
	profile := "không gắn hồ sơ: đặt use.baseURL trong playwright.config.ts nếu spec mở đường dẫn tương đối"
	if p != nil {
		profile = "hồ sơ " + strings.Join(strings.Fields(p.Name), " ") + " (trình duyệt, viewport, baseURL trong playwright.config.ts)"
		install = "npx playwright install " + p.Browser
		if p.Channel != "" {
			install = "# kênh " + p.Channel + ": trình duyệt có sẵn trên máy, không cần cài thêm"
		}
	}
	var b strings.Builder
	fmt.Fprintf(&b, "# %s: chạy độc lập bằng Playwright\n\n", spec)
	fmt.Fprintf(&b, "Gói do ChatQA xuất từ flow web `tests/%s`, %s.\n\n", spec, profile)
	b.WriteString("## Chạy\n\n```sh\nnpm install\n" + install + "\n")
	b.WriteString("npx playwright test\n```\n\n## Biến môi trường spec đọc\n\n")
	if len(names) == 0 {
		b.WriteString("Spec không đọc biến nào.\n")
	} else {
		for _, n := range names {
			fmt.Fprintf(&b, "- `%s`\n", n)
		}
		b.WriteString("\nGói không chứa giá trị nào: đặt các biến này trong môi trường chạy (ví dụ secret của CI) trước `npx playwright test`.\n")
	}
	b.WriteString("\n## Khác với khi chạy trong ChatQA\n\n" +
		"- Không chặn host ngoài danh sách được phép của hồ sơ: spec chạy với mạng và biến của chính máy bạn.\n" +
		"- Không có ảnh từng bước, ảnh live hay bằng chứng của ChatQA; Playwright giữ trace của test lỗi trong test-results/.\n" +
		"- `tests/chatqa.ts` chỉ xuất `test`, `expect` và `step` (bọc `test.step`) để spec chạy nguyên văn.\n")
	return []byte(b.String())
}
