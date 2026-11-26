//go:build pwintegration

package pw

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Hợp đồng với bố cục nội bộ của Playwright: cài thật bằng DefaultPins (Go tải, kiểm SHA-256, giải nén,
// ghi INSTALLATION_COMPLETE) rồi Playwright phải mở được Chromium headless từ đúng thư mục đó với
// channel 'chromium'. Chạy khi đổi pins_gen.go:
//
//	go test -tags pwintegration ./internal/pw/ -run Integration -count=1 -timeout 20m
func TestIntegrationChromiumLaunchesFromGoLayout(t *testing.T) {
	r := &Runtime{Dir: t.TempDir()}
	ctx, cancel := context.WithTimeout(context.Background(), 18*time.Minute)
	defer cancel()
	if err := r.Ensure(ctx, []string{"chromium"}, nil); err != nil {
		t.Fatal(err)
	}
	core := filepath.Join(r.ModulesDir(), "node_modules", "playwright-core")
	script := `const { chromium } = require(process.argv[1]);
(async () => {
  const browser = await chromium.launch({ channel: 'chromium', headless: true });
  const page = await browser.newPage();
  await page.setContent('<p id="x">cqs-ok</p>');
  console.log(await page.textContent('#x'));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });`
	cmd := exec.CommandContext(ctx, r.NodePath(), "-e", script, core)
	cmd.Dir = r.WorkDir()
	cmd.Env = append(os.Environ(), "PLAYWRIGHT_BROWSERS_PATH="+r.BrowsersPath())
	out, err := cmd.CombinedOutput()
	if err != nil || !strings.Contains(string(out), "cqs-ok") {
		t.Fatalf("Chromium không mở được từ bố cục Go: %v\n%s", err, out)
	}
	if st := r.Status(); st.Node.State != StateReady || st.Modules.State != StateReady || st.Browsers[0].State != StateReady {
		t.Fatalf("status sau khi cài: %+v", st)
	}
}
