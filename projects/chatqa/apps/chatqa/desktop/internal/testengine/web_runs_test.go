package testengine

import (
	"bytes"
	"context"
	"image"
	"image/color"
	"image/jpeg"
	"io/fs"
	"net/url"
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

	"chatqa/internal/pw"
	"deskcore/apperr"
)

// replayRunner: bộ chạy spec giả phát lại sự kiện reporter dựng sẵn (script có thể tạo file attachment trong job.Dir).
// hold khác nil: sau khi phát sự kiện, chờ hold đóng hoặc ctx bị huỷ.
type replayRunner struct {
	t       *testing.T
	script  func(t *testing.T, job pw.Job) ([]pw.Event, pw.Result)
	started chan string
	hold    chan struct{}

	mu   sync.Mutex
	jobs []pw.Job
}

func (r *replayRunner) Run(ctx context.Context, job pw.Job, on func(pw.Event)) (pw.Result, error) {
	r.mu.Lock()
	r.jobs = append(r.jobs, job)
	r.mu.Unlock()
	if err := os.MkdirAll(filepath.Join(job.Dir, "test-results"), 0o700); err != nil {
		return pw.Result{}, err
	}
	var evs []pw.Event
	res := pw.Result{Ended: true, Status: "passed"}
	if r.script != nil {
		evs, res = r.script(r.t, job)
	}
	if r.started != nil {
		r.started <- job.Profile.ID
	}
	for _, ev := range evs {
		on(ev)
	}
	if r.hold != nil {
		select {
		case <-r.hold:
		case <-ctx.Done():
			return pw.Result{Killed: true}, nil
		}
	}
	return res, nil
}

func (r *replayRunner) lastJob() pw.Job {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.jobs[len(r.jobs)-1]
}

var webProfiles = map[string]pw.Profile{
	"web-a":  {ID: "web-a", Name: "A", Browser: "chromium", Width: 1280, Height: 800, BaseURL: "http://app.test", Headless: true},
	"web-b":  {ID: "web-b", Name: "B", Browser: "chromium", Channel: "chrome", Width: 390, Height: 844, BaseURL: "http://m.app.test", Headless: true},
	"web-ff": {ID: "web-ff", Name: "FF", Browser: "firefox", Width: 1280, Height: 800, BaseURL: "http://app.test", Headless: true},
}

func webDev(id string) Device {
	return Device{ID: id, Platform: PlatformWeb, Driver: DriverPlaywright, Rev: webProfiles[id].Fingerprint()}
}

// webEngine: engine thử có app demo (01_login.yaml + login.spec.ts), ba hồ sơ trình duyệt trên bộ chạy giả, bộ kiểm tra
// spec giả và bộ chạy spec run.
func webEngine(t *testing.T, run *replayRunner) (*Engine, *stubSpecs) {
	t.Helper()
	e, _ := newTestEngine(t)
	mixedApp(t, e)
	rt, _ := fakeWebRuntime(t)
	e.Web = &Web{RT: rt, Profile: func(id string) (pw.Profile, error) {
		p, ok := webProfiles[id]
		if !ok {
			return pw.Profile{}, apperr.New(apperr.CodeNotFound, id)
		}
		return p, nil
	}}
	specs := &stubSpecs{}
	e.Flows.Specs = specs
	if run != nil {
		run.t = t
		e.SpecRunner = run
	}
	return e, specs
}

