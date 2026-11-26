package testengine

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/devicelab-dev/maestro-runner/pkg/cli"
	"github.com/devicelab-dev/maestro-runner/pkg/core"
	"github.com/devicelab-dev/maestro-runner/pkg/executor"
	"github.com/devicelab-dev/maestro-runner/pkg/flow"
	"github.com/devicelab-dev/maestro-runner/pkg/report"

	"deskcore/apperr"
)

const secretPassword = "S3cret-Pa55-xyz"

const loginFlow = `appId: com.example
---
- launchApp
- tapOn: "Mật khẩu"
- inputText: ${PASSWORD}
- tapOn: "Đăng nhập"
- assertVisible: "Trang chủ"
`

func newTestEngine(t *testing.T) (*Engine, *fakeFactory) {
	t.Helper()
	dir := t.TempDir()
	pool, f := newTestPool()
	m, err := OpenMetrics(filepath.Join(dir, "testengine.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { m.Close() })
	secrets := &fileSecrets{path: filepath.Join(dir, "secrets.bin")}
	if err := secrets.Set("PASSWORD", secretPassword); err != nil {
		t.Fatal(err)
	}
	e := NewEngine(dir, pool, m, secrets)
	e.Home, e.Preflight = nil, nil // không có thiết bị thật
	writeTree(t, filepath.Join(dir, "flows", "demo"), map[string]string{"01_login.yaml": loginFlow})
	// loginFlow dùng ${PASSWORD}; lượt chạy không truyền thì lấy mặc định này (secrets truyền vào vẫn đè lên).
	if _, err := e.Flows.SetEnv("demo", envScopeAll, map[string]string{"PASSWORD": "fixture-default"}); err != nil {
		t.Fatal(err)
	}
	return e, f
}

var twoDevices = []Device{
	{ID: "emu-1", Platform: PlatformAndroid, Driver: "devicelab"},
	{ID: "emu-2", Platform: PlatformAndroid, Driver: "uiautomator2"},
}

func TestRunOnWarmDriversRecordsMetricsAndHidesSecrets(t *testing.T) {
	e, f := newTestEngine(t)
	var mu sync.Mutex
	var steps int
	e.OnEvent = func(ev Event) {
		if ev.Kind == "step" {
			mu.Lock()
			steps++
			mu.Unlock()
			if strings.Contains(ev.Step.Desc, secretPassword) {
				t.Errorf("sự kiện bước lộ mật khẩu: %s", ev.Step.Desc)
			}
		}
	}
	sum, err := e.Run(context.Background(), RunRequest{App: "demo", Devices: twoDevices, Secrets: []string{"PASSWORD"}, Repeat: 2})
	if err != nil {
		t.Fatal(err)
	}
	if len(sum.Flows) != 4 || sum.Run.Passed != 4 {
		t.Fatalf("flows=%d passed=%d, muốn 4/4: %+v", len(sum.Flows), sum.Run.Passed, sum.Flows)
	}
	for _, d := range twoDevices {
		if c, _ := f.counts(d.ID); c != 1 {
			t.Errorf("%s tạo driver %d lần, muốn 1", d.ID, c)
		}
	}
	cold := 0
	for _, fr := range sum.Flows {
		if fr.Cold {
			cold++
		}
		if fr.DeviceCount != 2 || len(fr.Steps) == 0 || fr.Flow != "01_login.yaml" {
			t.Errorf("flow run = %+v", fr)
		}
	}
	if cold != 2 || steps == 0 {
		t.Fatalf("cold=%d (muốn 1 mỗi thiết bị) steps=%d", cold, steps)
	}
	if _, err := os.Stat(filepath.Join(sum.Run.OutDir, "emu-1", "r02", "01_login")); err != nil {
		t.Fatalf("báo cáo theo thiết bị/lần lặp/flow: %v", err)
	}

	// Mật khẩu không nằm trong bất kỳ file báo cáo hay cơ sở dữ liệu số đo nào.
	for _, root := range []string{sum.Run.OutDir, filepath.Dir(e.RunsDir)} {
		_ = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() || strings.HasSuffix(p, "secrets.bin") {
				return nil
			}
			if b, _ := os.ReadFile(p); strings.Contains(string(b), secretPassword) {
				t.Errorf("lộ mật khẩu trong %s", p)
			}
			return nil
		})
	}

	s, err := e.Metrics.Summary(MetricsQuery{App: "demo"})
	if err != nil {
		t.Fatal(err)
	}
	if len(s.ByDevice) != 2 || s.MaxParallelOK != 2 || len(s.ColdVsWarm) != 2 || s.TapSteps.Count != 8 {
		t.Fatalf("summary = %+v", s)
	}
	runs, _ := e.Metrics.Runs(10)
	if len(runs) != 1 || runs[0].Passed != 4 {
		t.Fatalf("runs = %+v", runs)
	}
}

