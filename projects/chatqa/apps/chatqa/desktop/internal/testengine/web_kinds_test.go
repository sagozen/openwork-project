package testengine

import (
	"context"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"chatqa/internal/pw"
	"deskcore/apperr"
)

const loginSpec = `import { test, expect, step } from './chatqa';

test('đăng nhập web', async ({ page }) => {
  await step('mở trang', async () => {
    await page.goto('/login');
  });
  await step('điền mật khẩu', async () => {
    await page.getByLabel('Mật khẩu').fill(process.env.PASSWORD);
  });
});
`

var envRefRe = regexp.MustCompile(`process\.env\.([A-Z_][A-Z0-9_]*)`)

// stubSpecs: bộ kiểm tra an toàn giả cho test Go (bộ thật chạy trong sidecar, kiểm tra bằng node --test): báo
// process.env.TÊN dùng trong spec, và lỗi có dòng khi TÊN không nằm trong envNames hoặc spec có chữ "evaluate".
type stubSpecs struct {
	ready error
	mu    sync.Mutex
	hosts [][]string
	names [][]string
}

func (s *stubSpecs) Ready() error { return s.ready }

func (s *stubSpecs) Scope(string) ([]string, []string) {
	return []string{"PASSWORD"}, []string{"app.test"}
}

func (s *stubSpecs) ValidateSpec(_ context.Context, src []byte, envNames, hosts []string) (SpecCheck, error) {
	s.mu.Lock()
	s.hosts = append(s.hosts, hosts)
	s.names = append(s.names, envNames)
	s.mu.Unlock()
	var chk SpecCheck
	declared := map[string]bool{}
	for _, n := range envNames {
		declared[n] = true
	}
	for i, line := range strings.Split(string(src), "\n") {
		if strings.Contains(line, "evaluate") {
			chk.Errors = append(chk.Errors, SpecIssue{Line: i + 1, Col: 1, Message: "page.evaluate không được phép"})
		}
		for _, m := range envRefRe.FindAllStringSubmatch(line, -1) {
			if !declared[m[1]] {
				chk.Errors = append(chk.Errors, SpecIssue{Line: i + 1, Col: 1, Message: "biến " + m[1] + " chưa khai báo"})
				continue
			}
			chk.EnvUsed = append(chk.EnvUsed, m[1])
		}
	}
	return chk, nil
}

// mixedApp: app demo có 01_login.yaml (từ newTestEngine) và login.spec.ts.
func mixedApp(t *testing.T, e *Engine) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(e.Flows.Root, "demo", "login.spec.ts"), []byte(loginSpec), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestIsSpecName(t *testing.T) {
	for name, want := range map[string]bool{"login.spec.ts": true, "a.spec.TS": true, "A.SPEC.ts": true, "chatqa.ts": false,
		"a.ts": false, "a.yaml": false, "spec.ts": false, "a.spec.ts.bak": false} {
		if IsSpecName(name) != want {
			t.Errorf("IsSpecName(%q) = %v", name, !want)
		}
	}
	if isFlowName("login.spec.ts") || !isRunnableName("login.spec.ts") || isRunnableName("chatqa.ts") {
		t.Fatal("isFlowName chỉ nhận YAML; isRunnableName nhận YAML và spec")
	}
}