func writeArtifact(t *testing.T, path string, body []byte) string {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, body, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func att(name, path string) pw.Attachment {
	return pw.Attachment{Name: name, ContentType: "image/png", Path: path}
}

// passScript: hai bước, ảnh đầu và ảnh sau mỗi bước; lệnh điền mang giá trị bí mật trong tiêu đề (reporter của
// Playwright ghi giá trị đã điền), app phải che.
func passScript(t *testing.T, job pw.Job) ([]pw.Event, pw.Result) {
	out := filepath.Join(job.Dir, "test-results", "t1")
	png := onePixelPNG()
	return []pw.Event{
		{Type: pw.EventBegin, Total: 1},
		{Type: pw.EventStep, Test: "t1", Depth: 1, Title: "Navigate", Category: "pw:api", DurationMs: 40},
		{Type: pw.EventStep, Test: "t1", Depth: 0, Title: "mở trang", Category: "test.step", DurationMs: 45},
		{Type: pw.EventStep, Test: "t1", Depth: 1, Title: `Fill "` + secretPassword + `"`, Category: "pw:api", DurationMs: 20},
		{Type: pw.EventStep, Test: "t1", Depth: 0, Title: "điền mật khẩu", Category: "test.step", DurationMs: 25},
		{Type: pw.EventTest, Test: "t1", Title: "đăng nhập web", Status: "passed", DurationMs: 900, Attachments: []pw.Attachment{
			att("cqs-initial", writeArtifact(t, filepath.Join(out, "initial.png"), png)),
			att("cqs-after", writeArtifact(t, filepath.Join(out, "after-1.png"), png)),
			att("cqs-after", writeArtifact(t, filepath.Join(out, "after-2.png"), png)),
		}},
		{Type: pw.EventEnd, Status: "passed"},
	}, pw.Result{Ended: true, Status: "passed"}
}

// failScript: bước thứ hai hỏng với message; kèm ảnh lỗi, aria snapshot, URL, video và trace (cả hai chứa bí mật).
func failScript(message, category, status, page string) func(t *testing.T, job pw.Job) ([]pw.Event, pw.Result) {
	return func(t *testing.T, job pw.Job) ([]pw.Event, pw.Result) {
		out := filepath.Join(job.Dir, "test-results", "t1")
		png := onePixelPNG()
		return []pw.Event{
			{Type: pw.EventBegin, Total: 1},
			{Type: pw.EventStep, Test: "t1", Depth: 0, Title: "mở trang", Category: "test.step", DurationMs: 45},
			{Type: pw.EventStep, Test: "t1", Depth: 1, Title: "Bước hỏng", Category: category, Error: &pw.TestError{Message: message}},
			{Type: pw.EventStep, Test: "t1", Depth: 0, Title: "kiểm tra", Category: "test.step", Error: &pw.TestError{Message: message}},
			{Type: pw.EventTest, Test: "t1", Title: "đăng nhập web", Status: status, DurationMs: 1500,
				Error: &pw.TestError{Message: message, Line: 9}, Attachments: []pw.Attachment{
					att("cqs-failure", writeArtifact(t, filepath.Join(out, "failure.png"), png)),
					{Name: "failure-aria", ContentType: "text/plain", Body: "- textbox \"Mật khẩu\": " + secretPassword},
					{Name: "failure-url", ContentType: "text/plain", Body: page},
					{Name: "video", ContentType: "video/webm", Path: writeArtifact(t, filepath.Join(out, "video.webm"), []byte("webm"))},
					{Name: "trace", ContentType: "application/zip", Path: writeArtifact(t, filepath.Join(out, "trace.zip"), []byte("PK trace "+secretPassword))},
				}},
			{Type: pw.EventEnd, Status: "failed"},
		}, pw.Result{Ended: true, Status: "failed"}
	}
}

// noSecretInDir: không file văn bản nào trong dir còn giá trị v (mọi dạng thoát).
func noSecretInDir(t *testing.T, dir, v string) {
	t.Helper()
	_ = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || skipRedact(p) {
			return err
		}
		b, _ := os.ReadFile(p)
		for _, f := range secretForms([]string{v}) {
			if strings.Contains(string(b), f) {
				t.Errorf("giá trị bí mật còn trong %s", p)
			}
		}
		return nil
	})
}

