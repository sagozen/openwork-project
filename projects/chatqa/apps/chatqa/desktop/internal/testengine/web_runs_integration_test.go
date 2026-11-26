//go:build pwintegration

package testengine

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image/jpeg"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"chatqa/internal/proc"
	"chatqa/internal/pw"
	"deskcore/apperr"
)

// Lượt chạy flow web với Node + Playwright + Chromium thật, qua đúng đường của app (Engine.Run, kiểm tra spec bằng sidecar,
// pw.Runner, fixture ./chatqa, reporter):
//
//	go test -tags pwintegration ./internal/testengine/ -run WebRun -count=1 -timeout 20m
//
// Máy chủ được phép nghe ở localhost; máy chủ lạ đếm mọi kết nối, gọi bằng 127.0.0.1 (khác host).

const sitePage = `<!doctype html><meta charset=utf-8><title>Đăng nhập</title>
<label>Tên <input id=u></label><label>Mật khẩu <input id=p type=password></label>
<button onclick="document.getElementById('o').textContent='Xin chào '+document.getElementById('u').value">Đăng nhập</button>
<p id=o></p>`

type webSite struct {
	allowed   *httptest.Server
	off       *httptest.Server
	offAccept atomic.Int32
	offHits   atomic.Int32
}

type countConns struct {
	net.Listener
	n *atomic.Int32
}

func (l countConns) Accept() (net.Conn, error) {
	c, err := l.Listener.Accept()
	if err == nil {
		l.n.Add(1)
	}
	return c, err
}

func newWebSite(t *testing.T) *webSite {
	t.Helper()
	s := &webSite{}
	s.off = httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		s.offHits.Add(1)
		fmt.Fprint(w, "off-host")
	}))
	s.off.Listener = countConns{s.off.Listener, &s.offAccept}
	s.off.Start()
	t.Cleanup(s.off.Close)
	offURL := strings.Replace(s.off.URL, "localhost", "127.0.0.1", 1)
	s.allowed = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/login":
			fmt.Fprint(w, sitePage)
		case "/slow":
			fmt.Fprint(w, `<!doctype html><meta charset=utf-8><p id=s>chờ</p><script>setTimeout(()=>{document.getElementById('s').textContent='Xong'}, 3000)</script>`)
		case "/hang":
			fmt.Fprint(w, `<!doctype html><meta charset=utf-8><p>chờ mãi</p>`)
		case "/redirect":
			http.Redirect(w, r, offURL+"/steal?x=1", http.StatusFound)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(s.allowed.Close)
	return s
}

func (s *webSite) baseURL() string {
	return strings.Replace(s.allowed.URL, "127.0.0.1", "localhost", 1)
}

func (s *webSite) offURL() string { return strings.Replace(s.off.URL, "localhost", "127.0.0.1", 1) }

// realWebEngine: engine thử với bộ chạy thật, sidecar thật (kiểm tra spec) và hồ sơ chromium headless tới site.
func realWebEngine(t *testing.T, site *webSite, ids ...string) (*Engine, *pw.Runtime, []Device) {
	t.Helper()
	rt := realWebRuntime(t)
	if err := rt.Ready("chromium", ""); err != nil {
		t.Skipf("bộ chạy chưa đủ: %v", err)
	}
	e, _ := newTestEngine(t)
	sc := &pw.Sidecar{RT: rt, Log: t.Logf}
	sc.OnDown = func(gen int) { e.WebDown(gen) }
	profiles := map[string]pw.Profile{}
	var devs []Device
	for _, id := range ids {
		p := pw.Profile{ID: id, Name: id, Browser: "chromium", Width: 800, Height: 600, BaseURL: site.baseURL(), Headless: true}
		if err := p.Validate(); err != nil {
			t.Fatal(err)
		}
		profiles[id] = p
		devs = append(devs, Device{ID: id, Platform: PlatformWeb, Driver: DriverPlaywright, Rev: p.Fingerprint()})
	}
	e.Web = &Web{RT: rt, Sidecar: sc, Profile: func(id string) (pw.Profile, error) {
		p, ok := profiles[id]
		if !ok {
			return pw.Profile{}, apperr.New(apperr.CodeNotFound, id)
		}
		return p, nil
	}}
	e.Pool.OpenWeb = e.OpenWeb
	t.Cleanup(func() {
		e.Pool.CloseAll(3 * time.Second)
		_ = sc.Close()
	})
	return e, rt, devs
}

