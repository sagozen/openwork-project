package tower

import (
	"context"
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/devicelab-dev/maestro-runner/pkg/cli"
	"github.com/devicelab-dev/maestro-runner/pkg/core"
	"github.com/devicelab-dev/maestro-runner/pkg/driver/mock"
	"github.com/devicelab-dev/maestro-runner/pkg/executor"
	"github.com/devicelab-dev/maestro-runner/pkg/flow"
	"github.com/devicelab-dev/maestro-runner/pkg/report"

	"chatqa/internal/testengine"
	"chatqa/internal/tower/pool"
	"deskcore/apperr"
	"deskcore/offline"
)

const secretValue = "Tower-S3cret-9911"

// memSecrets: kho bí mật trong bộ nhớ (test không đụng Keychain thật).
type memSecrets struct {
	mu sync.Mutex
	m  map[string]string
}

func (s *memSecrets) Get(n string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if v, ok := s.m[n]; ok {
		return v, nil
	}
	return "", apperr.New(testengine.CodeSecretMissing, n)
}
func (s *memSecrets) Set(n, v string) error { s.mu.Lock(); s.m[n] = v; s.mu.Unlock(); return nil }
func (s *memSecrets) Delete(n string) error { s.mu.Lock(); delete(s.m, n); s.mu.Unlock(); return nil }
func (s *memSecrets) Names() ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []string
	for k := range s.m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out, nil
}

type rig struct {
	t       *Tower
	dir     string
	mu      sync.Mutex
	found   []pool.Found
	cleaned map[string]int
}

func (r *rig) setFound(f ...pool.Found) { r.mu.Lock(); r.found = f; r.mu.Unlock() }