func TestRunRejectsBeforeTouchingDevices(t *testing.T) {
	e, f := newTestEngine(t)
	writeTree(t, filepath.Join(e.Flows.Root, "demo"), map[string]string{"02_bad.yaml": "appId: a\n---\n- nope: 1\n"})
	if _, err := e.Run(context.Background(), RunRequest{App: "demo", Devices: twoDevices}); apperr.CodeOf(err) != CodeFlowInvalid {
		t.Fatalf("flow sai: err = %v", err)
	}
	_, err := e.Run(context.Background(), RunRequest{App: "demo", Flows: []string{"01_login.yaml"}, Devices: twoDevices, Secrets: []string{"OTP"}})
	if apperr.CodeOf(err) != CodeSecretMissing {
		t.Fatalf("thiếu bí mật: err = %v", err)
	}
	if _, err := e.Run(context.Background(), RunRequest{App: "demo", Devices: []Device{twoDevices[0], twoDevices[0]}}); apperr.CodeOf(err) != apperr.CodeInvalid {
		t.Fatalf("thiết bị trùng: err = %v", err)
	}
	if len(f.created) != 0 {
		t.Fatal("lệnh bị từ chối không được chạm thiết bị")
	}
	if entries, _ := os.ReadDir(e.RunsDir); len(entries) != 0 {
		t.Fatal("lệnh bị từ chối không tạo thư mục lượt chạy")
	}
}

// blockingExecute: flow chạy đến khi context bị hủy.
func blockingExecute(started chan<- struct{}) ExecuteFunc {
	var once sync.Once
	return func(ctx context.Context, _ core.Driver, _ *cli.RunConfig, _ []flow.Flow, _ ...func(*executor.RunnerConfig)) (*executor.RunResult, error) {
		once.Do(func() { close(started) })
		<-ctx.Done()
		return &executor.RunResult{Status: report.StatusFailed}, nil
	}
}

func TestStopAllCancelsRunsAndReleasesDrivers(t *testing.T) {
	e, f := newTestEngine(t)
	started := make(chan struct{})
	e.Execute = blockingExecute(started)
	done := make(chan *RunSummary)
	go func() {
		sum, _ := e.Run(context.Background(), RunRequest{App: "demo", Devices: twoDevices, Repeat: 5})
		done <- sum
	}()
	<-started
	t0 := time.Now()
	if n := e.StopAll(2 * time.Second); n != 1 {
		t.Fatalf("hủy %d lượt, muốn 1", n)
	}
	sum := <-done
	if time.Since(t0) > 3*time.Second {
		t.Fatalf("dừng mất %v", time.Since(t0))
	}
	if !sum.Run.Canceled || sum.Run.Passed != 0 {
		t.Fatalf("run = %+v", sum.Run)
	}
	for _, d := range twoDevices {
		if c, cl := f.counts(d.ID); c != cl {
			t.Errorf("%s: tạo %d dọn %d, mọi driver phải được dọn", d.ID, c, cl)
		}
	}
	if len(sum.Flows) > 2 {
		t.Fatalf("sau khi dừng không chạy thêm flow: %d", len(sum.Flows))
	}
}