func specRun(t *testing.T, e *Engine, req RunRequest) *RunSummary {
	t.Helper()
	if req.App == "" {
		req.App = "demo"
	}
	if req.Flows == nil {
		req.Flows = []string{"login.spec.ts"}
	}
	sum, err := e.Run(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	return sum
}

func TestWebRunPassRecordsStepsShotsAndHidesSecrets(t *testing.T) {
	run := &replayRunner{script: passScript}
	e, _ := webEngine(t, run)
	var mu sync.Mutex
	var events []Event
	e.OnEvent = func(ev Event) { mu.Lock(); events = append(events, ev); mu.Unlock() }
	sum := specRun(t, e, RunRequest{Devices: []Device{webDev("web-a")}, Secrets: []string{"PASSWORD"}, Artifacts: ArtifactsAlways})
	if len(sum.Flows) != 1 {
		t.Fatalf("flows = %+v", sum.Flows)
	}
	fr := sum.Flows[0]
	if !fr.Passed || fr.Platform != PlatformWeb || fr.Driver != DriverPlaywright || fr.Flow != "login.spec.ts" || fr.DurationMs != 900 {
		t.Fatalf("flow run = %+v", fr)
	}
	var shape []string
	for _, s := range fr.Steps {
		shape = append(shape, strings.Join([]string{s.Command, s.Desc}, ":"))
	}
	if got := strings.Join(shape, " | "); got != `step:mở trang | navigate:Navigate | step:điền mật khẩu | fill:Fill "***"` {
		t.Fatalf("bước (cha trước con, bí mật bị che) = %s", got)
	}
	s0, s1 := fr.Steps[0], fr.Steps[2]
	if s0.Index != 0 || s1.Index != 1 || fr.Steps[1].Index != -1 || fr.Steps[1].Depth != 1 {
		t.Fatalf("chỉ số bước: %+v", fr.Steps)
	}
	if !strings.HasSuffix(s0.ShotBefore, "assets/initial-1.png") || s1.ShotBefore != s0.ShotAfter || s1.ShotAfter == "" {
		t.Fatalf("ảnh trước/sau: %+v %+v", s0, s1)
	}
	for _, rel := range []string{s0.ShotBefore, s0.ShotAfter, s1.ShotAfter} {
		if _, err := shotPath(sum.Run.OutDir, rel); err != nil {
			t.Errorf("ảnh %s: %v", rel, err)
		}
	}
	job := run.lastJob()
	if len(job.Vars) != 1 || job.Vars["PASSWORD"] != secretPassword {
		t.Fatalf("tiến trình chỉ nhận biến spec dùng: %v", job.Vars)
	}
	if job.Video != pw.VideoOff || job.StepShots != ArtifactsAlways || job.Timeout != 10*time.Minute || job.LiveDir == "" ||
		job.Profile.ID != "web-a" || !strings.HasPrefix(job.Dir, pw.RunsDir(e.Web.RT)) {
		t.Fatalf("job = %+v", job)
	}
	if _, err := os.Stat(filepath.Dir(job.LiveDir)); !os.IsNotExist(err) {
		t.Fatalf("thư mục làm việc của thiết bị phải bị xoá sau lượt: %v", err)
	}
	rows, err := e.Metrics.FlowRuns(sum.Run.ID)
	if err != nil || len(rows) != 1 || rows[0].Platform != PlatformWeb || rows[0].Driver != DriverPlaywright || len(rows[0].Steps) != 4 {
		t.Fatalf("flow_runs = %+v, %v", rows, err)
	}
	for _, f := range []string{ReportHTMLFile, ReportSummaryFile} {
		if _, err := os.Stat(filepath.Join(sum.Run.OutDir, f)); err != nil {
			t.Errorf("thiếu %s: %v", f, err)
		}
	}
	noSecretInDir(t, sum.Run.OutDir, secretPassword)
	mu.Lock()
	defer mu.Unlock()
	kinds := map[string]int{}
	for _, ev := range events {
		kinds[ev.Kind]++
		if ev.Step != nil && strings.Contains(ev.Step.Desc, secretPassword) {
			t.Errorf("sự kiện bước lộ bí mật: %s", ev.Step.Desc)
		}
	}
	if kinds["step"] != 4 || kinds["flow_start"] != 1 || kinds["flow_end"] != 1 {
		t.Fatalf("sự kiện = %v", kinds)
	}
}

func TestWebRunFailureClasses(t *testing.T) {
	cases := []struct {
		name   string
		script func(t *testing.T, job pw.Job) ([]pw.Event, pw.Result)
		class  string
	}{
		{"expect không đạt", failScript("Error: expect(locator).toBeVisible() failed", "expect", "failed", "http://app.test/home"), FailProduct},
		{"hết hạn chờ locator", failScript("TimeoutError: locator.click: Timeout 10000ms exceeded.", "pw:api", "failed", ""), FailAutomation},
		{"strict mode", failScript("Error: strict mode violation: getByRole('button') resolved to 2 elements", "pw:api", "failed", ""), FailAutomation},
		{"chặn host", failScript("Error: web_host_blocked: navigation http://evil.test/", "pw:api", "failed", ""), FailEnvironment},
		{"lỗi mạng", failScript("Error: page.goto: net::ERR_CONNECTION_REFUSED at http://app.test/", "pw:api", "failed", ""), FailEnvironment},
		{"trình duyệt không mở", failScript("Error: browserType.launch: Executable doesn't exist at /x", "pw:api", "failed", ""), FailEnvironment},
		{"quá hạn cả test", failScript("Test timeout of 600000ms exceeded.", "pw:api", "timedOut", ""), FailEnvironment},
		{"tiến trình chết không có end", func(*testing.T, pw.Job) ([]pw.Event, pw.Result) {
			return []pw.Event{{Type: pw.EventBegin, Total: 1}}, pw.Result{Log: "Segmentation fault"}
		}, FailEnvironment},
		{"quá hạn cứng", func(*testing.T, pw.Job) ([]pw.Event, pw.Result) { return nil, pw.Result{TimedOut: true} }, FailEnvironment},
		{"không có test nào", func(*testing.T, pw.Job) ([]pw.Event, pw.Result) {
			return []pw.Event{{Type: pw.EventError, Error: &pw.TestError{Message: "Error: No tests found"}}, {Type: pw.EventEnd, Status: "failed"}},
				pw.Result{Ended: true, Status: "failed"}
		}, FailAutomation},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			e, _ := webEngine(t, &replayRunner{script: c.script})
			sum := specRun(t, e, RunRequest{Devices: []Device{webDev("web-a")}})
			fr := sum.Flows[0]
			if fr.Passed || fr.FailureClass != c.class || fr.Error == "" {
				t.Fatalf("flow run = %+v, muốn lớp %s", fr, c.class)
			}
		})
	}
}

