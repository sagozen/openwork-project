package pw

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// loadConfig nạp playwright.config.mjs đã sinh bằng Node thật (cùng guard.mjs) và trả export default dạng JSON.
func loadConfig(t *testing.T, cfg []byte) map[string]any {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("không có node trong PATH")
	}
	dir := t.TempDir()
	guard, err := scripts.ReadFile("js/guard.mjs")
	if err != nil {
		t.Fatal(err)
	}
	for name, body := range map[string][]byte{"guard.mjs": guard, configFile: cfg} {
		if err := os.WriteFile(filepath.Join(dir, name), body, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	code := `import('node:url').then((u) => import(u.pathToFileURL(process.argv[1]).href))` +
		`.then((m) => process.stdout.write(JSON.stringify(m.default)))`
	out, err := exec.Command(node, "--input-type=module", "-e", code, filepath.Join(dir, configFile)).CombinedOutput()
	if err != nil {
		t.Fatalf("node không nạp được cấu hình: %v\n%s\n--- cấu hình ---\n%s", err, out, cfg)
	}
	var m map[string]any
	if err := json.Unmarshal(out, &m); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	return m
}

func baseProfile() Profile {
	return Profile{ID: "web-a", Name: "A", Browser: "chromium", Width: 1280, Height: 800, BaseURL: "https://app.example.com/base",
		Headless: true, AllowedHosts: []string{"API.Example.com", "*.cdn.example.com"}, TestIDAttribute: "data-qa"}
}

func TestRenderConfigFixedValuesAndDownloadedChromiumChannel(t *testing.T) {
	cfg, err := RenderConfig(ConfigOptions{Profile: baseProfile(), Video: VideoOnFailure, Timeout: 90 * time.Second,
		Reporter: "/w/run/reporter.mjs", Report: "/w/run/report.ndjson", OutputDir: "/w/run/test-results"})
	if err != nil {
		t.Fatal(err)
	}
	m := loadConfig(t, cfg)
	for k, want := range map[string]any{"retries": 0.0, "workers": 1.0, "fullyParallel": false, "forbidOnly": true, "timeout": 90000.0,
		"testDir": ".", "outputDir": "/w/run/test-results"} {
		if !reflect.DeepEqual(m[k], want) {
			t.Errorf("%s = %v, muốn %v", k, m[k], want)
		}
	}
	if !reflect.DeepEqual(m["reporter"], []any{[]any{"/w/run/reporter.mjs", map[string]any{"output": "/w/run/report.ndjson"}}}) {
		t.Errorf("reporter = %v", m["reporter"])
	}
	use := m["use"].(map[string]any)
	for k, want := range map[string]any{"browserName": "chromium", "channel": "chromium", "headless": true, "trace": "retain-on-failure",
		"video": "retain-on-failure", "screenshot": "off", "serviceWorkers": "block", "acceptDownloads": false,
		"baseURL": "https://app.example.com/base", "testIdAttribute": "data-qa"} {
		if !reflect.DeepEqual(use[k], want) {
			t.Errorf("use.%s = %v, muốn %v", k, use[k], want)
		}
	}
	args := use["launchOptions"].(map[string]any)["args"].([]any)
	if len(args) != 1 || args[0] != "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE api.example.com, EXCLUDE *.cdn.example.com, EXCLUDE app.example.com" {
		t.Errorf("launchOptions.args = %v", args)
	}
}

func TestRenderConfigChannelsAndOtherBrowsers(t *testing.T) {
	edge := baseProfile()
	edge.Channel = "msedge"
	use := loadConfig(t, mustConfig(t, ConfigOptions{Profile: edge}))["use"].(map[string]any)
	if use["channel"] != "msedge" || use["launchOptions"] == nil || use["video"] != "off" {
		t.Errorf("msedge: %v", use)
	}
	ff := baseProfile()
	ff.Browser = "firefox"
	use = loadConfig(t, mustConfig(t, ConfigOptions{Profile: ff, Video: VideoOn}))["use"].(map[string]any)
	if _, has := use["channel"]; has || use["launchOptions"] != nil || use["browserName"] != "firefox" || use["video"] != "on" {
		t.Errorf("firefox không có channel hay cờ Chromium: %v", use)
	}
}

func mustConfig(t *testing.T, o ConfigOptions) []byte {
	t.Helper()
	cfg, err := RenderConfig(o)
	if err != nil {
		t.Fatal(err)
	}
	return cfg
}

func TestRenderConfigKeepsHostileValuesAsStrings(t *testing.T) {
	p := baseProfile()
	p.BaseURL = "https://app.example.com/x'\"`;${process.exit(9)}</script>  \n"
	p.TestIDAttribute = "data-x\"});process.exit(7);({"
	p.Name = "'; require('child_process').execSync('touch /tmp/pwned'); '"
	o := ConfigOptions{Profile: p, Reporter: "/w/a\"b/reporter.mjs", Report: "/w/a`b/report.ndjson", OutputDir: "/w/${x}/out"}
	cfg := mustConfig(t, o)
	if strings.Contains(string(cfg), " ") || strings.Contains(string(cfg), "pwned") {
		t.Fatalf("giá trị lạ lọt nguyên dạng vào cấu hình:\n%s", cfg)
	}
	m := loadConfig(t, cfg)
	use := m["use"].(map[string]any)
	if use["baseURL"] != p.BaseURL || use["testIdAttribute"] != p.TestIDAttribute || m["outputDir"] != "/w/${x}/out" {
		t.Fatalf("giá trị phải giữ nguyên là chuỗi: %v", m)
	}
}

func TestVideoForAndAllowedHosts(t *testing.T) {
	for rec, want := range map[string]string{"": VideoOff, "always": VideoOn, "on-failure": VideoOnFailure, "lạ": VideoOff} {
		if got := VideoFor(rec); got != want {
			t.Errorf("VideoFor(%q) = %s, muốn %s", rec, got, want)
		}
	}
	got := AllowedHosts(Profile{BaseURL: "http://Localhost:8080/", AllowedHosts: []string{"a.test.", "A.test", "localhost"}})
	if !reflect.DeepEqual(got, []string{"a.test", "localhost"}) {
		t.Fatalf("AllowedHosts = %v", got)
	}
}