func (r *rig) poll(t *testing.T) {
	t.Helper()
	changed, err := r.t.Local.Poll(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if changed {
		r.t.fleetChanged(context.Background())
	}
}

func (r *rig) cleanups(id string) int { r.mu.Lock(); defer r.mu.Unlock(); return r.cleaned[id] }

var actor = offline.Actor{UserID: "u-anh", DeviceID: "PC-QA-01", At: 1_794_000_000}

func android(id string) pool.Found {
	return pool.Found{ID: id, Platform: testengine.PlatformAndroid, Model: "Pixel 7", Online: true}
}

func newRig(t *testing.T) *rig {
	t.Helper()
	dir := t.TempDir()
	r := &rig{dir: dir, cleaned: map[string]int{}}
	p := testengine.NewPool()
	p.Create = func(cfg *cli.RunConfig) (core.Driver, func(), error) {
		id := cfg.Devices[0]
		return mock.New(mock.Config{Platform: cfg.Platform, DeviceID: id}), func() {
			r.mu.Lock()
			r.cleaned[id]++
			r.mu.Unlock()
		}, nil
	}
	m, err := testengine.OpenMetrics(filepath.Join(dir, "testengine.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { m.Close() })
	e := testengine.NewEngine(dir, p, m, &memSecrets{m: map[string]string{"PASSWORD": secretValue}})
	e.Home, e.Preflight = nil, nil
	e.HungGrace = 50 * time.Millisecond
	store, err := OpenStore(filepath.Join(dir, "tower.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	local := pool.NewLocal(e, &pool.Discoverer{}, store)
	local.Discover = func(context.Context) ([]pool.Found, error) { r.mu.Lock(); defer r.mu.Unlock(); return r.found, nil }
	local.Facts = nil
	r.t = New(e, store, local)
	flows := filepath.Join(dir, "flows", "demo")
	os.MkdirAll(flows, 0o755)
	os.WriteFile(filepath.Join(flows, "01_login.yaml"), []byte("appId: com.example\n---\n- launchApp\n- inputText: ${PASSWORD}\n"), 0o644)
	os.WriteFile(filepath.Join(flows, "02_home.yaml"), []byte("appId: com.example\n---\n- assertVisible: \"Trang chủ\"\n"), 0o644)
	return r
}

func TestFleetStatesFollowDevicesAndDrivers(t *testing.T) {
	r := newRig(t)
	r.setFound(android("emu-1"), pool.Found{ID: "emu-2", Platform: testengine.PlatformAndroid, Problem: "chưa chấp nhận gỡ lỗi USB"})
	r.poll(t)
	states := func() map[string]pool.State {
		devs, _ := r.t.Fleet(context.Background())
		m := map[string]pool.State{}
		for _, d := range devs {
			m[d.ID] = d.State
		}
		return m
	}
	if s := states(); s["emu-1"] != pool.Connected || s["emu-2"] != pool.Unhealthy {
		t.Fatalf("states = %v", s)
	}
	if err := r.t.Pool.Prepare(context.Background(), "emu-1"); err != nil {
		t.Fatal(err)
	}
	r.poll(t)
	if s := states(); s["emu-1"] != pool.Ready {
		t.Fatalf("sau Prepare: %v", s)
	}
	r.setFound()
	r.poll(t)
	if s := states(); s["emu-1"] != pool.Disconnected || s["emu-2"] != pool.Disconnected {
		t.Fatalf("rút cáp: %v", s)
	}
	// Mở lại app: máy đã biết vẫn hiện, ở trạng thái disconnected.
	cached, _ := r.t.Store.CachedDevices()
	if len(cached) != 2 {
		t.Fatalf("cache = %+v", cached)
	}
}

func TestDispatchPicksOnlyUsableDevices(t *testing.T) {
	r := newRig(t)
	r.setFound(android("emu-1"), android("emu-2"), pool.Found{ID: "emu-3", Platform: testengine.PlatformAndroid, Problem: "offline"},
		pool.Found{ID: "sim-1", Platform: testengine.PlatformIOS, Simulator: true, Online: true})
	r.poll(t)
	ctx := context.Background()

	if _, err := r.t.Dispatch(ctx, actor, DispatchRequest{App: "demo", Devices: []string{"emu-3"}}); apperr.CodeOf(err) != testengine.CodeDeviceNotReady {
		t.Fatalf("máy hỏng chỉ định trực tiếp: %v", err)
	}
	if _, err := r.t.Dispatch(ctx, actor, DispatchRequest{App: "demo", Filter: DeviceFilter{Platform: "android", Count: 3}}); apperr.CodeOf(err) != CodeNoDevice {
		t.Fatalf("thiếu máy: %v", err)
	}
	task, err := r.t.Dispatch(ctx, actor, DispatchRequest{App: "demo", Filter: DeviceFilter{Platform: "android", Count: 2}, Secrets: []string{"PASSWORD"}})
	if err != nil {
		t.Fatal(err)
	}
	done, err := r.t.Wait(ctx, task.ID)
	if err != nil || done.Status != TaskPassed || done.Passed != 4 {
		t.Fatalf("task = %+v err = %v", done, err)
	}
	var req DispatchRequest
	json.Unmarshal(done.Request, &req)
	if strings.Join(req.Devices, ",") != "emu-1,emu-2" {
		t.Fatalf("máy được chọn = %v (chỉ Android dùng được)", req.Devices)
	}
	calls, _ := r.t.Store.Calls(time.Time{}, 10)
	if len(calls) == 0 || calls[0].Actor != "u-anh" || calls[0].ActorDevice != "PC-QA-01" || calls[0].Tool != "dispatch" {
		t.Fatalf("nhật ký lệnh = %+v", calls)
	}
	runs, _ := r.t.Engine.Metrics.FlowRuns(done.RunID)
	var ms int64
	for _, f := range runs {
		ms += f.DurationMs
	}
	if b, err := r.t.Budget(); err != nil || b.MachineMinutes != float64(ms)/60000 {
		t.Fatalf("phút máy tháng này = tổng thời gian flow (%d ms): %+v %v", ms, b, err)
	}
	if _, err := r.t.Dispatch(ctx, actor, DispatchRequest{App: "demo", Secrets: []string{"OTP"}}); apperr.CodeOf(err) != testengine.CodeSecretMissing {
		t.Fatalf("thiếu bí mật: %v", err)
	}
	card, err := r.t.Report(task.ID)
	if err != nil || len(card.ByDevice) != 2 || len(card.Reports) != 4 || card.Run == nil {
		t.Fatalf("report = %+v err = %v", card, err)
	}
}

func TestBudgetConfirmOnceAndCeiling(t *testing.T) {
	r := newRig(t)
	g := r.t.Guard
	op := PaidOp{Kind: "llm.compile", Subject: "demo", CostVnd: 30_000}
	if err := g.Allow(PaidOp{Kind: "llm.compile", Subject: "demo", CostVnd: 5_000}, ""); err != nil {
		t.Fatalf("dưới trần phải chạy ngay: %v", err)
	}
	err := g.Allow(op, "")
	if apperr.CodeOf(err) != CodeConfirmRequired {
		t.Fatalf("err = %v", err)
	}
	token := strings.TrimPrefix(err.Error()[strings.Index(err.Error(), "token="):], "token=")
	if err := g.Allow(PaidOp{Kind: "llm.compile", Subject: "other", CostVnd: 30_000}, token); apperr.CodeOf(err) != CodeConfirmRequired {
		t.Fatal("mã xác nhận chỉ dùng cho đúng việc đã hỏi")
	}
	if err := g.Allow(op, token); err != nil {
		t.Fatalf("có mã: %v", err)
	}
	if err := g.Allow(op, token); apperr.CodeOf(err) != CodeConfirmRequired {
		t.Fatal("mỗi mã chỉ dùng một lần")
	}
	// Worker báo còn 10.000 đ: thao tác 30.000 đ bị từ chối hẳn, không hỏi.
	r.t.Engine.Metrics.RecordLLM(testengine.LedgerEntry{At: time.Now(), CostVnd: 100, BudgetLeftVnd: 10_000})
	if err := g.Allow(op, ""); apperr.CodeOf(err) != CodeBudgetCeiling {
		t.Fatalf("err = %v", err)
	}
	b, _ := r.t.Budget()
	if !b.LeftKnown || b.LeftVnd != 10_000 || b.Calls != 1 || b.OpCeilingVnd != DefaultOpCeilingVnd {
		t.Fatalf("budget = %+v", b)
	}
}

// failOn: flow có tên chứa flowPart hỏng trên thiết bị device; còn lại đạt.
func failOn(device, flowPart string) testengine.ExecuteFunc {
	return func(_ context.Context, _ core.Driver, cfg *cli.RunConfig, flows []flow.Flow, _ ...func(*executor.RunnerConfig)) (*executor.RunResult, error) {
		if cfg.Devices[0] == device && strings.Contains(flows[0].SourcePath, flowPart) {
			return &executor.RunResult{Status: report.StatusFailed, FlowResults: []executor.FlowResult{{Status: report.StatusFailed, Error: "element not found"}}}, nil
		}
		return &executor.RunResult{Status: report.StatusPassed}, nil
	}
}

func TestReplayFailedKeepsConfig(t *testing.T) {
	r := newRig(t)
	r.setFound(android("emu-1"), android("emu-2"))
	r.poll(t)
	ctx := context.Background()
	r.t.Engine.Execute = failOn("emu-2", "02_home")
	task, err := r.t.Dispatch(ctx, actor, DispatchRequest{App: "demo", Env: map[string]string{"APP_ID": "com.example"}, Secrets: []string{"PASSWORD"}, Repeat: 2, Label: "1.4"})
	if err != nil {
		t.Fatal(err)
	}
	done, _ := r.t.Wait(ctx, task.ID)
	if done.Status != TaskFailed || done.Failed != 2 {
		t.Fatalf("task = %+v", done)
	}
	r.t.Engine.Execute = failOn("none", "")
	replay, err := r.t.ReplayFailed(ctx, actor, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	var req DispatchRequest
	json.Unmarshal(replay.Request, &req)
	if replay.Parent != task.ID || strings.Join(req.Devices, ",") != "emu-2" || strings.Join(req.Flows, ",") != "02_home.yaml" ||
		req.Env["APP_ID"] != "com.example" || strings.Join(req.Secrets, ",") != "PASSWORD" || req.Label != "1.4" {
		t.Fatalf("replay request = %+v", req)
	}
	if d, _ := r.t.Wait(ctx, replay.ID); d.Status != TaskPassed || d.Passed != 1 {
		t.Fatalf("replay = %+v", d)
	}
}

// blockOn: thiết bị device chạy đến khi context bị huỷ; thiết bị khác đạt sau 30ms.
func blockOn(device string, started chan<- string) testengine.ExecuteFunc {
	return func(ctx context.Context, _ core.Driver, cfg *cli.RunConfig, _ []flow.Flow, _ ...func(*executor.RunnerConfig)) (*executor.RunResult, error) {
		started <- cfg.Devices[0]
		if device == "*" || cfg.Devices[0] == device {
			<-ctx.Done()
			return &executor.RunResult{Status: report.StatusFailed}, nil
		}
		time.Sleep(30 * time.Millisecond)
		return &executor.RunResult{Status: report.StatusPassed}, nil
	}
}

func TestPauseAllStopsEverythingAndReleasesDevices(t *testing.T) {
	r := newRig(t)
	r.setFound(android("emu-1"), android("emu-2"))
	r.poll(t)
	ctx := context.Background()
	started := make(chan string, 10)
	r.t.Engine.Execute = blockOn("*", started)
	task, err := r.t.Dispatch(ctx, actor, DispatchRequest{App: "demo", Flows: []string{"02_home.yaml"}, Repeat: 5})
	if err != nil {
		t.Fatal(err)
	}
	<-started
	<-started
	if n := r.t.PauseAll(actor); n != 1 {
		t.Fatalf("huỷ %d lượt", n)
	}
	done, _ := r.t.Wait(ctx, task.ID)
	if done.Status != TaskCanceled || !done.UserStopped() {
		t.Fatalf("task = %+v", done)
	}
	for _, id := range []string{"emu-1", "emu-2"} {
		if r.cleanups(id) != 1 {
			t.Errorf("%s: driver phải được dọn (cleaned=%d)", id, r.cleanups(id))
		}
	}
	// Máy được nhả: chạy lại ngay được.
	r.t.Engine.Execute = failOn("none", "")
	again, err := r.t.Dispatch(ctx, actor, DispatchRequest{App: "demo", Flows: []string{"02_home.yaml"}})
	if err != nil {
		t.Fatal(err)
	}
	if d, _ := r.t.Wait(ctx, again.ID); d.Status != TaskPassed {
		t.Fatalf("sau dừng tất cả: %+v", d)
	}
}

func TestUnplugMidRunFailsOnlyThatDevice(t *testing.T) {
	r := newRig(t)
	r.setFound(android("emu-1"), android("emu-2"))
	r.poll(t)
	ctx := context.Background()
	started := make(chan string, 4)
	r.t.Engine.Execute = blockOn("emu-2", started)
	task, err := r.t.Dispatch(ctx, actor, DispatchRequest{App: "demo", Flows: []string{"02_home.yaml"}})
	if err != nil {
		t.Fatal(err)
	}
	<-started
	<-started
	r.setFound(android("emu-1")) // rút emu-2
	r.poll(t)
	done, _ := r.t.Wait(ctx, task.ID)
	if done.Status != TaskFailed || done.Passed != 1 || done.Failed != 1 {
		t.Fatalf("task = %+v", done)
	}
	card, _ := r.t.Report(task.ID)
	if len(card.Failures) != 1 || card.Failures[0].DeviceID != "emu-2" || card.Failures[0].FailureClass != testengine.FailEnvironment {
		t.Fatalf("failures = %+v", card.Failures)
	}
	dev, _ := r.t.Pool.Device(ctx, "emu-2")
	events, _ := r.t.Store.Events(time.Time{}, 50)
	disc := 0
	for _, e := range events {
		if e.Kind == "device_disconnected" && e.DeviceID == "emu-2" {
			disc++
		}
	}
	if dev.State != pool.Disconnected || disc != 1 {
		t.Fatalf("state = %s, disconnect events = %d", dev.State, disc)
	}
	h, _ := r.t.Health(ctx)
	alerts, _ := r.t.Alerts(ctx)
	if h.FailuresByType[testengine.FailEnvironment] != 1 || h.Flows != 2 || len(alerts) == 0 {
		t.Fatalf("health = %+v alerts = %+v", h, alerts)
	}
}

// Giá trị bí mật không được nằm trong bất kỳ kho, nhật ký hay báo cáo nào của tháp và engine.
func TestCredentialValuesNeverStored(t *testing.T) {
	r := newRig(t)
	r.setFound(android("emu-1"))
	r.poll(t)
	ctx := context.Background()
	task, err := r.t.Dispatch(ctx, actor, DispatchRequest{App: "demo", Secrets: []string{"PASSWORD"}, Env: map[string]string{"USER": "192754"}})
	if err != nil {
		t.Fatal(err)
	}
	r.t.Wait(ctx, task.ID)
	r.t.Store.LogCall(actor, "test", "emu-1", map[string]string{"leak": secretValue}, "ok", 0, []string{secretValue})
	_ = filepath.WalkDir(r.dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		if b, _ := os.ReadFile(p); strings.Contains(string(b), secretValue) {
			t.Errorf("lộ giá trị bí mật trong %s", p)
		}
		return nil
	})
}

func deviceOf(t *testing.T, tw *Tower, id string) pool.Device {
	t.Helper()
	d, err := tw.Pool.Device(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func TestTakeOverHoldsDeviceForManualControlUntilHandBack(t *testing.T) {
	r := newRig(t)
	r.setFound(android("emu-1"), android("emu-2"))
	r.poll(t)
	ctx := context.Background()
	var fleets []pool.Device
	r.t.OnFleet = func(d []pool.Device) { fleets = d }

	if _, mode, err := r.t.Pool.Frame(ctx, "emu-1", false); err != nil || mode != pool.FrameCold {
		t.Fatalf("Frame máy chưa có driver (lưới) = %s %v", mode, err)
	}
	if _, mode, err := r.t.Pool.Frame(ctx, "emu-1", true); err != nil || mode != pool.FrameIdle {
		t.Fatalf("Frame máy phóng to = %s %v", mode, err)
	}
	got, err := r.t.TakeOver(ctx, actor, "emu-1")
	if err != nil || got.Paused {
		t.Fatalf("TakeOver = %+v %v", got, err)
	}
	if d := deviceOf(t, r.t, "emu-1"); d.Held != testengine.HoldIdle || d.State != pool.Busy {
		t.Fatalf("máy đang giữ: held=%q state=%s", d.Held, d.State)
	}
	if len(fleets) == 0 {
		t.Fatal("UI không được báo danh sách máy mới sau khi giữ máy")
	}
	if _, err := r.t.Dispatch(ctx, actor, DispatchRequest{App: "demo", Devices: []string{"emu-1"}}); apperr.CodeOf(err) != testengine.CodeDeviceNotReady {
		t.Fatalf("điều phối vào máy đang giữ: %v", err)
	}
	if err := r.t.Pool.Tap(ctx, "emu-1", 0.5, 0.4); err != nil {
		t.Fatalf("chạm tay khi đang giữ: %v", err)
	}
	if err := r.t.Pool.Swipe(ctx, "emu-1", 0.5, 0.8, 0.5, 0.2, 300); err != nil {
		t.Fatalf("vuốt tay khi đang giữ: %v", err)
	}
	if _, mode, err := r.t.Pool.Frame(ctx, "emu-1", false); err != nil || mode != pool.FrameHeld {
		t.Fatalf("Frame máy đang giữ = %s %v", mode, err)
	}
	if !r.t.HandBack(ctx, actor, "emu-1") {
		t.Fatal("HandBack = false")
	}
	if d := deviceOf(t, r.t, "emu-1"); d.Held != "" || d.State != pool.Ready {
		t.Fatalf("sau khi trả: held=%q state=%s", d.Held, d.State)
	}
	if r.t.HandBack(ctx, actor, "emu-1") {
		t.Fatal("trả máy không bị giữ phải trả false")
	}
	calls, _ := r.t.Store.Calls(time.Time{}, 20)
	var tools []string
	for _, c := range calls {
		if c.DeviceID == "emu-1" {
			tools = append(tools, c.Tool)
		}
	}
	if !contains(tools, "takeover") || !contains(tools, "hand_back") {
		t.Fatalf("nhật ký lệnh của emu-1 = %v", tools)
	}
}

func TestPauseAllReleasesTakenOverDevices(t *testing.T) {
	r := newRig(t)
	r.setFound(android("emu-1"))
	r.poll(t)
	ctx := context.Background()
	if _, err := r.t.TakeOver(ctx, actor, "emu-1"); err != nil {
		t.Fatal(err)
	}
	t0 := time.Now()
	r.t.PauseAll(actor)
	if time.Since(t0) > 3*time.Second {
		t.Fatalf("Esc mất %v", time.Since(t0))
	}
	if s := r.t.Engine.HoldState("emu-1"); s != testengine.HoldNone {
		t.Fatalf("Esc mà máy vẫn bị giữ: %q", s)
	}
	for deadline := time.Now().Add(2 * time.Second); deviceOf(t, r.t, "emu-1").Held != ""; { // danh sách máy đọc lại ở nền
		if time.Now().After(deadline) {
			t.Fatal("danh sách máy không cập nhật sau Esc")
		}
		time.Sleep(10 * time.Millisecond)
	}
	task, err := r.t.Dispatch(ctx, actor, DispatchRequest{App: "demo", Flows: []string{"02_home.yaml"}})
	if err != nil {
		t.Fatal(err)
	}
	if d, _ := r.t.Wait(ctx, task.ID); d.Status != TaskPassed {
		t.Fatalf("sau Esc máy phải chạy lại được: %+v", d)
	}
}

func TestUnplugReleasesTakenOverDevice(t *testing.T) {
	r := newRig(t)
	r.setFound(android("emu-1"))
	r.poll(t)
	if _, err := r.t.TakeOver(context.Background(), actor, "emu-1"); err != nil {
		t.Fatal(err)
	}
	r.setFound()
	r.poll(t)
	if s := r.t.Engine.HoldState("emu-1"); s != testengine.HoldNone {
		t.Fatalf("rút cáp mà máy vẫn bị giữ: %q", s)
	}
	if _, _, err := r.t.Pool.Frame(context.Background(), "emu-1", false); apperr.CodeOf(err) != testengine.CodeDeviceNotReady {
		t.Fatalf("Frame máy đã rút: %v", err)
	}
}

func TestDispatchRightAfterDeviceReadIsNotRefusedBusy(t *testing.T) {
	r := newRig(t)
	r.setFound(android("emu-1"))
	r.poll(t)
	ctx := context.Background()
	release := make(chan struct{})
	reading := make(chan struct{})
	go func() {
		// device_ui_state đang đọc màn hình đúng lúc tower đọc lại danh sách máy
		_ = r.t.Engine.Pool.Run(ctx, testengine.Device{ID: "emu-1", Platform: testengine.PlatformAndroid, Driver: "devicelab"},
			func(context.Context, testengine.Session) error { close(reading); <-release; return nil })
	}()
	<-reading
	r.poll(t)
	close(release)
	// Thao tác đã xong: điều phối ngay, không chờ lượt đọc thiết bị sau.
	deadline := time.Now().Add(2 * time.Second)
	for {
		task, err := r.t.Dispatch(ctx, actor, DispatchRequest{App: "demo", Devices: []string{"emu-1"}, Secrets: []string{"PASSWORD"}})
		if err == nil {
			if _, err := r.t.Wait(ctx, task.ID); err != nil {
				t.Fatal(err)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("điều phối sau khi đọc màn hình xong: %v", err)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// tapRecorder ghi các step đã Execute trên driver (bọc driver mock của rig).
type tapRecorder struct {
	core.Driver
	mu    sync.Mutex
	steps []flow.Step
}

func (r *tapRecorder) Execute(s flow.Step) *core.CommandResult {
	r.mu.Lock()
	r.steps = append(r.steps, s)
	r.mu.Unlock()
	return &core.CommandResult{Success: true}
}

func (r *tapRecorder) taps() []*flow.TapOnStep {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []*flow.TapOnStep
	for _, s := range r.steps {
		if t, ok := s.(*flow.TapOnStep); ok {
			out = append(out, t)
		}
	}
	return out
}

// Chạm tay khi lượt chạy đang tạm dừng phải chạy đúng một tapOn trên chính driver của lượt chạy.
func TestManualTapWhileRunPausedUsesRunsOwnDriver(t *testing.T) {
	r := newRig(t)
	rec := &tapRecorder{Driver: mock.New(mock.Config{Platform: testengine.PlatformAndroid, DeviceID: "emu-1"})}
	r.t.Engine.Pool.Create = func(*cli.RunConfig) (core.Driver, func(), error) { return rec, func() {}, nil }
	r.setFound(android("emu-1"))
	r.poll(t)
	ctx := context.Background()

	started := make(chan struct{})
	var runDrv core.Driver
	r.t.Engine.Execute = func(ctx context.Context, drv core.Driver, _ *cli.RunConfig, _ []flow.Flow, opts ...func(*executor.RunnerConfig)) (*executor.RunResult, error) {
		runDrv = drv
		close(started)
		time.Sleep(100 * time.Millisecond) // để TakeOver kịp xếp hàng chờ ranh giới bước
		var rc executor.RunnerConfig
		for _, o := range opts {
			o(&rc)
		}
		rc.OnStepComplete(0, "bước 1", true, 1, "") // dừng ở đây khi có người giữ máy
		return &executor.RunResult{Status: report.StatusPassed}, nil
	}
	task, err := r.t.Dispatch(ctx, actor, DispatchRequest{App: "demo", Flows: []string{"02_home.yaml"}})
	if err != nil {
		t.Fatal(err)
	}
	<-started
	got, err := r.t.TakeOver(ctx, actor, "emu-1")
	if err != nil || !got.Paused {
		t.Fatalf("TakeOver = %+v %v, muốn lượt chạy tạm dừng", got, err)
	}
	if err := r.t.Pool.Tap(ctx, "emu-1", 0.5, 0.25); err != nil {
		t.Fatalf("chạm tay: %v", err)
	}
	taps := rec.taps()
	if len(taps) != 1 || taps[0].Point != "50.0%,25.0%" {
		t.Fatalf("tapOn trên driver của lượt chạy = %+v, muốn đúng 1 với point 50.0%%,25.0%%", taps)
	}
	if runDrv != core.Driver(rec) {
		t.Fatalf("lượt chạy dùng driver %T, muốn driver của rig", runDrv)
	}
	if !r.t.HandBack(ctx, actor, "emu-1") {
		t.Fatal("HandBack = false")
	}
	if d, _ := r.t.Wait(ctx, task.ID); d.Status != TaskPassed {
		t.Fatalf("task = %+v", d)
	}
}