func TestWebRunFailureRedactsURLEncodedSecretAndKeepsEvidence(t *testing.T) {
	const pin = "a b/c&d+é"
	page := "http://app.test/x?pin=" + url.QueryEscape(pin) + "&p=" + strings.ToLower(url.PathEscape(pin))
	e, _ := webEngine(t, &replayRunner{script: failScript("Error: expect(page).toHaveURL failed: "+pin, "expect", "failed", page)})
	if err := e.Secrets.Set("PIN", pin); err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var journal strings.Builder
	e.OnEvent = func(ev Event) {
		mu.Lock()
		defer mu.Unlock()
		if ev.FlowRun != nil {
			journal.WriteString(ev.FlowRun.Error)
		}
	}
	sum := specRun(t, e, RunRequest{Devices: []Device{webDev("web-a")}, Secrets: []string{"PIN", "PASSWORD"}})
	fr := sum.Flows[0]
	forms := secretForms([]string{pin, secretPassword})
	for _, f := range forms {
		if strings.Contains(fr.Error, f) || strings.Contains(journal.String(), f) {
			t.Fatalf("lỗi lộ bí mật dạng %q: %s", f, fr.Error)
		}
	}
	if !strings.Contains(fr.Error, "(trang: http://app.test/x?pin=***") || fr.FailureClass != FailProduct {
		t.Fatalf("lỗi phải kèm URL đã che: %+v", fr)
	}
	failed := fr.Steps[1]
	if failed.Passed || !strings.HasSuffix(failed.ShotAfter, ".png") || !strings.HasSuffix(failed.Hierarchy, ".txt") {
		t.Fatalf("bước lỗi phải có ảnh lỗi và aria snapshot: %+v", failed)
	}
	aria, _ := os.ReadFile(filepath.Join(sum.Run.OutDir, filepath.FromSlash(failed.Hierarchy)))
	if !strings.Contains(string(aria), "Mật khẩu") || strings.Contains(string(aria), secretPassword) {
		t.Fatalf("aria snapshot = %q", aria)
	}
	if !strings.HasSuffix(fr.Video, "video.webm") {
		t.Fatalf("video = %q", fr.Video)
	}
}

func TestWebTraceIsPrivateSkippedByRedactionAndNeverExported(t *testing.T) {
	e, _ := webEngine(t, &replayRunner{script: failScript("Error: expect(x) failed", "expect", "failed", "")})
	sum := specRun(t, e, RunRequest{Devices: []Device{webDev("web-a")}, Secrets: []string{"PASSWORD"}})
	fr := sum.Flows[0]
	if filepath.Base(fr.Trace) != traceFile {
		t.Fatalf("trace = %q", fr.Trace)
	}
	st, err := os.Stat(fr.Trace)
	if err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("trace phải có quyền 0600: %v %v", st.Mode(), err)
	}
	// Lớp che chữ không đụng file nhị phân: nội dung trace còn nguyên (chỉ giữ khi lỗi, 0600, không xuất).
	if b, _ := os.ReadFile(fr.Trace); !bytes.Contains(b, []byte(secretPassword)) {
		t.Fatal("redactDir không được ghi đè trace.zip")
	}
	if !skipRedact("a/trace.zip") || !skipRedact("x.PNG") || skipRedact("a.txt") {
		t.Fatal("danh sách bỏ qua của lớp che")
	}
	page, _ := os.ReadFile(filepath.Join(sum.Run.OutDir, ReportHTMLFile))
	if !strings.Contains(string(page), "trace: mở thư mục lượt chạy") {
		t.Fatal("evidence.html phải chỉ chỗ xem trace")
	}
	dest := filepath.Join(e.ExportsDir, "run.zip")
	if err := e.ExportRun(sum.Run.ID, dest); err != nil {
		t.Fatal(err)
	}
	for name := range readZip(t, dest) {
		if strings.HasSuffix(name, ".zip") || strings.Contains(name, "trace") {
			t.Fatalf("gói xuất chứa trace: %s", name)
		}
	}
	// Report đọc từ DB: Trace không lưu, được tính lại từ thư mục lượt.
	run, _ := e.Metrics.Run(sum.Run.ID)
	rows, _ := e.Metrics.FlowRuns(sum.Run.ID)
	if rows[0].Trace != "" {
		t.Fatal("Trace không được lưu DB")
	}
	e.AttachTraces(run, rows)
	if rows[0].Trace != fr.Trace {
		t.Fatalf("AttachTraces = %q, muốn %q", rows[0].Trace, fr.Trace)
	}
}