func TestDeadDriverIsDiscardedLiveDriverKept(t *testing.T) {
	e, f := newTestEngine(t)
	writeTree(t, filepath.Join(e.Flows.Root, "demo"), map[string]string{"02_more.yaml": "appId: a\n---\n- tapOn: \"X\"\n"})
	var dead atomic.Bool
	f.wrap = func(_ string, d core.Driver) core.Driver { return probeDriver{Driver: d, dead: &dead} }
	failed := func(context.Context, core.Driver, *cli.RunConfig, []flow.Flow, ...func(*executor.RunnerConfig)) (*executor.RunResult, error) {
		return &executor.RunResult{Status: report.StatusFailed, FlowResults: []executor.FlowResult{{Status: report.StatusFailed, Error: "element not found"}}}, nil
	}
	e.Execute = failed

	// Driver còn sống: flow lỗi là lỗi flow, driver giữ ấm, cả hai flow đều chạy.
	sum, err := e.Run(context.Background(), RunRequest{App: "demo", Devices: twoDevices[:1]})
	if err != nil || len(sum.Flows) != 2 || sum.Flows[0].FailureClass == FailEnvironment {
		t.Fatalf("flows = %+v err = %v", sum.Flows, err)
	}
	if _, cl := f.counts(twoDevices[0].ID); cl != 0 {
		t.Fatal("driver còn sống không được dọn")
	}

	// Executor không báo lỗi khi agent chết: chỉ câu hỏi kiểm tra driver phát hiện, dọn driver, dừng thiết bị.
	dead.Store(true)
	sum, err = e.Run(context.Background(), RunRequest{App: "demo", Devices: twoDevices[:1]})
	if err != nil || len(sum.Flows) != 1 || sum.Flows[0].FailureClass != FailEnvironment {
		t.Fatalf("flows = %+v err = %v", sum.Flows, err)
	}
	if _, cl := f.counts(twoDevices[0].ID); cl != 1 || health(e.Pool, twoDevices[0].ID) != HealthUnhealthy {
		t.Fatalf("driver chết phải được dọn: cleaned=%d health=%s", cl, health(e.Pool, twoDevices[0].ID))
	}

	// Lỗi trước khi chạy (vd không ghi được báo cáo) với driver sống: không vứt driver lành.
	dead.Store(false)
	e.Execute = func(context.Context, core.Driver, *cli.RunConfig, []flow.Flow, ...func(*executor.RunnerConfig)) (*executor.RunResult, error) {
		return nil, errors.New("disk full")
	}
	_, _ = e.Run(context.Background(), RunRequest{App: "demo", Devices: twoDevices[:1]})
	if _, cl := f.counts(twoDevices[0].ID); cl != 1 {
		t.Fatalf("lỗi ghi báo cáo không được dọn driver lành: cleaned=%d", cl)
	}
}

func TestHungDriverCallIsCutOff(t *testing.T) {
	e, f := newTestEngine(t)
	e.HungGrace = 50 * time.Millisecond
	release := make(chan struct{})
	defer close(release)
	e.Execute = func(_ context.Context, _ core.Driver, _ *cli.RunConfig, _ []flow.Flow, opts ...func(*executor.RunnerConfig)) (*executor.RunResult, error) {
		<-release // lệnh driver không nhận context
		var rc executor.RunnerConfig
		for _, o := range opts {
			o(&rc)
		}
		rc.OnStepComplete(0, "late step", true, 1, "") // callback muộn sau khi engine đã trả kết quả
		return &executor.RunResult{Status: report.StatusPassed}, nil
	}
	start := time.Now()
	sum, err := e.Run(context.Background(), RunRequest{App: "demo", Devices: twoDevices[:1], Timeout: 100 * time.Millisecond})
	if err != nil || time.Since(start) > 3*time.Second {
		t.Fatalf("err=%v sau %v", err, time.Since(start))
	}
	if len(sum.Flows) != 1 || sum.Flows[0].FailureClass != FailEnvironment || !strings.Contains(sum.Flows[0].Error, "không phản hồi") {
		t.Fatalf("flows = %+v", sum.Flows)
	}
	if _, cl := f.counts(twoDevices[0].ID); cl != 1 {
		t.Fatal("driver treo phải được dọn để nhả thiết bị")
	}
}

func TestUnpluggedDeviceFailsOnlyThatDevice(t *testing.T) {
	e, _ := newTestEngine(t)
	started := make(chan string, 2)
	e.Execute = func(ctx context.Context, _ core.Driver, cfg *cli.RunConfig, _ []flow.Flow, _ ...func(*executor.RunnerConfig)) (*executor.RunResult, error) {
		started <- cfg.Devices[0]
		if cfg.Devices[0] == "emu-2" {
			<-ctx.Done()
			return &executor.RunResult{Status: report.StatusFailed}, nil
		}
		time.Sleep(50 * time.Millisecond)
		return &executor.RunResult{Status: report.StatusPassed}, nil
	}
	done := make(chan *RunSummary)
	go func() {
		sum, _ := e.Run(context.Background(), RunRequest{App: "demo", Devices: twoDevices})
		done <- sum
	}()
	for i := 0; i < 2; i++ {
		<-started
	}
	if !e.CancelDevice("emu-2", ErrDeviceDisconnected) {
		t.Fatal("emu-2 đang chạy phải huỷ được")
	}
	sum := <-done
	byDev := map[string]FlowRun{}
	for _, fr := range sum.Flows {
		byDev[fr.DeviceID] = fr
	}
	if !byDev["emu-1"].Passed || byDev["emu-2"].FailureClass != FailEnvironment || !strings.Contains(byDev["emu-2"].Error, "ngắt kết nối") || sum.Run.Canceled {
		t.Fatalf("flows = %+v canceled=%v", sum.Flows, sum.Run.Canceled)
	}
	if e.CancelDevice("emu-2", ErrDeviceDisconnected) {
		t.Fatal("thiết bị không còn chạy thì không còn gì để huỷ")
	}
}

