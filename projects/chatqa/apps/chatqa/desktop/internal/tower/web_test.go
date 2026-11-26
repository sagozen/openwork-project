package tower

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/devicelab-dev/maestro-runner/pkg/core"
	"github.com/devicelab-dev/maestro-runner/pkg/driver/mock"

	"chatqa/internal/pw"
	"chatqa/internal/testengine"
	"chatqa/internal/tower/pool"
	"deskcore/apperr"
)

func TestStoreMigratesV1ToV2KeepingData(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tower.db")
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(path))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(migrations[0] + `;
INSERT INTO settings VALUES ('ios.team_id', 'ABCDE12345');
PRAGMA user_version = 1;`); err != nil {
		t.Fatal(err)
	}
	db.Close()

	s, err := OpenStore(path)
	if err != nil {
		t.Fatalf("nâng v1 lên v2: %v", err)
	}
	defer s.Close()
	var v int
	if err := s.db.QueryRow(`PRAGMA user_version`).Scan(&v); err != nil || v != 2 {
		t.Fatalf("user_version = %d, %v", v, err)
	}
	if s.TeamID() != "ABCDE12345" {
		t.Fatal("dữ liệu v1 mất sau khi nâng")
	}
	if ps, err := s.BrowserProfiles(); err != nil || len(ps) != 0 {
		t.Fatalf("browser_profiles = %v, %v", ps, err)
	}
	s.Close()
	again, err := OpenStore(path) // mở lại: không chạy bước nào nữa
	if err != nil {
		t.Fatal(err)
	}
	again.Close()
}