func writeSpecFile(t *testing.T, e *Engine, name, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(e.Flows.Root, "demo", name), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

const passSpec = `import { test, expect, step } from './chatqa';

test('đăng nhập', async ({ page }) => {
  await step('mở trang', async () => {
    await page.goto('/login');
  });
  await step('điền và gửi', async () => {
    await page.getByLabel('Tên').fill(process.env.USER_NAME);
    await page.getByLabel('Mật khẩu').fill(process.env.PASSWORD);
    await page.getByRole('button', { name: 'Đăng nhập' }).click();
  });
  await step('kiểm tra', async () => {
    await expect(page.getByText('Xin chào alice')).toBeVisible();
  });
});
`

const failSpec = `import { test, expect, step } from './chatqa';

test('trang chủ', async ({ page }) => {
  await step('mở trang', async () => {
    await page.goto('/login');
  });
  await step('thấy trang chủ', async () => {
    await expect(page.getByText('Trang chủ')).toBeVisible({ timeout: 1500 });
  });
});
`

const slowSpec = `import { test, expect, step } from './chatqa';

test('chờ', async ({ page }) => {
  await step('mở trang chậm', async () => {
    await page.goto('/slow');
  });
  await step('đợi xong', async () => {
    await expect(page.getByText('Xong')).toBeVisible({ timeout: 8000 });
  });
});
`

const hangSpec = `import { test, expect, step } from './chatqa';

test('treo', async ({ page }) => {
  await step('mở trang', async () => {
    await page.goto('/hang');
  });
  await step('đợi mãi', async () => {
    await expect(page.getByText('không bao giờ')).toBeVisible({ timeout: 60000 });
  });
});
`

func TestWebRunRealPassFailEvidenceTraceAndExport(t *testing.T) {
	site := newWebSite(t)
	e, rt, devs := realWebEngine(t, site, "web-it")
	writeSpecFile(t, e, "pass.spec.ts", passSpec)
	writeSpecFile(t, e, "fail.spec.ts", failSpec)
	start := time.Now()
	sum, err := e.Run(context.Background(), RunRequest{App: "demo", Flows: []string{"pass.spec.ts", "fail.spec.ts"}, Devices: devs,
		Env: map[string]string{"USER_NAME": "alice"}, Secrets: []string{"PASSWORD"}, Artifacts: ArtifactsAlways, Record: "on-failure"})
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("hai spec mất %v", time.Since(start))
	byFlow := map[string]FlowRun{}
	for _, f := range sum.Flows {
		byFlow[f.Flow] = f
	}
	pass, fail := byFlow["pass.spec.ts"], byFlow["fail.spec.ts"]
	if !pass.Passed || pass.Platform != PlatformWeb || len(pass.Steps) < 6 {
		t.Fatalf("spec đạt = %+v", pass)
	}
	for _, s := range pass.Steps {
		if strings.Contains(s.Desc, secretPassword) {
			t.Fatalf("bước lộ bí mật: %s", s.Desc)
		}
		if s.Depth == 0 && (s.ShotBefore == "" || s.ShotAfter == "") {
			t.Fatalf("bước thiếu ảnh trước/sau: %+v", s)
		}
	}
	if fail.Passed || fail.FailureClass != FailProduct || !strings.Contains(fail.Error, "toBeVisible") {
		t.Fatalf("spec lỗi = %+v", fail)
	}
	if fail.Video == "" || fail.Trace == "" {
		t.Fatalf("spec lỗi phải có video (on-failure) và trace: video %q trace %q", fail.Video, fail.Trace)
	}
	if st, err := os.Stat(fail.Trace); err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("trace 0600: %v %v", st, err)
	}
	if pass.Trace != "" {
		t.Fatal("spec đạt không giữ trace")
	}
	failed := fail.Steps[len(fail.Steps)-1]
	for _, s := range fail.Steps {
		if s.Depth == 0 && !s.Passed {
			failed = s
		}
	}
	if failed.ShotAfter == "" || failed.Hierarchy == "" {
		t.Fatalf("bước lỗi thiếu ảnh lỗi hoặc aria snapshot: %+v", failed)
	}
	rows, err := e.Metrics.FlowRuns(sum.Run.ID)
	if err != nil || len(rows) != 2 || rows[0].Platform != PlatformWeb || rows[0].Driver != DriverPlaywright {
		t.Fatalf("flow_runs = %+v, %v", rows, err)
	}
	if _, err := os.Stat(filepath.Join(sum.Run.OutDir, ReportSummaryFile)); err != nil {
		t.Fatal(err)
	}
	dest := filepath.Join(e.ExportsDir, "web.zip")
	if err := e.ExportRun(sum.Run.ID, dest); err != nil {
		t.Fatal(err)
	}
	for name := range readZip(t, dest) {
		if strings.HasSuffix(name, ".zip") {
			t.Fatalf("gói xuất chứa trace: %s", name)
		}
	}
	_ = filepath.WalkDir(sum.Run.OutDir, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || skipRedact(p) {
			return err
		}
		if b, _ := os.ReadFile(p); bytes.Contains(b, []byte(secretPassword)) {
			t.Errorf("bí mật còn trong %s", p)
		}
		return nil
	})
	if entries, _ := os.ReadDir(filepath.Join(pw.RunsDir(rt), sum.Run.ID)); len(entries) != 0 {
		t.Fatalf("thư mục làm việc của lượt còn sót: %v", entries)
	}
}