func TestRedactNestedAndEscapedSecrets(t *testing.T) {
	got := redact(`p=abc123 j="a\"b" h=a&amp;&quot;b`, []string{"abc", "abc123", `a"b`, `a&"b`})
	if strings.Contains(got, "123") || strings.Contains(got, `a\"b`) || strings.Contains(got, "a&amp;&quot;b") {
		t.Fatalf("redact = %q", got)
	}
}

func TestFailureClasses(t *testing.T) {
	e, _ := newTestEngine(t)
	failAt := func(desc, msg string) ExecuteFunc {
		return func(_ context.Context, _ core.Driver, _ *cli.RunConfig, _ []flow.Flow, opts ...func(*executor.RunnerConfig)) (*executor.RunResult, error) {
			var rc executor.RunnerConfig
			for _, o := range opts {
				o(&rc)
			}
			rc.OnStepComplete(0, "launchApp", true, 5, "")
			rc.OnStepComplete(1, desc, false, 8000, msg)
			return &executor.RunResult{Status: report.StatusFailed, FlowResults: []executor.FlowResult{{Status: report.StatusFailed, Error: msg}}}, nil
		}
	}
	for _, c := range []struct{ desc, msg, want string }{
		{`assertVisible: "Trang chủ"`, "element not visible", FailProduct},
		{`tapOn: "Đăng nhập"`, "element not found", FailAutomation},
		{`tapOn: "Đăng nhập"`, "driver session lost", FailEnvironment},
	} {
		e.Execute = failAt(c.desc, c.msg)
		sum, err := e.Run(context.Background(), RunRequest{App: "demo", Devices: twoDevices[:1]})
		if err != nil {
			t.Fatal(err)
		}
		if got := sum.Flows[0].FailureClass; got != c.want {
			t.Errorf("%s / %s: class = %s, muốn %s", c.desc, c.msg, got, c.want)
		}
	}
}

func TestPreflightFailureIsEnvironmentForEveryFlow(t *testing.T) {
	e, f := newTestEngine(t)
	e.Preflight = &Preflight{ADBPath: filepath.Join(t.TempDir(), "none"), Command: runCommand, GOOS: "windows", Timeout: time.Second}
	sum, err := e.Run(context.Background(), RunRequest{App: "demo", Devices: twoDevices[:1], Repeat: 3})
	if err != nil {
		t.Fatal(err)
	}
	if len(sum.Flows) != 3 || sum.Run.Failed != 3 || sum.Flows[0].FailureClass != FailEnvironment {
		t.Fatalf("flows = %+v", sum.Flows)
	}
	if len(f.created) != 0 {
		t.Fatal("preflight hỏng không được tạo driver")
	}
}

func TestPercentileNearestRank(t *testing.T) {
	ms := []int64{10, 20, 30, 40, 50, 60, 70, 80, 90, 100}
	if p := percentile(ms, 0.5); p != 50 {
		t.Errorf("p50 = %d", p)
	}
	if p := percentile(ms, 0.95); p != 100 {
		t.Errorf("p95 = %d", p)
	}
	if p := percentile([]int64{7}, 0.95); p != 7 {
		t.Errorf("p95 một mẫu = %d", p)
	}
}

