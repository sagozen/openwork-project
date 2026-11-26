package testengine

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"

	"chatqa/internal/pw"
	"deskcore/apperr"
)

func TestExportSpecWritesStandaloneZipWithoutSecrets(t *testing.T) {
	e, _ := webEngine(t, nil)
	hostile := pw.Profile{ID: "web-x", Name: "x\"; require('child_process').exec('id'); //\u2028*/`${1}`", Browser: "chromium", Channel: "chrome",
		Width: 390, Height: 844, BaseURL: "http://app.test/?q=\"';</script>${x}", Headless: true, TestIDAttribute: "data-qa"}
	path, err := e.ExportSpec("demo", "login.spec.ts", &hostile)
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Dir(path) != e.ExportsDir || !regexp.MustCompile(`^demo-login-standalone-\d{6}-\d{6}\.zip$`).MatchString(filepath.Base(path)) {
		t.Fatalf("đường dẫn = %s", path)
	}
	files := readZip(t, path)
	var names []string
	for n := range files {
		names = append(names, n)
	}
	slices.Sort(names)
	if !slices.Equal(names, []string{"README.md", "package.json", "playwright.config.ts", "tests/chatqa.ts", "tests/login.spec.ts"}) {
		t.Fatalf("file trong zip = %v", names)
	}
	if files["tests/login.spec.ts"] != loginSpec {
		t.Fatal("spec phải giữ nguyên văn")
	}
	fixture, _ := pw.StandaloneFixture()
	if files["tests/chatqa.ts"] != string(fixture) {
		t.Fatal("tests/chatqa.ts phải là fixture độc lập")
	}
	var pkg struct {
		DevDependencies map[string]string `json:"devDependencies"`
	}
	if err := json.Unmarshal([]byte(files["package.json"]), &pkg); err != nil || pkg.DevDependencies["@playwright/test"] != pw.DefaultPins.Playwright {
		t.Fatalf("package.json = %s (%v)", files["package.json"], err)
	}
	cfg := files["playwright.config.ts"]
	for _, v := range []string{hostile.Name, hostile.BaseURL} {
		lit, _ := json.Marshal(v)
		if !strings.Contains(cfg, string(lit)) || strings.Contains(cfg, v) {
			t.Fatalf("giá trị hồ sơ phải ở dạng JSON đã thoát: %q\n%s", v, cfg)
		}
	}
	if m := loadStandaloneConfig(t, cfg); m != nil {
		use := m["use"].(map[string]any)
		meta := m["metadata"].(map[string]any)
		if use["baseURL"] != hostile.BaseURL || meta["profile"] != hostile.Name || use["channel"] != "chrome" || use["testIdAttribute"] != "data-qa" ||
			m["testDir"] != "tests" || use["trace"] != "retain-on-failure" {
			t.Fatalf("cấu hình nạp bằng Node = %v", m)
		}
	}
	readme := files["README.md"]
	if !strings.Contains(readme, "`PASSWORD`") || !strings.Contains(readme, "chrome") {
		t.Fatalf("README phải liệt kê tên biến spec đọc:\n%s", readme)
	}
	for name, body := range files {
		for _, f := range secretForms([]string{secretPassword, "fixture-default"}) {
			if strings.Contains(body, f) {
				t.Errorf("%s chứa giá trị biến", name)
			}
		}
		if strings.Contains(name, "trace") || strings.HasSuffix(name, ".zip") {
			t.Errorf("zip không được có trace: %s", name)
		}
	}
}

// loadStandaloneConfig nạp playwright.config.ts bằng Node thật (Node 23.6+ tự bỏ kiểu TypeScript) và trả export
// default dạng JSON; nil khi máy không có node.
func loadStandaloneConfig(t *testing.T, cfg string) map[string]any {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		return nil
	}
	dir := t.TempDir()
	file := filepath.Join(dir, "playwright.config.mts")
	if err := os.WriteFile(file, []byte(cfg), 0o600); err != nil {
		t.Fatal(err)
	}
	code := `import('node:url').then((u) => import(u.pathToFileURL(process.argv[1]).href))` +
		`.then((m) => process.stdout.write(JSON.stringify(m.default)))`
	out, err := exec.Command(node, "--input-type=module", "-e", code, file).Output()
	if err != nil {
		t.Fatalf("node không nạp được cấu hình: %v\n%s", err, cfg)
	}
	var m map[string]any
	if err := json.Unmarshal(out, &m); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	return m
}

func TestExportSpecWithoutProfileAndDownloadedChromium(t *testing.T) {
	e, _ := webEngine(t, nil)
	path, err := e.ExportSpec("demo", "login.spec.ts", nil)
	if err != nil {
		t.Fatal(err)
	}
	cfg := readZip(t, path)["playwright.config.ts"]
	if strings.Contains(cfg, "baseURL") || strings.Contains(cfg, "channel") {
		t.Fatalf("không gắn hồ sơ thì không có baseURL hay kênh:\n%s", cfg)
	}
	p := webProfiles["web-a"]
	path, err = e.ExportSpec("demo", "login.spec.ts", &p)
	if err != nil {
		t.Fatal(err)
	}
	files := readZip(t, path)
	if cfg := files["playwright.config.ts"]; strings.Contains(cfg, "channel") || !strings.Contains(cfg, `"baseURL":"http://app.test"`) {
		t.Fatalf("chromium tải về không đặt kênh:\n%s", cfg)
	}
	if !strings.Contains(files["README.md"], "npx playwright install chromium") {
		t.Fatalf("README:\n%s", files["README.md"])
	}
}

func TestExportSpecRefusesNonSpecMissingAndSecretLiteral(t *testing.T) {
	e, _ := webEngine(t, nil)
	if _, err := e.ExportSpec("demo", "01_login.yaml", nil); apperr.CodeOf(err) != apperr.CodeInvalid {
		t.Fatalf("flow YAML: %v", err)
	}
	if _, err := e.ExportSpec("demo", "khong_co.spec.ts", nil); apperr.CodeOf(err) != apperr.CodeNotFound {
		t.Fatalf("flow không có: %v", err)
	}
	leak := strings.Replace(loginSpec, "fill(process.env.PASSWORD)", "fill('"+secretPassword+"')", 1)
	writeTree(t, filepath.Join(e.Flows.Root, "demo"), map[string]string{"leak.spec.ts": leak})
	_, err := e.ExportSpec("demo", "leak.spec.ts", nil)
	var fe FlowErrors
	if !asFlowErrors(err, &fe) || fe[0].Line != 8 || strings.Contains(err.Error(), secretPassword) {
		t.Fatalf("spec chứa bí mật dạng chữ: %v", err)
	}
	if entries, _ := os.ReadDir(e.ExportsDir); len(entries) != 0 {
		t.Fatalf("không được ghi zip khi từ chối: %v", entries)
	}
}