func waitFrame(t *testing.T, e *Engine, dev Device) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		var shot []byte
		busy, err := e.Pool.Peek(context.Background(), dev, false, func(d DeviceDriver) error {
			var err error
			shot, err = d.Screenshot()
			return err
		})
		if err == nil && busy && len(shot) > 0 {
			if _, err := jpeg.Decode(bytes.NewReader(shot)); err != nil {
				t.Fatalf("khung hình live không phải JPEG: %v", err)
			}
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("%s: live view không có khung hình của lượt", dev.ID)
}

// Hai hồ sơ chạy song song; hồ sơ đã có phiên ấm trước lượt vẫn hiện đúng trang của lượt trong live view.
func TestWebRunTwoProfilesParallelWithLiveFrames(t *testing.T) {
	site := newWebSite(t)
	e, _, devs := realWebEngine(t, site, "web-a", "web-b")
	writeSpecFile(t, e, "slow.spec.ts", slowSpec)
	if err := e.Pool.Run(context.Background(), devs[0], func(context.Context, Session) error { return nil }); err != nil {
		t.Fatalf("mở phiên ấm: %v", err)
	}
	done := make(chan *RunSummary, 1)
	go func() {
		sum, err := e.Run(context.Background(), RunRequest{App: "demo", Flows: []string{"slow.spec.ts"}, Devices: devs})
		if err != nil {
			t.Error(err)
		}
		done <- sum
	}()
	waitFrame(t, e, devs[0])
	waitFrame(t, e, devs[1])
	sum := <-done
	if len(sum.Flows) != 2 || !sum.Flows[0].Passed || !sum.Flows[1].Passed {
		t.Fatalf("flows = %+v", sum.Flows)
	}
	wall := sum.Run.FinishedAt.Sub(sum.Run.StartedAt)
	if serial := time.Duration(sum.Flows[0].DurationMs+sum.Flows[1].DurationMs) * time.Millisecond; wall >= serial+4*time.Second {
		t.Fatalf("hai hồ sơ không chạy song song: cả lượt %v, cộng hai flow %v", wall, serial)
	}
}