func TestFileSecretsNeverListValues(t *testing.T) {
	s := &fileSecrets{path: filepath.Join(t.TempDir(), "secrets.bin")}
	if err := s.Set("password", "x"); apperr.CodeOf(err) != apperr.CodeInvalid {
		t.Fatalf("tên chữ thường: %v", err)
	}
	if err := s.Set("PASSWORD", "a\nb"); apperr.CodeOf(err) != apperr.CodeInvalid {
		t.Fatalf("giá trị nhiều dòng: %v", err)
	}
	_ = s.Set("PASSWORD", "v1")
	_ = s.Set("USERNAME", "u")
	names, _ := s.Names()
	if strings.Join(names, ",") != "PASSWORD,USERNAME" {
		t.Fatalf("names = %v", names)
	}
	_ = s.Delete("PASSWORD")
	if _, err := s.Get("PASSWORD"); apperr.CodeOf(err) != CodeSecretMissing {
		t.Fatalf("err = %v", err)
	}
}

// Keychain thật của macOS (dịch vụ riêng cho test, xoá sau khi chạy): CQS_KEYCHAIN_TEST=1.
func TestKeychainSecretsLive(t *testing.T) {
	if os.Getenv("CQS_KEYCHAIN_TEST") != "1" {
		t.Skip("đặt CQS_KEYCHAIN_TEST=1 để thử Keychain thật")
	}
	s := NewSecrets(t.TempDir(), "ChatQASoftware-test")
	value := `p@ss "with" \quotes và mật khẩu tiếng Việt`
	if err := s.Set("CQS_TEST_SECRET", value); err != nil {
		t.Fatal(err)
	}
	defer s.Delete("CQS_TEST_SECRET")
	got, err := s.Get("CQS_TEST_SECRET")
	if err != nil || got != value {
		t.Fatalf("got %q err %v", got, err)
	}
	if names, _ := s.Names(); len(names) != 1 || names[0] != "CQS_TEST_SECRET" {
		t.Fatalf("names = %v", names)
	}
}

func TestRedactDirRemovesSecretsFromReportFiles(t *testing.T) {
	dir := t.TempDir()
	writeTree(t, dir, map[string]string{
		"r01/report.json": `{"typed":"` + secretPassword + `"}`,
		"r01/allure-results/environment.properties": "PASSWORD=" + secretPassword + "\n",
		"r01/clean.html": "<p>ok</p>",
	})
	n, err := redactDir(dir, []string{secretPassword})
	if err != nil || n != 2 {
		t.Fatalf("redacted %d (%v), muốn 2", n, err)
	}
	_ = filepath.WalkDir(dir, func(p string, d fs.DirEntry, _ error) error {
		if !d.IsDir() {
			if b, _ := os.ReadFile(p); strings.Contains(string(b), secretPassword) {
				t.Errorf("còn mật khẩu trong %s", p)
			}
		}
		return nil
	})
	if b, _ := os.ReadFile(filepath.Join(dir, "r01", "report.json")); !strings.Contains(string(b), "***") {
		t.Fatal("giá trị phải được thay bằng ***")
	}
}

// ctxDriver giữ context như driver devicelab thật: executor gắn context của flow vào driver, lệnh sau đó dùng nó.
type ctxDriver struct {
	core.Driver
	mu  *sync.Mutex
	ctx *context.Context
}

func (d ctxDriver) SetContext(ctx context.Context) {
	d.mu.Lock()
	*d.ctx = ctx
	d.mu.Unlock()
}

func (d ctxDriver) Screenshot() ([]byte, error) {
	d.mu.Lock()
	ctx := *d.ctx
	d.mu.Unlock()
	if ctx != nil && ctx.Err() != nil {
		return nil, fmt.Errorf("screenshot aborted: %w", ctx.Err())
	}
	return d.Driver.Screenshot()
}

func TestWarmDriverReadableAfterRun(t *testing.T) {
	e, f := newTestEngine(t)
	f.wrap = func(_ string, d core.Driver) core.Driver {
		var ctx context.Context
		return ctxDriver{Driver: d, mu: &sync.Mutex{}, ctx: &ctx}
	}
	dev := twoDevices[0]
	if _, err := e.Run(context.Background(), RunRequest{App: "demo", Devices: []Device{dev}, Secrets: []string{"PASSWORD"}}); err != nil {
		t.Fatal(err)
	}
	// Live view và công cụ đọc màn hình gọi driver ấm ngoài flow: không được dùng context của flow đã xong.
	if _, err := e.Pool.Peek(context.Background(), dev, false, func(drv DeviceDriver) error {
		_, err := drv.Screenshot()
		return err
	}); err != nil {
		t.Fatalf("đọc màn hình sau lượt chạy: %v", err)
	}
}