func TestWebCancelStopsRunWithUserStopMessage(t *testing.T) {
	run := &replayRunner{started: make(chan string, 1), hold: make(chan struct{})}
	e, _ := webEngine(t, run)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan *RunSummary, 1)
	go func() {
		sum, err := e.Run(ctx, RunRequest{App: "demo", Flows: []string{"login.spec.ts"}, Devices: []Device{webDev("web-a")}, Repeat: 3})
		if err != nil {
			t.Error(err)
		}
		done <- sum
	}()
	<-run.started
	start := time.Now()
	cancel()
	var sum *RunSummary
	select {
	case sum = <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("huỷ không dừng lượt web")
	}
	if d := time.Since(start); d > time.Second {
		t.Errorf("huỷ mất %v", d)
	}
	if len(sum.Flows) != 1 || sum.Flows[0].Error != userStopError || !sum.Run.Canceled {
		t.Fatalf("sau huỷ: %+v", sum.Flows)
	}
	if h := health(e.Pool, "web-a"); h == HealthBusy {
		t.Fatal("thiết bị web phải được nhả sau huỷ")
	}
}

func TestWebAndMobileDevicesRunConcurrentlyEachWithItsKind(t *testing.T) {
	started := make(chan string, 3)
	all := make(chan struct{})
	run := &replayRunner{started: started, hold: all}
	e, _ := webEngine(t, run)
	e.Execute = func(ctx context.Context, _ core.Driver, cfg *cli.RunConfig, _ []flow.Flow, _ ...func(*executor.RunnerConfig)) (*executor.RunResult, error) {
		started <- cfg.Devices[0]
		select {
		case <-all:
		case <-ctx.Done():
		}
		return &executor.RunResult{Status: report.StatusPassed}, nil
	}
	done := make(chan *RunSummary, 1)
	go func() {
		sum, err := e.Run(context.Background(), RunRequest{App: "demo", Devices: []Device{twoDevices[0], webDev("web-a"), webDev("web-b")}})
		if err != nil {
			t.Error(err)
		}
		done <- sum
	}()
	seen := map[string]bool{}
	for len(seen) < 3 {
		select {
		case id := <-started:
			seen[id] = true
		case <-time.After(5 * time.Second):
			t.Fatalf("ba thiết bị phải chạy cùng lúc, mới bắt đầu: %v", seen)
		}
	}
	close(all)
	sum := <-done
	got := map[string]string{}
	for _, f := range sum.Flows {
		got[f.DeviceID] = f.Flow
	}
	if len(sum.Flows) != 3 || got["emu-1"] != "01_login.yaml" || got["web-a"] != "login.spec.ts" || got["web-b"] != "login.spec.ts" {
		t.Fatalf("mỗi thiết bị chỉ chạy flow cùng loại: %+v", got)
	}
}

func jpegBytes(t *testing.T, c color.Color) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 4, 4))
	for x := 0; x < 4; x++ {
		for y := 0; y < 4; y++ {
			img.Set(x, y, c)
		}
	}
	var b bytes.Buffer
	if err := jpeg.Encode(&b, img, nil); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

// Thiết bị đã có phiên ấm trước lượt: lượt web bỏ phiên đó, và live view đọc ảnh của lượt (không phải trang ấm).
func TestLockForRunDropsWarmSessionAndPeekShowsRunFrames(t *testing.T) {
	frame := jpegBytes(t, color.RGBA{R: 200, A: 255})
	run := &replayRunner{started: make(chan string, 1), hold: make(chan struct{}),
		script: func(t *testing.T, job pw.Job) ([]pw.Event, pw.Result) {
			writeArtifact(t, filepath.Join(job.LiveDir, "live-0.jpg"), frame)
			return nil, pw.Result{Ended: true, Status: "passed"}
		}}
	e, _ := webEngine(t, run)
	var closed atomic.Int32
	e.Pool.OpenWeb = func(context.Context, Device) (DeviceDriver, func(), error) {
		return webStub{}, func() { closed.Add(1) }, nil
	}
	dev := webDev("web-a")
	if err := e.Pool.Run(context.Background(), dev, noop); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		if _, err := e.Run(context.Background(), RunRequest{App: "demo", Flows: []string{"login.spec.ts"}, Devices: []Device{dev}}); err != nil {
			t.Error(err)
		}
	}()
	<-run.started
	if closed.Load() != 1 {
		t.Fatalf("phiên ấm phải bị đóng khi lượt web giữ khoá (đóng %d lần)", closed.Load())
	}
	var got []byte
	busy, err := e.Pool.Peek(context.Background(), dev, false, func(d DeviceDriver) error {
		var err error
		got, err = d.Screenshot()
		return err
	})
	if err != nil || !busy || !bytes.Equal(got, frame) {
		t.Fatalf("Peek giữa lượt web = busy %v, %d byte, %v", busy, len(got), err)
	}
	if health(e.Pool, dev.ID) != HealthBusy {
		t.Fatal("thiết bị phải báo bận trong lượt")
	}
	close(run.hold)
	<-done
	if _, err := e.Pool.Peek(context.Background(), dev, false, func(DeviceDriver) error { return nil }); err != ErrNoWarmDriver {
		t.Fatalf("sau lượt không còn nguồn khung hình của lượt: %v", err)
	}
}