// pidsOf đọc pids.json của bộ chạy.
func pidsOf(t *testing.T, rt *pw.Runtime) []proc.Record {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(rt.Dir, "pids.json"))
	if err != nil {
		return nil
	}
	var recs []proc.Record
	_ = json.Unmarshal(b, &recs)
	return recs
}

func waitPIDs(t *testing.T, rt *pw.Runtime, n int) []proc.Record {
	t.Helper()
	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		if recs := pidsOf(t, rt); len(recs) >= n {
			return recs
		}
		time.Sleep(200 * time.Millisecond)
	}
	t.Fatalf("pids.json không có đủ %d tiến trình: %v", n, pidsOf(t, rt))
	return nil
}

func assertAllDead(t *testing.T, recs []proc.Record, within time.Duration) {
	t.Helper()
	deadline := time.Now().Add(within)
	for {
		var alive []int
		for _, r := range recs {
			if syscall.Kill(r.PID, 0) == nil {
				alive = append(alive, r.PID)
			}
		}
		if len(alive) == 0 {
			return
		}
		if time.Now().After(deadline) {
			for _, p := range alive {
				_ = syscall.Kill(p, syscall.SIGKILL)
			}
			t.Fatalf("còn tiến trình sống sau %v: %v", within, alive)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// Esc giữa lượt: mọi thiết bị được nhả dưới 3 giây và không tiến trình node/trình duyệt nào sống sót.
func TestWebRunEscStopsFastAndLeavesNoProcesses(t *testing.T) {
	site := newWebSite(t)
	e, rt, devs := realWebEngine(t, site, "web-esc")
	writeSpecFile(t, e, "hang.spec.ts", hangSpec)
	done := make(chan *RunSummary, 1)
	go func() {
		sum, _ := e.Run(context.Background(), RunRequest{App: "demo", Flows: []string{"hang.spec.ts"}, Devices: devs})
		done <- sum
	}()
	waitFrame(t, e, devs[0])
	recs := waitPIDs(t, rt, 4) // sidecar, bộ chạy test, worker, trình duyệt
	start := time.Now()
	e.StopAll(3 * time.Second)
	if d := time.Since(start); d > 3*time.Second {
		t.Fatalf("Esc mất %v", d)
	}
	sum := <-done
	if len(sum.Flows) != 1 || sum.Flows[0].Error != userStopError {
		t.Fatalf("sau Esc: %+v", sum.Flows)
	}
	if h := health(e.Pool, devs[0].ID); h == HealthBusy {
		t.Fatal("thiết bị còn bận sau Esc")
	}
	_ = e.Web.Sidecar.Close()
	assertAllDead(t, recs, 5*time.Second)
}

func TestWebRunOffHostGotoRejectedBeforeRun(t *testing.T) {
	site := newWebSite(t)
	e, _, devs := realWebEngine(t, site, "web-v")
	writeSpecFile(t, e, "off.spec.ts", "import { test, step } from './chatqa';\n\ntest('lạ', async ({ page }) => {\n  await step('đi', async () => {\n    await page.goto('"+site.offURL()+"/x');\n  });\n});\n")
	err := e.CheckRun(RunRequest{App: "demo", Flows: []string{"off.spec.ts"}, Devices: devs})
	fe, ok := err.(FlowErrors)
	if !ok || fe[0].File != "off.spec.ts" || fe[0].Line != 5 {
		t.Fatalf("goto tới host lạ phải bị bộ kiểm tra chặn kèm dòng: %v", err)
	}
	if site.offAccept.Load() != 0 {
		t.Fatal("máy chủ lạ nhận kết nối")
	}
}

func TestWebRunRedirectToOffHostIsBlocked(t *testing.T) {
	site := newWebSite(t)
	e, _, devs := realWebEngine(t, site, "web-r")
	writeSpecFile(t, e, "redirect.spec.ts", "import { test, step } from './chatqa';\n\ntest('chuyển hướng', async ({ page }) => {\n  await step('đi', async () => {\n    await page.goto('/redirect');\n  });\n});\n")
	sum, err := e.Run(context.Background(), RunRequest{App: "demo", Flows: []string{"redirect.spec.ts"}, Devices: devs})
	if err != nil {
		t.Fatal(err)
	}
	fr := sum.Flows[0]
	if fr.Passed || fr.FailureClass != FailEnvironment {
		t.Fatalf("chuyển hướng ra host lạ = %+v", fr)
	}
	t.Logf("lỗi: %s", fr.Error)
	if n := site.offAccept.Load(); n != 0 {
		t.Fatalf("máy chủ lạ nhận %d kết nối", n)
	}
}

// Biến người dùng chỉ vào tiến trình dưới CQS_VAR_*, fixture chép lại thành tên thật; tên dành riêng không bao giờ tới.
func TestWebRunUserVarsReachSpecOnlyThroughFixture(t *testing.T) {
	site := newWebSite(t)
	e, _, devs := realWebEngine(t, site, "web-env")
	writeSpecFile(t, e, "env.spec.ts", passSpec)
	if _, err := e.Run(context.Background(), RunRequest{App: "demo", Flows: []string{"env.spec.ts"}, Devices: devs,
		Env: map[string]string{"NODE_OPTIONS": "--require /x.js", "USER_NAME": "alice"}}); apperr.CodeOf(err) != apperr.CodeInvalid {
		t.Fatalf("NODE_OPTIONS trong env của lượt: %v", err)
	}
	sum, err := e.Run(context.Background(), RunRequest{App: "demo", Flows: []string{"env.spec.ts"}, Devices: devs,
		Env: map[string]string{"USER_NAME": "alice"}, Secrets: []string{"PASSWORD"}})
	if err != nil {
		t.Fatal(err)
	}
	if !sum.Flows[0].Passed {
		t.Fatalf("spec dùng process.env.USER_NAME phải thấy giá trị qua fixture: %+v", sum.Flows[0])
	}
}

// App bị kill -9 giữa lượt: sau 5 giây không còn tiến trình node hay trình duyệt nào (bootstrap thấy stdin đóng và
// dừng cả nhóm, Playwright đóng trình duyệt). Tiến trình con là chính binary test chạy TestWebRunKill9Child.
func TestWebRunKill9OfAppLeavesNoOrphans(t *testing.T) {
	if os.Getenv("CQS_KILL9_CHILD") != "" {
		t.Skip("đang là tiến trình con")
	}
	site := newWebSite(t)
	rt := realWebRuntime(t)
	if err := rt.Ready("chromium", ""); err != nil {
		t.Skipf("bộ chạy chưa đủ: %v", err)
	}
	cmd := exec.Command(os.Args[0], "-test.run", "^TestWebRunKill9Child$", "-test.v", "-test.timeout", "5m")
	cmd.Env = append(os.Environ(), "CQS_KILL9_CHILD=1", "CQS_PW_DIR="+rt.Dir, "CQS_KILL9_SITE="+site.allowed.URL)
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
	recs := waitPIDs(t, rt, 4)
	time.Sleep(time.Second) // để trình duyệt kịp mở hẳn và được ghi
	recs = pidsOf(t, rt)
	if err := cmd.Process.Signal(syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
	_ = cmd.Wait()
	t.Logf("đã kill -9 app giả; theo dõi %d tiến trình", len(recs))
	assertAllDead(t, recs, 5*time.Second)
}

func TestWebRunKill9Child(t *testing.T) {
	if os.Getenv("CQS_KILL9_CHILD") == "" {
		t.Skip("chỉ chạy làm tiến trình con")
	}
	u, err := url.Parse(os.Getenv("CQS_KILL9_SITE"))
	if err != nil {
		t.Fatal(err)
	}
	site := &webSite{allowed: &httptest.Server{URL: u.String()}}
	e, _, devs := realWebEngine(t, site, "web-k9")
	writeSpecFile(t, e, "hang.spec.ts", hangSpec)
	_, _ = e.Run(context.Background(), RunRequest{App: "demo", Flows: []string{"hang.spec.ts"}, Devices: devs})
}