func TestSpecListSaveMarkSavedGiveFreshHash(t *testing.T) {
	e, _ := newTestEngine(t)
	info, err := e.Flows.Save("demo", "login.spec.ts", []byte(loginSpec), "src-1")
	if err != nil {
		t.Fatal(err)
	}
	if info.Hash == "" || info.Stale || info.Title != "đăng nhập web" || len(info.Deps) != 0 || info.SourceHash != "src-1" {
		t.Fatalf("Save = %+v", info)
	}
	list, err := e.Flows.List("demo")
	if err != nil || len(list) != 2 || list[1].Name != "login.spec.ts" || list[1].Stale || list[1].Hash != info.Hash {
		t.Fatalf("List = %+v, %v", list, err)
	}
	// Sửa tay ngoài app: cũ cho tới khi xác nhận lại.
	if err := os.WriteFile(filepath.Join(e.Flows.Root, "demo", "login.spec.ts"), []byte(loginSpec+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if list, _ = e.Flows.List("demo"); !list[1].Stale {
		t.Fatal("spec đổi nội dung phải hiện cũ")
	}
	if info, err = e.Flows.MarkSaved("demo", "login.spec.ts", ""); err != nil || info.Stale {
		t.Fatalf("MarkSaved = %+v, %v", info, err)
	}
	// Kiểm tra rẻ khi lưu: quá cỡ và không phải UTF-8 bị từ chối; chatqa.ts không phải flow.
	if _, err := e.Flows.Save("demo", "big.spec.ts", []byte(strings.Repeat("a", maxSpecFile+1)), ""); err == nil {
		t.Fatal("spec quá cỡ phải bị từ chối")
	}
	if _, err := e.Flows.Save("demo", "bin.spec.ts", []byte{0xff, 0xfe}, ""); err == nil {
		t.Fatal("spec không phải UTF-8 phải bị từ chối")
	}
	if _, err := e.Flows.Save("demo", "chatqa.ts", []byte("x"), ""); apperr.CodeOf(err) != apperr.CodeInvalid {
		t.Fatalf("chatqa.ts không phải flow: %v", err)
	}
	if err := e.Flows.Delete("demo", "login.spec.ts"); err != nil {
		t.Fatal(err)
	}
}

func TestLoadIsYAMLOnly(t *testing.T) {
	e, _ := newTestEngine(t)
	mixedApp(t, e)
	flows, err := e.Flows.Load("demo")
	if err != nil || len(flows) != 1 || !strings.HasSuffix(flows[0].SourcePath, "01_login.yaml") {
		t.Fatalf("Load trống trên app có cả spec = %d flow, %v", len(flows), err)
	}
	if _, err := e.Flows.Load("demo", "login.spec.ts"); apperr.CodeOf(err) != apperr.CodeInvalid {
		t.Fatalf("Load gọi tên spec: %v", err)
	}
	if err := e.Flows.ValidateYAML("demo", "x.spec.ts", []byte(loginSpec)); apperr.CodeOf(err) != apperr.CodeInvalid {
		t.Fatalf("ValidateYAML với spec: %v", err)
	}
}

func TestKindsAndLoadSetByDeviceKinds(t *testing.T) {
	e, _ := newTestEngine(t)
	mixedApp(t, e)
	k, err := e.Flows.Kinds("demo", nil)
	if err != nil || !k[KindMobile] || !k[KindWeb] {
		t.Fatalf("Kinds(mọi flow) = %v, %v", k, err)
	}
	if k, _ = e.Flows.Kinds("demo", []string{"login.spec.ts"}); k[KindMobile] || !k[KindWeb] {
		t.Fatalf("Kinds(spec) = %v", k)
	}
	if _, err := e.Flows.Kinds("demo", []string{"../x.yaml"}); apperr.CodeOf(err) != apperr.CodeInvalid {
		t.Fatalf("tên sai: %v", err)
	}
	// Chỉ điện thoại: trống chỉ mở rộng ra YAML, spec không bao giờ được đọc hay kiểm tra.
	set, err := e.Flows.LoadSet("demo", nil, Kinds{KindMobile: true})
	if err != nil || len(set.YAML) != 1 || len(set.Specs) != 0 || len(set.Orphans) != 0 {
		t.Fatalf("LoadSet mobile = %+v, %v", set, err)
	}
	set, err = e.Flows.LoadSet("demo", []string{"01_login.yaml", "login.spec.ts"}, Kinds{KindMobile: true})
	if err != nil || len(set.YAML) != 1 || len(set.Orphans) != 1 || set.Orphans[0] != "login.spec.ts" {
		t.Fatalf("spec gọi tên mà không có máy web phải vào Orphans: %+v, %v", set, err)
	}
	set, err = e.Flows.LoadSet("demo", nil, Kinds{KindWeb: true})
	if err != nil || len(set.YAML) != 0 || len(set.Specs) != 1 || set.Specs[0].Title != "đăng nhập web" {
		t.Fatalf("LoadSet web = %+v, %v", set, err)
	}
	if _, err := e.Flows.LoadSet("demo", nil, Kinds{}); apperr.CodeOf(err) != apperr.CodeNotFound {
		t.Fatalf("không loại nào: %v", err)
	}
}

// Hồi quy: Web == nil, app có cả YAML và spec, lượt chạy mọi flow trên Android (như lịch giám sát lọc Android) chạy
// YAML, không mở sidecar, không lỗi.
func TestMobileAllFlowsUnchangedWithSpecsAndNoWebRuntime(t *testing.T) {
	e, _ := newTestEngine(t)
	mixedApp(t, e)
	if e.Web != nil {
		t.Fatal("engine thử phải không có bộ chạy web")
	}
	if err := e.CheckRun(RunRequest{App: "demo", Devices: twoDevices[:1]}); err != nil {
		t.Fatalf("CheckRun mọi flow trên Android: %v", err)
	}
	sum, err := e.Run(context.Background(), RunRequest{App: "demo", Devices: twoDevices[:1]})
	if err != nil {
		t.Fatal(err)
	}
	if len(sum.Flows) != 1 || sum.Flows[0].Flow != "01_login.yaml" || !sum.Flows[0].Passed {
		t.Fatalf("flows = %+v", sum.Flows)
	}
	if e.Web != nil {
		t.Fatal("chạy mobile không được dựng bộ chạy web")
	}
}

func TestValidateReportsSpecsUncheckedWithoutRuntime(t *testing.T) {
	e, _ := newTestEngine(t)
	mixedApp(t, e)
	chk, err := e.Flows.CheckFlows(context.Background(), "demo")
	if err != nil || len(chk.Unchecked) != 1 || chk.Unchecked[0] != "login.spec.ts" {
		t.Fatalf("CheckFlows không bộ chạy = %+v, %v", chk, err)
	}
	if err := e.Flows.Validate("demo"); err != nil {
		t.Fatalf("test_validate cả app không bộ chạy không phải lỗi: %v", err)
	}
	if err := e.Flows.Validate("demo", "login.spec.ts"); apperr.CodeOf(err) != pw.CodeRuntimeMissing {
		t.Fatalf("gọi tên spec khi chưa cài bộ chạy: %v", err)
	}
	// YAML lỗi vẫn báo như cũ.
	if err := os.WriteFile(filepath.Join(e.Flows.Root, "demo", "02_bad.yaml"), []byte("appId: x\n---\n- tapOn: [\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := e.Flows.CheckFlows(context.Background(), "demo"); apperr.CodeOf(err) != CodeFlowInvalid {
		t.Fatalf("YAML lỗi: %v", err)
	}
}

func TestValidateChecksSpecsWhenRuntimeReady(t *testing.T) {
	e, _ := newTestEngine(t)
	mixedApp(t, e)
	specs := &stubSpecs{}
	e.Flows.Specs = specs
	if err := e.Flows.Validate("demo"); err != nil {
		t.Fatalf("spec hợp lệ: %v", err)
	}
	if got := specs.hosts[0]; len(got) != 1 || got[0] != "app.test" {
		t.Fatalf("kiểm tra không gắn thiết bị dùng host của mọi hồ sơ (Scope): %v", got)
	}
	bad := loginSpec + "test('x', async ({ page }) => {\n  await step('a', async () => { await page.evaluate('1'); });\n});\n"
	if err := os.WriteFile(filepath.Join(e.Flows.Root, "demo", "bad.spec.ts"), []byte(bad), 0o644); err != nil {
		t.Fatal(err)
	}
	fe := flowErrors(t, e.Flows.Validate("demo"))
	if len(fe) != 1 || fe[0].File != "bad.spec.ts" || fe[0].Line != 12 {
		t.Fatalf("lỗi spec phải có file và dòng: %+v", fe)
	}
}

func TestCompareWorksOnAndroidWithSpecsAndRefusesWeb(t *testing.T) {
	e, _ := newTestEngine(t)
	mixedApp(t, e)
	e.Preflight = &Preflight{ADBPath: fakeADB(t), GOOS: "darwin", Timeout: time.Second, Command: func(_ context.Context, _ string, args ...string) ([]byte, error) {
		switch key := strings.Join(args, " "); {
		case strings.Contains(key, "install"):
			return []byte("Success"), nil
		case strings.HasSuffix(key, "get-state"):
			return []byte("device"), nil
		case strings.Contains(key, "dumpsys power"):
			return []byte("mWakefulness=Awake"), nil
		}
		return nil, nil
	}}
	apk := filepath.Join(t.TempDir(), "a.apk")
	_ = os.WriteFile(apk, []byte("x"), 0o644)
	res, err := e.Compare(context.Background(), CompareRequest{App: "demo", Devices: twoDevices[:1], Repeat: 1,
		Old: AppBuild{Label: "1", File: apk}, New: AppBuild{Label: "2", File: apk}})
	if err != nil {
		t.Fatalf("so sánh mọi flow trên app có spec: %v", err)
	}
	if len(res.Old.Flows) != 1 || res.Old.Flows[0].Flow != "01_login.yaml" || len(res.New.Flows) != 1 {
		t.Fatalf("so sánh chỉ chạy YAML: %+v / %+v", res.Old.Flows, res.New.Flows)
	}
	web := Device{ID: "web-a", Platform: PlatformWeb, Driver: DriverPlaywright}
	if _, err := e.Compare(context.Background(), CompareRequest{App: "demo", Devices: []Device{web},
		Old: AppBuild{Label: "1", File: apk}, New: AppBuild{Label: "2", File: apk}}); apperr.CodeOf(err) != apperr.CodeInvalid {
		t.Fatalf("so sánh trên hồ sơ trình duyệt: %v", err)
	}
}

func TestReservedVarNamesRejectedOnWrite(t *testing.T) {
	e, _ := newTestEngine(t)
	for _, name := range []string{"NODE_OPTIONS", "CQS_ALLOWED_HOSTS", "HTTPS_PROXY", "PWDEBUG", "PW_TEST_X", "DYLD_INSERT_LIBRARIES"} {
		if _, err := e.Flows.SetEnv("demo", envScopeAll, map[string]string{name: "x"}); apperr.CodeOf(err) != apperr.CodeInvalid {
			t.Errorf("SetEnv %s: %v", name, err)
		}
		if err := e.Secrets.Set(name, "v"); apperr.CodeOf(err) != apperr.CodeInvalid {
			t.Errorf("SetSecret %s: %v", name, err)
		}
	}
	for _, name := range []string{"PASSWORD", "PWD_HINT", "PWX"} {
		if err := ValidVarName(name); err != nil {
			t.Fatal(err)
		}
	}
	// Phạm vi web nhận được, và giá trị cũ dưới tên nay dành riêng vẫn xoá được.
	if _, err := e.Flows.SetEnv("demo", PlatformWeb, map[string]string{"BASE_PATH": "/v2"}); err != nil {
		t.Fatalf("phạm vi web: %v", err)
	}
	merged, _ := e.Flows.envFor("demo", PlatformWeb, nil)
	if merged["BASE_PATH"] != "/v2" || merged["PASSWORD"] != "fixture-default" {
		t.Fatalf("env web = %v", merged)
	}
	if _, err := e.Flows.SetEnv("demo", envScopeAll, map[string]string{"NODE_OPTIONS": ""}); err != nil {
		t.Fatalf("xoá biến dành riêng cũ: %v", err)
	}
	if _, err := e.Flows.SetEnv("demo", "desktop", map[string]string{"A": "1"}); apperr.CodeOf(err) != apperr.CodeInvalid {
		t.Fatalf("phạm vi lạ: %v", err)
	}
}

// env của lượt mang tên dành riêng: lượt có máy web bị từ chối (biến vào tiến trình Node), lượt chỉ có điện thoại vẫn
// chạy như trước.
func TestReservedRunEnvRejectedOnlyWithWebDevice(t *testing.T) {
	e, _ := webEngine(t, &replayRunner{})
	ctx := context.Background()
	for _, name := range []string{"NODE_OPTIONS", "HTTPS_PROXY", "PWDEBUG", "PW_TEST_X"} {
		env := map[string]string{name: "x"}
		for label, devs := range map[string][]Device{
			"web":               {webDev("web-a")},
			"web và điện thoại": {twoDevices[0], webDev("web-a")},
		} {
			if err := e.CheckRun(RunRequest{App: "demo", Devices: devs, Env: env}); apperr.CodeOf(err) != apperr.CodeInvalid ||
				!strings.Contains(err.Error(), "dành riêng") {
				t.Errorf("CheckRun %s env %s: %v", label, name, err)
			}
			if _, err := e.Run(ctx, RunRequest{App: "demo", Devices: devs, Env: env}); apperr.CodeOf(err) != apperr.CodeInvalid ||
				!strings.Contains(err.Error(), "dành riêng") {
				t.Errorf("test_run %s env %s: %v", label, name, err)
			}
		}
		mobile := RunRequest{App: "demo", Flows: []string{"01_login.yaml"}, Devices: twoDevices[:1], Env: env}
		if err := e.CheckRun(mobile); err != nil {
			t.Errorf("CheckRun điện thoại env %s: %v", name, err)
		}
		if _, err := e.Run(ctx, mobile); err != nil {
			t.Errorf("test_run điện thoại env %s: %v", name, err)
		}
	}
	if err := e.CheckRun(RunRequest{App: "demo", Devices: twoDevices[:1], Env: map[string]string{"bad-name": "x"}}); apperr.CodeOf(err) != apperr.CodeInvalid {
		t.Fatalf("tên sai dạng vẫn bị từ chối với điện thoại: %v", err)
	}
}