func TestLiveFramesNewestDecodableAndKeepsPreviousOnPartialFile(t *testing.T) {
	dir := t.TempDir()
	lf := &liveFrames{dir: dir}
	if _, err := lf.read(); err != ErrPeekBusy {
		t.Fatalf("chưa có khung hình: %v", err)
	}
	red, green, blue := jpegBytes(t, color.RGBA{R: 255, A: 255}), jpegBytes(t, color.RGBA{G: 255, A: 255}), jpegBytes(t, color.RGBA{B: 255, A: 255})
	base := time.Now().Add(-time.Minute)
	put := func(i int, b []byte, at time.Time) {
		p := filepath.Join(dir, "live-"+string(rune('0'+i))+".jpg")
		writeArtifact(t, p, b)
		if err := os.Chtimes(p, at, at); err != nil {
			t.Fatal(err)
		}
	}
	put(0, red, base)
	put(1, green, base.Add(time.Second))
	if b, _ := lf.read(); !bytes.Equal(b, green) {
		t.Fatal("phải đọc file mới nhất")
	}
	put(2, blue[:len(blue)/2], base.Add(2*time.Second)) // đang ghi dở
	if b, _ := lf.read(); !bytes.Equal(b, green) {
		t.Fatal("file dở: giữ khung hình trước")
	}
	put(1, []byte("hỏng"), base.Add(3*time.Second)) // ghi đè hỏng, mới hơn: vẫn không lùi về khung cũ hơn
	if b, _ := lf.read(); !bytes.Equal(b, green) {
		t.Fatal("không được lùi về khung cũ hơn")
	}
	put(2, blue, base.Add(4*time.Second))
	if b, _ := lf.read(); !bytes.Equal(b, blue) {
		t.Fatal("khung mới đủ phải được đọc")
	}
}

func TestTakeOverRefusedWhileWebRunRuns(t *testing.T) {
	run := &replayRunner{started: make(chan string, 1), hold: make(chan struct{})}
	e, _ := webEngine(t, run)
	dev := webDev("web-a")
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _ = e.Run(context.Background(), RunRequest{App: "demo", Flows: []string{"login.spec.ts"}, Devices: []Device{dev}})
	}()
	<-run.started
	start := time.Now()
	_, err := e.TakeOver(context.Background(), dev, 5*time.Second)
	if apperr.CodeOf(err) != CodeDeviceNotReady || !strings.Contains(err.Error(), "giành quyền giữa lượt không hỗ trợ") {
		t.Fatalf("giành quyền giữa lượt web: %v", err)
	}
	if d := time.Since(start); d > 200*time.Millisecond {
		t.Fatalf("phải từ chối ngay, mất %v", d)
	}
	if e.HoldState(dev.ID) != HoldNone {
		t.Fatal("không được để lại hold")
	}
	close(run.hold)
	<-done
}

// Hai lượt chồng nhau trên cùng hồ sơ: lượt đầu xong thì lượt sau (đang chờ khoá rồi chạy) vẫn khiến giành quyền bị
// từ chối ngay, không tạo hold chờ suông.
func TestTakeOverRefusedWhileOverlappingWebRunsShareProfile(t *testing.T) {
	run := &replayRunner{started: make(chan string, 2), hold: make(chan struct{})}
	e, _ := webEngine(t, run)
	dev := webDev("web-a")
	runOnce := func(done chan struct{}) {
		defer close(done)
		_, _ = e.Run(context.Background(), RunRequest{App: "demo", Flows: []string{"login.spec.ts"}, Devices: []Device{dev}})
	}
	first, second := make(chan struct{}), make(chan struct{})
	go runOnce(first)
	<-run.started
	go runOnce(second)
	deadline := time.Now().Add(2 * time.Second)
	for {
		e.mu.Lock()
		n := e.webRunning[dev.ID]
		e.mu.Unlock()
		if n == 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("lượt thứ hai chưa đăng ký chờ máy (đếm %d)", n)
		}
		time.Sleep(5 * time.Millisecond)
	}
	run.hold <- struct{}{} // lượt đầu xong; lượt sau giữ khoá
	<-first
	<-run.started
	start := time.Now()
	_, err := e.TakeOver(context.Background(), dev, time.Second)
	if apperr.CodeOf(err) != CodeDeviceNotReady {
		t.Fatalf("giành quyền khi lượt thứ hai đang chạy: %v", err)
	}
	if d := time.Since(start); d > 200*time.Millisecond {
		t.Fatalf("phải từ chối ngay, mất %v", d)
	}
	if e.HoldState(dev.ID) != HoldNone {
		t.Fatal("không được để lại hold")
	}
	run.hold <- struct{}{}
	<-second
	e.mu.Lock()
	_, left := e.webRunning[dev.ID]
	e.mu.Unlock()
	if left {
		t.Fatal("hết lượt chạy thì máy phải hết bị đánh dấu")
	}
}

