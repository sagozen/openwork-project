package pw

import (
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// Host được phép làm nguồn tải trong pin.
var allowedHosts = map[string]bool{
	"nodejs.org":                             true,
	"registry.npmjs.org":                     true,
	"cdn.playwright.dev":                     true,
	"playwright.download.prss.microsoft.com": true,
	"storage.googleapis.com":                 true, // kho Chrome for Testing của Google (cdn.playwright.dev chuyển tiếp về đây)
}

var hex64 = regexp.MustCompile(`^[0-9a-f]{64}$`)

// Phiên bản Playwright/TypeScript của bộ chạy phải trùng package-lock.json gốc (chạy cùng phiên bản với
// test giao diện của repo), và integrity của từng gói npm đã ghim phải trùng lockfile.
func TestPinsMatchRootLockfile(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "..", "package-lock.json"))
	if err != nil {
		t.Skip("không có package-lock.json gốc (chạy ngoài repo)")
	}
	var lock struct {
		Packages map[string]struct{ Version, Integrity string } `json:"packages"`
	}
	if err := json.Unmarshal(raw, &lock); err != nil {
		t.Fatal(err)
	}
	if v := lock.Packages["node_modules/@playwright/test"].Version; v != DefaultPins.Playwright {
		t.Errorf("lockfile @playwright/test %s, pin %s", v, DefaultPins.Playwright)
	}
	if v := lock.Packages["node_modules/typescript"].Version; v != DefaultPins.TypeScript {
		t.Errorf("lockfile typescript %s, pin %s", v, DefaultPins.TypeScript)
	}
	for _, name := range NPMPackages {
		a, ok := DefaultPins.Artifacts["npm/"+name]
		if !ok {
			t.Errorf("thiếu pin npm/%s", name)
			continue
		}
		if e, ok := lock.Packages["node_modules/"+name]; ok && e.Integrity != a.Integrity {
			t.Errorf("npm/%s integrity %s khác lockfile %s", name, a.Integrity, e.Integrity)
		}
		if !strings.HasPrefix(a.Integrity, "sha512-") {
			t.Errorf("npm/%s thiếu integrity sha512", name)
		}
	}
}

func TestPinsAreWellFormed(t *testing.T) {
	for key, a := range DefaultPins.Artifacts {
		if !strings.HasPrefix(key, "npm/") && !strings.HasPrefix(key, "darwin/arm64/") && !strings.HasPrefix(key, "windows/amd64/") {
			t.Errorf("%s: nền tảng không phát hành", key)
		}
		if !hex64.MatchString(a.SHA256) {
			t.Errorf("%s: sha256 %q", key, a.SHA256)
		}
		if a.Size <= 0 {
			t.Errorf("%s: thiếu kích thước", key)
		}
		for i, raw := range []string{a.URL, a.Mirror} {
			if i == 1 && raw == "" { // Mirror chỉ bắt buộc với trình duyệt (kiểm tra bên dưới)
				continue
			}
			u, err := url.Parse(raw)
			if err != nil || u.Scheme != "https" || !allowedHosts[u.Hostname()] {
				t.Errorf("%s: nguồn không được phép %q", key, raw)
			}
		}
		switch a.Kind {
		case KindBrowser:
			if a.Mirror == "" || a.Mirror == a.URL {
				t.Errorf("%s: trình duyệt phải có nguồn thứ hai đã đối chiếu", key)
			}
			if a.Dir == "" || a.Rev == "" || !strings.HasSuffix(a.Dir, "-"+a.Rev) {
				t.Errorf("%s: thư mục %q revision %q", key, a.Dir, a.Rev)
			}
		case KindNode, KindNPM:
		default:
			t.Errorf("%s: loại %q", key, a.Kind)
		}
	}
}

// Ensure([chromium]) cài kèm ffmpeg, nên có pin chromium thì phải có pin ffmpeg cùng nền tảng.
func TestChromiumPinImpliesFFmpeg(t *testing.T) {
	for _, plat := range []string{"darwin/arm64", "windows/amd64"} {
		if _, ok := DefaultPins.Artifacts[plat+"/chromium"]; !ok {
			continue
		}
		if _, ok := DefaultPins.Artifacts[plat+"/ffmpeg"]; !ok {
			t.Errorf("%s có chromium nhưng thiếu ffmpeg", plat)
		}
	}
}

// A release must be able to install the browser runner on every platform it ships to. A missing Node or Chromium pin
// (the generator could not verify it) makes "Cài bộ chạy" fail with driver_bundle_unavailable for every user there.
func TestDefaultPinsCoverReleasePlatforms(t *testing.T) {
	for _, platform := range []string{"darwin/arm64", "windows/amd64"} {
		for _, name := range []string{"node", "chromium", "ffmpeg"} {
			key := platform + "/" + name
			a, ok := DefaultPins.Artifacts[key]
			if !ok || a.URL == "" || len(a.SHA256) != 64 {
				t.Errorf("pins_gen.go has no verified pin for %s: run `go run ./cmd/pwpin` and commit the result", key)
			}
		}
	}
}
