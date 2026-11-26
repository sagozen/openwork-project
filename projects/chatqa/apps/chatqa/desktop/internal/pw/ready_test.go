package pw

import (
	"os"
	"path/filepath"
	"testing"

	"deskcore/apperr"
)

// readyRuntime dựng bố cục đã cài (con trỏ, node, gói npm) với bộ ghim nhỏ; trình duyệt thêm bằng addBrowser.
func readyRuntime(t *testing.T) *Runtime {
	t.Helper()
	r := &Runtime{Dir: t.TempDir(), Platform: "darwin/arm64", Pins: &Pins{Node: "1", Playwright: "2", TypeScript: "3",
		Artifacts: map[string]Artifact{
			"darwin/arm64/chromium": {SHA256: "x", Kind: KindBrowser, Dir: "chromium-9"},
			"darwin/arm64/firefox":  {SHA256: "x", Kind: KindBrowser, Dir: "firefox-9"},
		}}}
	for _, f := range []string{
		filepath.Join(r.nodeDirName(), "bin", "node"),
		filepath.Join(r.modulesDirName(), "node_modules", "@playwright", "test", "cli.js"),
		filepath.Join(r.modulesDirName(), "node_modules", "typescript", "package.json"),
	} {
		writeFile(t, filepath.Join(r.Dir, f))
	}
	if err := r.setPointer(func(p *pointer) { p.Node, p.Modules = r.nodeDirName(), r.modulesDirName() }); err != nil {
		t.Fatal(err)
	}
	return r
}

func writeFile(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, nil, 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestReadyReportsWhatIsMissing(t *testing.T) {
	old := installedChannels
	t.Cleanup(func() { installedChannels = old })
	installedChannels = func() []ChannelStatus {
		return []ChannelStatus{{Name: "msedge", Installed: true}, {Name: "chrome"}}
	}

	empty := &Runtime{Dir: t.TempDir(), Platform: "darwin/arm64"}
	if err := empty.Ready("chromium", ""); apperr.CodeOf(err) != CodeRuntimeMissing {
		t.Fatalf("chưa cài gì: %v", err)
	}
	if err := empty.Ready("chromium", "msedge"); apperr.CodeOf(err) != CodeRuntimeMissing {
		t.Fatalf("kênh có sẵn nhưng chưa có Node: %v", err)
	}

	r := readyRuntime(t)
	if err := r.Ready("chromium", ""); apperr.CodeOf(err) != CodeRuntimeMissing {
		t.Fatalf("chưa tải chromium: %v", err)
	}
	if err := r.Ready("chromium", "msedge"); err != nil {
		t.Fatalf("msedge có sẵn: %v", err)
	}
	if err := r.Ready("chromium", "chrome"); apperr.CodeOf(err) != codeDeviceToolMissing {
		t.Fatalf("chrome chưa cài: %v", err)
	}
	writeFile(t, filepath.Join(r.BrowsersPath(), "chromium-9", completeMarker))
	if err := r.Ready("chromium", ""); err != nil {
		t.Fatalf("chromium đã cài: %v", err)
	}
	if err := r.Ready("firefox", ""); apperr.CodeOf(err) != CodeRuntimeMissing {
		t.Fatalf("firefox chưa cài: %v", err)
	}
	if err := r.Ready("opera", ""); apperr.CodeOf(err) != apperr.CodeInvalid {
		t.Fatalf("trình duyệt lạ: %v", err)
	}
}

func TestSecretSafeOnlyChromiumFamily(t *testing.T) {
	for _, c := range []struct {
		browser, channel string
		want             bool
	}{
		{"chromium", "", true},
		{"chromium", "chrome", true},
		{"chromium", "msedge", true},
		{"firefox", "", false},
		{"webkit", "", false},
	} {
		if got := (Profile{Browser: c.browser, Channel: c.channel}).SecretSafe(); got != c.want {
			t.Errorf("%s/%s: SecretSafe = %v", c.browser, c.channel, got)
		}
	}
}