// Hold đang chờ (tạo trước khi lượt web đánh dấu máy) nhận lỗi ngay khi lượt giữ được khoá, không chờ tới hết hạn.
func TestPendingHoldIsFailedByWebRun(t *testing.T) {
	e, _ := webEngine(t, nil)
	dev := webDev("web-a")
	locked, release := make(chan struct{}), make(chan struct{})
	go func() {
		_ = e.Pool.Lock(context.Background(), dev, func(context.Context) error { close(locked); <-release; return nil })
	}()
	<-locked
	res := make(chan error, 1)
	go func() {
		_, err := e.TakeOver(context.Background(), dev, 10*time.Second)
		res <- err
	}()
	deadline := time.Now().Add(2 * time.Second)
	for e.HoldState(dev.ID) != HoldPending && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	start := time.Now()
	e.refuseHoldForWebRun(dev.ID)
	select {
	case err := <-res:
		if apperr.CodeOf(err) != CodeDeviceNotReady {
			t.Fatalf("hold đang chờ: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("hold đang chờ không được trả lỗi")
	}
	if d := time.Since(start); d > 200*time.Millisecond {
		t.Fatalf("trả lỗi mất %v", d)
	}
	close(release)
	if e.HoldState(dev.ID) != HoldNone {
		t.Fatal("hold phải được bỏ")
	}
}

// TakeOver chạy đua với lượt web bắt đầu: kết quả là từ chối ngay, hoặc giữ được máy rảnh trước khi lượt giữ khoá (lượt
// chờ tới khi trả máy); không bao giờ là chờ hết hạn.
func TestTakeOverRaceWithWebRunNeverWaitsOut(t *testing.T) {
	e, _ := webEngine(t, &replayRunner{script: func(*testing.T, pw.Job) ([]pw.Event, pw.Result) {
		time.Sleep(5 * time.Millisecond)
		return nil, pw.Result{Ended: true, Status: "passed"}
	}})
	e.Pool.OpenWeb = func(context.Context, Device) (DeviceDriver, func(), error) { return webStub{}, func() {}, nil }
	dev := webDev("web-a")
	refused, held := 0, 0
	for i := 0; i < 40; i++ {
		done := make(chan struct{})
		go func() {
			defer close(done)
			_, _ = e.Run(context.Background(), RunRequest{App: "demo", Flows: []string{"login.spec.ts"}, Devices: []Device{dev}})
		}()
		time.Sleep(time.Duration(i) * 250 * time.Microsecond) // trải đều thời điểm giành quyền so với lúc lượt bắt đầu
		start := time.Now()
		_, err := e.TakeOver(context.Background(), dev, 3*time.Second)
		if d := time.Since(start); d > 1500*time.Millisecond {
			t.Fatalf("lần %d: TakeOver chờ %v (%v)", i, d, err)
		}
		switch apperr.CodeOf(err) {
		case "":
			held++
			e.HandBack(dev.ID)
		case CodeDeviceNotReady:
			refused++
		default:
			t.Fatalf("lần %d: %v", i, err)
		}
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			t.Fatalf("lần %d: lượt web không xong", i)
		}
	}
	t.Logf("từ chối %d, giữ máy rảnh %d", refused, held)
}

func TestSecretBearingRunNeedsChromiumFamilyProfile(t *testing.T) {
	e, _ := webEngine(t, &replayRunner{})
	plain := "import { test, step } from './chatqa';\ntest('x', async ({ page }) => {\n  await step('a', async () => { await page.goto('/'); });\n});\n"
	if err := os.WriteFile(filepath.Join(e.Flows.Root, "demo", "plain.spec.ts"), []byte(plain), 0o644); err != nil {
		t.Fatal(err)
	}
	ff := webDev("web-ff")
	if err := e.CheckRun(RunRequest{App: "demo", Flows: []string{"plain.spec.ts"}, Devices: []Device{ff}, Secrets: []string{"PASSWORD"}}); apperr.CodeOf(err) != apperr.CodeInvalid {
		t.Fatalf("lượt có secrets trên firefox: %v", err)
	}
	// Spec dùng process.env.PASSWORD (tên trong kho bí mật) cũng là lượt mang bí mật.
	if _, err := e.Run(context.Background(), RunRequest{App: "demo", Flows: []string{"login.spec.ts"}, Devices: []Device{ff}}); apperr.CodeOf(err) != apperr.CodeInvalid {
		t.Fatalf("spec dùng bí mật trên firefox: %v", err)
	}
	if err := e.CheckRun(RunRequest{App: "demo", Flows: []string{"plain.spec.ts"}, Devices: []Device{ff}}); err != nil {
		t.Fatalf("spec không bí mật trên firefox: %v", err)
	}
	if err := e.CheckRun(RunRequest{App: "demo", Flows: []string{"login.spec.ts"}, Devices: []Device{webDev("web-b")}, Secrets: []string{"PASSWORD"}}); err != nil {
		t.Fatalf("kênh chrome thuộc họ Chromium: %v", err)
	}
}

func TestSpecChecksBeforeAnyDeviceIsLocked(t *testing.T) {
	run := &replayRunner{}
	e, specs := webEngine(t, run)
	write := func(name, body string) {
		if err := os.WriteFile(filepath.Join(e.Flows.Root, "demo", name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	head := "import { test, step } from './chatqa';\ntest('x', async ({ page }) => {\n  await step('a', async () => {\n"
	write("undeclared.spec.ts", head+"    await page.getByLabel('t').fill(process.env.API_TOKEN);\n  });\n});\n")
	write("otp.spec.ts", head+"    await page.getByLabel('t').fill(process.env.OTP);\n  });\n});\n")
	write("literal.spec.ts", head+"    await page.getByLabel('t').fill('"+secretPassword+"');\n  });\n});\n")
	if err := e.Secrets.Set("OTP", "424242"); err != nil {
		t.Fatal(err)
	}
	devs := []Device{webDev("web-a"), webDev("web-b")}
	fe := flowErrors(t, e.CheckRun(RunRequest{App: "demo", Flows: []string{"undeclared.spec.ts"}, Devices: devs}))
	if fe[0].File != "undeclared.spec.ts" || fe[0].Line != 4 {
		t.Fatalf("biến chưa khai báo: %+v", fe)
	}
	if err := e.CheckRun(RunRequest{App: "demo", Flows: []string{"otp.spec.ts"}, Devices: devs}); apperr.CodeOf(err) != CodeEnvMissing {
		t.Fatalf("bí mật có trong kho nhưng lượt không chọn: %v", err)
	}
	if err := e.CheckRun(RunRequest{App: "demo", Flows: []string{"otp.spec.ts"}, Devices: devs, Secrets: []string{"OTP"}}); err != nil {
		t.Fatalf("chọn bí mật OTP: %v", err)
	}
	fe = flowErrors(t, e.CheckRun(RunRequest{App: "demo", Flows: []string{"literal.spec.ts"}, Devices: devs}))
	if fe[0].Line != 4 || strings.Contains(fe.Error(), secretPassword) {
		t.Fatalf("bí mật dạng chữ: %+v", fe)
	}
	// Mỗi bộ host một lần kiểm tra: hai hồ sơ khác baseURL nên hai bộ host.
	specs.mu.Lock()
	hosts := map[string]bool{}
	for _, h := range specs.hosts {
		hosts[strings.Join(h, ",")] = true
	}
	specs.mu.Unlock()
	if !hosts["app.test"] || !hosts["m.app.test"] {
		t.Fatalf("host theo hồ sơ: %v", hosts)
	}
	if len(run.jobs) != 0 {
		t.Fatal("spec lỗi không được tới bộ chạy")
	}
}

func TestNamedFlowWithoutDeviceOfItsKindIsAFailedFlow(t *testing.T) {
	e, specs := webEngine(t, &replayRunner{})
	sum := specRun(t, e, RunRequest{Flows: []string{"01_login.yaml", "login.spec.ts"}, Devices: twoDevices[:1]})
	if len(sum.Flows) != 2 || sum.Run.Failed != 1 || sum.Run.Passed != 1 {
		t.Fatalf("flows = %+v", sum.Flows)
	}
	var orphan FlowRun
	for _, f := range sum.Flows {
		if f.Flow == "login.spec.ts" {
			orphan = f
		}
	}
	if orphan.Passed || orphan.FailureClass != FailEnvironment || orphan.Platform != PlatformWeb ||
		!strings.Contains(orphan.Error, "không có thiết bị cho loại flow này") {
		t.Fatalf("flow web không có máy = %+v", orphan)
	}
	if len(specs.hosts) != 0 {
		t.Fatal("không có thiết bị web thì không kiểm tra spec")
	}
	if _, err := e.Run(context.Background(), RunRequest{App: "demo", Flows: []string{"login.spec.ts"}, Devices: twoDevices[:1]}); apperr.CodeOf(err) != apperr.CodeInvalid {
		t.Fatalf("thiết bị không có flow cùng loại: %v", err)
	}
}

func TestWebCheckRunWithoutRuntimeIsRuntimeMissing(t *testing.T) {
	e, _ := webEngine(t, nil)
	e.SpecRunner = nil
	e.Web = nil
	// Không có bộ chạy: kiểm tra spec báo web_runtime_missing trước khi giữ thiết bị.
	if err := e.CheckRun(RunRequest{App: "demo", Devices: []Device{webDev("web-a")}}); apperr.CodeOf(err) != pw.CodeRuntimeMissing {
		t.Fatalf("không có bộ chạy: %v", err)
	}
}