func TestStoreBrowserProfileCRUD(t *testing.T) {
	s, err := OpenStore(filepath.Join(t.TempDir(), "tower.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if _, err := s.SaveBrowserProfile(pw.Profile{ID: "bad id"}, time.Now()); apperr.CodeOf(err) != apperr.CodeInvalid {
		t.Fatalf("hồ sơ sai: %v", err)
	}
	p := webProfile()
	p.AllowedHosts = []string{" API.Example.com ", "*.vercel.app"}
	if _, err := s.SaveBrowserProfile(p, time.Now()); apperr.CodeOf(err) != apperr.CodeInvalid {
		t.Fatalf("wildcard trên hậu tố công cộng phải bị từ chối: %v", err)
	}
	p.AllowedHosts = []string{" API.Example.com "}
	saved, err := s.SaveBrowserProfile(p, time.Now())
	if err != nil || saved.TestIDAttribute != pw.DefaultTestIDAttribute || saved.AllowedHosts[0] != "api.example.com" {
		t.Fatalf("lưu = %+v, %v", saved, err)
	}
	saved.Name = "Staging 2"
	if _, err := s.SaveBrowserProfile(saved, time.Now()); err != nil {
		t.Fatal(err)
	}
	got, err := s.BrowserProfile(p.ID)
	if err != nil || got.Name != "Staging 2" {
		t.Fatalf("đọc = %+v, %v", got, err)
	}
	if all, _ := s.BrowserProfiles(); len(all) != 1 {
		t.Fatalf("danh sách = %d hồ sơ", len(all))
	}
	if err := s.DeleteBrowserProfile(p.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteBrowserProfile(p.ID); apperr.CodeOf(err) != apperr.CodeNotFound {
		t.Fatalf("xoá lần hai: %v", err)
	}
	if _, err := s.BrowserProfile(p.ID); apperr.CodeOf(err) != apperr.CodeNotFound {
		t.Fatalf("đọc hồ sơ đã xoá: %v", err)
	}
}

func webProfile() pw.Profile {
	return pw.Profile{ID: "web-staging", Name: "Staging", Browser: "chromium", Width: 1280, Height: 800,
		BaseURL: "https://staging.example.com", Headless: true}
}

// readyWebRuntime: bố cục bộ chạy đã cài (darwin/arm64, chromium) trong thư mục tạm, không có tiến trình nào.
func readyWebRuntime(t *testing.T) *pw.Runtime {
	t.Helper()
	dir := t.TempDir()
	pins := pw.DefaultPins
	nodeDir, modDir := "node-"+pins.Node, "modules-"+pins.Playwright+"-"+pins.TypeScript
	for name, body := range map[string]string{
		filepath.Join(nodeDir, "bin", "node"):                                                           "",
		filepath.Join(modDir, "node_modules", "@playwright", "test", "cli.js"):                          "",
		filepath.Join(modDir, "node_modules", "typescript", "package.json"):                             "{}",
		filepath.Join("browsers", pins.Artifacts["darwin/arm64/chromium"].Dir, "INSTALLATION_COMPLETE"): "",
		"current.json": fmt.Sprintf(`{"node":%q,"modules":%q}`, nodeDir, modDir),
	} {
		p := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return &pw.Runtime{Dir: dir, Platform: "darwin/arm64"}
}

// fakeWebDriver: trình duyệt giả cho đường chạy của engine (driver Maestro mock), không có Node.
type fakeWebDriver struct{ core.Driver }

func (fakeWebDriver) Tap(context.Context, float64, float64) error { return nil }
func (fakeWebDriver) Swipe(context.Context, float64, float64, float64, float64, int) error {
	return nil
}
func (d fakeWebDriver) Maestro() core.Driver { return d.Driver }

// webRig: rig có hồ sơ trình duyệt là thiết bị (kho tower thật, bộ chạy đã cài giả, phiên trình duyệt giả).
func webRig(t *testing.T) *rig {
	t.Helper()
	r := newRig(t)
	e := r.t.Engine
	e.Web = &testengine.Web{RT: readyWebRuntime(t), Profile: r.t.Store.BrowserProfile}
	e.Pool.OpenWeb = func(_ context.Context, dev testengine.Device) (testengine.DeviceDriver, func(), error) {
		return fakeWebDriver{mock.New(mock.Config{Platform: "android", DeviceID: dev.ID})}, func() {
			r.mu.Lock()
			r.cleaned[dev.ID]++
			r.mu.Unlock()
		}, nil
	}
	r.t.Local.Profiles, r.t.Local.WebReady = r.t.Store, e.WebReady
	return r
}

func TestSaveProfileRefreshesFleetAndRevAtOnce(t *testing.T) {
	r := webRig(t)
	ctx := context.Background()
	p := webProfile()
	if _, err := r.t.SaveProfile(ctx, p); err != nil {
		t.Fatal(err)
	}
	d, err := r.t.Pool.Device(ctx, p.ID)
	if err != nil || d.State != pool.Connected || d.Platform != testengine.PlatformWeb {
		t.Fatalf("sau khi lưu: %+v, %v", d, err)
	}
	p.Width, p.Height = 390, 844
	if _, err := r.t.SaveProfile(ctx, p); err != nil {
		t.Fatal(err)
	}
	saved, _ := r.t.Store.BrowserProfile(p.ID)
	if ed, err := r.t.Pool.EngineDevice(p.ID); err != nil || ed.Rev != saved.Fingerprint() {
		t.Fatalf("EngineDevice ngay sau khi sửa = %+v, %v (muốn Rev %s)", ed, err, saved.Fingerprint())
	}
}

func TestDeleteProfileDuringRunReturnsFastAndCancels(t *testing.T) {
	r := webRig(t)
	ctx := context.Background()
	p := webProfile()
	if _, err := r.t.SaveProfile(ctx, p); err != nil {
		t.Fatal(err)
	}
	ed, err := r.t.Pool.EngineDevice(p.ID)
	if err != nil {
		t.Fatal(err)
	}
	// Phiên ấm có từ trước: lượt web bỏ nó khi giữ khoá (đóng đúng một lần), rồi chạy spec trong tiến trình riêng.
	if err := r.t.Engine.Pool.Run(ctx, ed, func(context.Context, testengine.Session) error { return nil }); err != nil {
		t.Fatal(err)
	}
	writeSpec(t, r, "login.spec.ts")
	r.t.Engine.Flows.Specs = okSpecs{}
	started := make(chan string, 2)
	r.t.Engine.SpecRunner = blockingRunner{started}
	done := make(chan *testengine.RunSummary, 1)
	go func() {
		sum, err := r.t.Engine.Run(ctx, testengine.RunRequest{App: "demo", Flows: []string{"login.spec.ts"}, Devices: []testengine.Device{ed}})
		if err != nil {
			t.Error(err)
		}
		done <- sum
	}()
	<-started

	if err := r.t.InstallWebRuntime(nil); apperr.CodeOf(err) != testengine.CodeDeviceNotReady {
		t.Fatalf("cài bộ chạy giữa lượt chạy web: %v", err)
	}

	start := time.Now()
	if err := r.t.DeleteProfile(ctx, p.ID); err != nil {
		t.Fatal(err)
	}
	if d := time.Since(start); d > time.Second {
		t.Fatalf("xoá hồ sơ mất %v khi lượt chạy đang chạy", d)
	}
	select {
	case sum := <-done:
		if sum == nil || len(sum.Flows) != 1 || sum.Flows[0].Passed || sum.Flows[0].FailureClass != testengine.FailEnvironment {
			t.Fatalf("lượt chạy sau khi xoá hồ sơ: %+v", sum)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("lượt chạy không bị huỷ")
	}
	d, _ := r.t.Pool.Device(ctx, p.ID)
	if d.State != pool.Disconnected {
		t.Fatalf("hồ sơ đã xoá: %+v", d)
	}
	if r.cleanups(p.ID) != 1 {
		t.Fatalf("phiên trình duyệt phải được đóng (cleaned=%d)", r.cleanups(p.ID))
	}
}

const webSpec = `import { test, expect, step } from './chatqa';
test('đăng nhập', async ({ page }) => {
  await step('mở trang', async () => {
    await page.goto('/login');
  });
});
`

func writeSpec(t *testing.T, r *rig, name string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(r.dir, "flows", "demo", name), []byte(webSpec), 0o644); err != nil {
		t.Fatal(err)
	}
}

// okSpecs: bộ kiểm tra an toàn giả, mọi spec đạt (bộ thật chạy trong sidecar Node).
type okSpecs struct{}

func (okSpecs) Ready() error                      { return nil }
func (okSpecs) Scope(string) ([]string, []string) { return nil, nil }
func (okSpecs) ValidateSpec(context.Context, []byte, []string, []string) (testengine.SpecCheck, error) {
	return testengine.SpecCheck{}, nil
}

// blockingRunner: lượt playwright test giả chạy tới khi bị huỷ.
type blockingRunner struct{ started chan<- string }

func (b blockingRunner) Run(ctx context.Context, job pw.Job, _ func(pw.Event)) (pw.Result, error) {
	b.started <- job.Profile.ID
	<-ctx.Done()
	return pw.Result{Killed: true}, nil
}

func TestWebDownHandsBackHeldWebDevice(t *testing.T) {
	r := webRig(t)
	ctx := context.Background()
	p := webProfile()
	if _, err := r.t.SaveProfile(ctx, p); err != nil {
		t.Fatal(err)
	}
	if _, err := r.t.TakeOver(ctx, actor, p.ID); err != nil {
		t.Fatal(err)
	}
	r.t.WebDown(1)
	if s := r.t.Engine.HoldState(p.ID); s != testengine.HoldNone {
		t.Fatalf("máy web vẫn bị giữ: %q", s)
	}
	events, _ := r.t.Store.Events(time.Time{}, 20)
	found := false
	for _, e := range events {
		found = found || (e.Kind == "hand_back" && e.DeviceID == p.ID && e.Detail == webDownDetail)
	}
	if !found {
		t.Fatalf("thiếu sự kiện trả máy: %+v", events)
	}
}

func TestInstallWebRuntimeValidatesBrowsers(t *testing.T) {
	r := webRig(t)
	if err := r.t.InstallWebRuntime([]string{"msedge"}); apperr.CodeOf(err) != apperr.CodeInvalid {
		t.Fatalf("msedge là kênh có sẵn, không tải: %v", err)
	}
	r.t.Engine.Web = nil
	if _, err := r.t.WebRuntime(); apperr.CodeOf(err) != pw.CodeRuntimeMissing {
		t.Fatalf("không có bộ chạy: %v", err)
	}
}
