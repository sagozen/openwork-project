package testengine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io/fs"
	"log"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/devicelab-dev/maestro-runner/pkg/cli"
	"github.com/devicelab-dev/maestro-runner/pkg/core"
	"github.com/devicelab-dev/maestro-runner/pkg/executor"
	"github.com/devicelab-dev/maestro-runner/pkg/flow"
	"github.com/devicelab-dev/maestro-runner/pkg/report"

	"chatqa/internal/docs"
	"chatqa/internal/pw"
	"deskcore/apperr"
)

// RedactionFailedMark: file trong thư mục lượt chạy khi che giá trị bí mật trong báo cáo bị lỗi giữa chừng.
const RedactionFailedMark = ".redaction-failed"

// screenrecord trên Android chỉ giữ 3 phút đầu của một clip.
const androidVideoLimit = 3 * time.Minute

// ExecuteFunc chạy flow trên driver ấm; mặc định cli.ExecuteFlowsWithDriverContext.
type ExecuteFunc func(ctx context.Context, drv core.Driver, cfg *cli.RunConfig, flows []flow.Flow,
	opts ...func(*executor.RunnerConfig)) (*executor.RunResult, error)

// RunRequest: một lệnh chạy (test_run).
type RunRequest struct {
	App     string            `json:"app"`
	Flows   []string          `json:"flows"`   // trống = mọi flow của app
	Devices []Device          `json:"devices"` // mỗi thiết bị một goroutine, song song
	Env     map[string]string `json:"env"`     // biến thường (vd MEXPRESS_APP_ID)
	Secrets []string          `json:"secrets"` // tên biến lấy từ kho bí mật (vd USERNAME, PASSWORD)
	Repeat  int               `json:"repeat"`  // số lần lặp cả bộ flow; mặc định 1
	Record  string            `json:"record"`  // "" | "always" | "on-failure"
	// Artifacts: ảnh/cây UI theo bước: "" (= on-failure) | "always" | "on-failure" | "never".
	Artifacts string        `json:"artifacts,omitempty"`
	Timeout   time.Duration `json:"timeout"` // hạn mỗi flow; mặc định 10 phút
	Label     string        `json:"label"`   // bản app đang thử (so sánh bản cũ/mới), ghi vào lượt chạy
	// TypingFrequency: tốc độ gõ của inputText (phím/giây); 0 = mặc định theo nền tảng (iOS 5, Android 10, xem typingFrequency).
	TypingFrequency int `json:"typingFrequency"`
}

// RunSummary: kết quả một lượt chạy.
type RunSummary struct {
	Run      RunRecord `json:"run"`
	Flows    []FlowRun `json:"flows"`
	Redacted int       `json:"redacted"` // số chỗ giá trị bí mật bị che trong file báo cáo
}

// Event: tiến độ gửi lên UI (timeline lượt chạy).
type Event struct {
	At        time.Time `json:"at"` // engine đặt lúc phát
	RunID     string    `json:"runId"`
	Kind      string    `json:"kind"` // run_start | flow_start | step | flow_end | device_error | run_end
	DeviceID  string    `json:"deviceId,omitempty"`
	Flow      string    `json:"flow,omitempty"`
	Iteration int       `json:"iteration,omitempty"`
	Step      *StepRun  `json:"step,omitempty"`
	FlowRun   *FlowRun  `json:"flowRun,omitempty"`
	Error     string    `json:"error,omitempty"`
}

// Engine: chạy flow trên thiết bị cục bộ và ghi số đo.
type Engine struct {
	Home       *Home
	Web        *Web // bộ chạy trình duyệt cho thiết bị DriverPlaywright; nil = không có thiết bị web
	Pool       *Pool
	Flows      *FlowStore
	Docs       *docs.Store // tài liệu nghiệp vụ theo app (<data dir>/docs): nguồn của biên dịch theo mã yêu cầu
	Preflight  *Preflight
	Secrets    Secrets
	Metrics    *Metrics
	RunsDir    string
	GitDiffDir string // nơi lưu file diff của test_git_diff
	ExportsDir string // nơi ghi gói xuất (zip lượt chạy, JSON lịch sử)
	Execute    ExecuteFunc
	OnEvent    func(Event)
	LLM        LLMCall // gọi Claude qua Worker; nil = biên dịch/sửa báo ai_unavailable
	Budget     BudgetGate
	HungGrace  time.Duration // 0 = 10 giây
	TokenCap   int           // trần token mỗi flow cho một lần biên dịch/sửa; 0 = DefaultFlowTokenCap
	now        func() time.Time

	// Launch chạy lệnh mở thư mục/file của hệ điều hành (OpenRunFolder, OpenRunReport...); nil = chạy thật.
	// Test thay để không bật cửa sổ Finder/Explorer.
	Launch func(*exec.Cmd) error

	// SpecRunner chạy một lượt flow web; nil = pw.Runner trên bộ chạy của Web. Test thay bằng bộ phát lại báo cáo.
	SpecRunner SpecRunner
	// WebProfiles liệt kê mọi hồ sơ trình duyệt (tower đặt): host được phép khi kiểm tra spec không gắn thiết bị.
	WebProfiles func() ([]pw.Profile, error)

	mu         sync.Mutex
	active     map[string]context.CancelFunc
	devCancel  map[string]context.CancelCauseFunc // thiết bị đang chạy -> huỷ riêng thiết bị đó
	holds      map[string]*hold                   // máy người dùng đang giữ (take over)
	webRunning map[string]int                     // số lượt flow đang chạy/chờ trên thiết bị web: >0 thì giành quyền bị từ chối
	llmOnce    sync.Once
	llmc       *llmClient
	journals   map[string]*runJournal // lượt đang chạy -> run.jsonl
}

// ErrDeviceDisconnected: nguyên nhân huỷ khi thiết bị bị rút giữa lượt chạy (chỉ thiết bị đó hỏng, lỗi môi trường).
var ErrDeviceDisconnected = errors.New("thiết bị đã ngắt kết nối")

// CancelDevice huỷ phần việc đang chạy trên một thiết bị với nguyên nhân cause (và thôi giữ máy nếu người dùng
// đang giữ); false nếu thiết bị không chạy gì.
func (e *Engine) CancelDevice(id string, cause error) bool {
	e.HandBack(id)
	e.mu.Lock()
	cancel, ok := e.devCancel[id]
	e.mu.Unlock()
	if ok {
		cancel(cause)
	}
	return ok
}

// NewEngine: engine với thư mục dữ liệu của ChatQASoftware (đã gọi SetupProcess với dataDir/maestro-runner).
func NewEngine(dataDir string, pool *Pool, metrics *Metrics, secrets Secrets) *Engine {
	runsDir := filepath.Join(dataDir, "runs")
	if pool != nil {
		pool.ManualDir = runsDir
	}
	e := &Engine{
		Home:       &Home{Dir: filepath.Join(dataDir, "maestro-runner")},
		Pool:       pool,
		Flows:      NewFlowStore(filepath.Join(dataDir, "flows")),
		Docs:       docs.NewStore(filepath.Join(dataDir, "docs")),
		Preflight:  NewPreflight(""),
		Secrets:    secrets,
		Metrics:    metrics,
		RunsDir:    runsDir,
		GitDiffDir: filepath.Join(dataDir, "git-impact"),
		ExportsDir: filepath.Join(dataDir, "exports"),
		Execute:    cli.ExecuteFlowsWithDriverContext,
		now:        time.Now,
		active:     map[string]context.CancelFunc{},
		devCancel:  map[string]context.CancelCauseFunc{},
		holds:      map[string]*hold{},
		webRunning: map[string]int{},
		journals:   map[string]*runJournal{},
	}
	e.Flows.Specs = engineSpecs{e}
	return e
}

// emit đặt giờ cho sự kiện, ghi vào run.jsonl của lượt (nếu đang mở) rồi gửi lên UI.
func (e *Engine) emit(ev Event) {
	if ev.At.IsZero() {
		ev.At = e.clock()
	}
	e.mu.Lock()
	j := e.journals[ev.RunID]
	e.mu.Unlock()
	if j != nil {
		j.write(ev)
	}
	if e.OnEvent != nil {
		e.OnEvent(ev)
	}
}

func (e *Engine) clock() time.Time {
	if e.now == nil {
		return time.Now()
	}
	return e.now()
}

// SecretValues: mọi giá trị bí mật hiện có trong kho, chỉ để che nội dung ghi sổ.
func (e *Engine) SecretValues() []string {
	if e.Secrets == nil {
		return nil
	}
	names, err := e.Secrets.Names()
	if err != nil {
		return nil
	}
	var out []string
	for _, n := range names {
		if v, err := e.Secrets.Get(n); err == nil && v != "" {
			out = append(out, v)
		}
	}
	return out
}

// Run chạy flow trên các thiết bị và chờ xong. Flow sai và biến bí mật thiếu bị từ chối trước khi giữ
// bất kỳ thiết bị nào. Hủy ctx (hoặc Stop/StopAll) dừng mọi thiết bị giữa các bước. Mỗi thiết bị chỉ nhận flow
// cùng loại (YAML cho điện thoại, .spec.ts cho hồ sơ trình duyệt); flow được gọi tên mà không có thiết bị cùng loại
// được ghi thành flow lỗi môi trường, không bao giờ bị bỏ qua.
func (e *Engine) Run(ctx context.Context, req RunRequest) (*RunSummary, error) {
	if len(req.Devices) == 0 {
		return nil, apperr.New(apperr.CodeInvalid, "chưa chọn thiết bị")
	}
	seen := map[string]bool{}
	for _, d := range req.Devices {
		if err := ValidateDevice(d); err != nil {
			return nil, err
		}
		if seen[d.ID] {
			return nil, apperr.New(apperr.CodeInvalid, "thiết bị "+d.ID+" bị chọn hai lần")
		}
		seen[d.ID] = true
	}
	if req.Repeat <= 0 {
		req.Repeat = 1
	}
	if req.Repeat > 100 {
		return nil, apperr.New(apperr.CodeInvalid, "lặp tối đa 100 lần")
	}
	if req.Record != "" && req.Record != "always" && req.Record != "on-failure" {
		return nil, apperr.New(apperr.CodeInvalid, "record chỉ nhận always hoặc on-failure")
	}
	if err := ValidateArtifacts(req.Artifacts); err != nil {
		return nil, err
	}
	if err := ValidateTypingFrequency(req.TypingFrequency); err != nil {
		return nil, err
	}
	if req.Timeout <= 0 {
		req.Timeout = 10 * time.Minute
	}
	plan, err := e.prepare(ctx, req)
	if err != nil {
		return nil, err
	}
	secretValues := plan.secrets

	runID, outDir, err := e.newRunDir()
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	e.mu.Lock()
	e.active[runID] = cancel
	e.mu.Unlock()
	defer func() {
		e.mu.Lock()
		delete(e.active, runID)
		e.mu.Unlock()
	}()

	mode, _ := artifactMode(req.Artifacts)
	rec := RunRecord{ID: runID, App: req.App, StartedAt: e.now(), Devices: len(req.Devices), Repeat: req.Repeat, OutDir: outDir,
		Label: req.Label, Artifacts: mode}
	journal, jerr := openRunJournal(outDir, secretValues)
	if jerr == nil {
		e.mu.Lock()
		if e.journals == nil {
			e.journals = map[string]*runJournal{}
		}
		e.journals[runID] = journal
		e.mu.Unlock()
		defer func() {
			e.mu.Lock()
			delete(e.journals, runID)
			e.mu.Unlock()
			_ = journal.close()
		}()
	} else {
		log.Printf("lượt %s: không mở được %s: %v", runID, RunJournalFile, jerr) // lượt vẫn chạy, chỉ thiếu nhật ký sự kiện
	}
	e.emit(Event{RunID: runID, Kind: "run_start"})
	cpu0 := cpuTime()

	var mu sync.Mutex
	var results []FlowRun
	var wg sync.WaitGroup
	for _, dev := range req.Devices {
		wg.Add(1)
		dctx, dcancel := context.WithCancelCause(ctx)
		e.mu.Lock()
		e.devCancel[dev.ID] = dcancel
		e.mu.Unlock()
		go func(dev Device) {
			defer wg.Done()
			defer func() {
				e.mu.Lock()
				delete(e.devCancel, dev.ID)
				e.mu.Unlock()
				dcancel(nil)
			}()
			var runs []FlowRun
			if isWebDevice(dev) {
				runs = e.runWebDevice(dctx, runID, outDir, dev, plan.web, secretValues, req)
			} else {
				runs = e.runDevice(dctx, runID, outDir, dev, plan.set.YAML, plan.byPlatform[dev.Platform], secretValues, req)
			}
			mu.Lock()
			results = append(results, runs...)
			mu.Unlock()
		}(dev)
	}
	wg.Wait()
	results = append(results, e.orphanRuns(runID, plan.set.Orphans, req)...)

	redacted, scanErr := redactDir(outDir, secretValues)
	if scanErr != nil {
		// Che chưa xong: đánh dấu để lượt này không bao giờ được xuất hay sinh báo cáo cục bộ (ExportRun, RunReport kiểm dấu này).
		_ = os.WriteFile(filepath.Join(outDir, RedactionFailedMark), []byte(scanErr.Error()), 0o644)
	}
	rec.FinishedAt = e.now()
	rec.Canceled = ctx.Err() != nil
	rec.MaxRSSMB = maxRSSMB()
	rec.CPUMs = cpuTime() - cpu0
	sort.Slice(results, func(i, j int) bool {
		a, b := results[i], results[j]
		if a.DeviceID != b.DeviceID {
			return a.DeviceID < b.DeviceID
		}
		if a.Iteration != b.Iteration {
			return a.Iteration < b.Iteration
		}
		return a.Flow < b.Flow
	})
	for _, r := range results {
		if r.Passed {
			rec.Passed++
		} else {
			rec.Failed++
		}
	}
	sum := &RunSummary{Run: rec, Flows: results, Redacted: redacted}
	var saveErr error
	if e.Metrics != nil {
		saveErr = e.Metrics.Save(rec, results)
	}
	if scanErr == nil {
		// Báo cáo cục bộ (evidence.html, summary.json) trong thư mục lượt; lỗi chỉ ghi log, mở báo cáo sẽ sinh lại từ DB.
		if err := writeRunReport(rec, results, secretValues); err != nil {
			log.Printf("lượt %s: không ghi được báo cáo cục bộ: %v", runID, err)
		}
	}
	e.emit(Event{RunID: runID, Kind: "run_end"})
	return sum, errors.Join(saveErr, scanErr)
}

// runPlan: mọi thứ một lượt chạy cần, đã kiểm tra xong trước khi giữ thiết bị nào.
type runPlan struct {
	set        FlowSet
	secrets    []string                     // giá trị bí mật của lượt (để che)
	byPlatform map[string]map[string]string // env đã gộp cho từng nền tảng điện thoại
	web        webPlan
}

// prepare nạp flow theo loại thiết bị, kiểm tra env, bí mật và spec (an toàn, biến thiếu, hồ sơ được mang bí mật).
// Dùng chung cho Run và CheckRun, không chạm thiết bị.
func (e *Engine) prepare(ctx context.Context, req RunRequest) (*runPlan, error) {
	set, err := e.Flows.LoadSet(req.App, req.Flows, DeviceKinds(req.Devices))
	if err != nil {
		return nil, err
	}
	var mobile []Device
	for _, d := range req.Devices {
		kind := PlatformKind(d.Platform)
		if !set.has(kind) {
			return nil, apperr.New(apperr.CodeInvalid, fmt.Sprintf("thiết bị %s (%s) không có flow cùng loại để chạy", d.ID, kind))
		}
		if kind == KindMobile {
			mobile = append(mobile, d)
		}
	}
	env, secretValues, err := e.env(req)
	if err != nil {
		return nil, err
	}
	byPlatform, err := e.checkEnv(req.App, set.YAML, mobile, env)
	if err != nil {
		return nil, err
	}
	web, err := e.checkWeb(ctx, req, set.Specs, env)
	if err != nil {
		return nil, err
	}
	return &runPlan{set: set, secrets: secretValues, byPlatform: byPlatform, web: web}, nil
}

// env gộp env truyền vào lượt và bí mật đã chọn. Tên dành riêng trong env chỉ bị từ chối khi lượt có máy web (biến đi
// vào tiến trình Node); lượt chỉ có điện thoại chạy trong app nên vẫn nhận như trước.
func (e *Engine) env(req RunRequest) (map[string]string, []string, error) {
	check := varNameFormat
	if slices.ContainsFunc(req.Devices, func(d Device) bool { return PlatformKind(d.Platform) == KindWeb }) {
		check = ValidVarName
	}
	env := map[string]string{}
	for k, v := range req.Env {
		if err := check(k); err != nil {
			return nil, nil, err
		}
		env[k] = v
	}
	var values []string
	for _, name := range req.Secrets {
		if e.Secrets == nil || IsReservedSecret(name) {
			return nil, nil, SecretMissingError(name, e.Secrets)
		}
		v, err := e.Secrets.Get(name)
		if apperr.CodeOf(err) == CodeSecretMissing {
			return nil, nil, SecretMissingError(name, e.Secrets)
		}
		if err != nil {
			return nil, nil, err
		}
		env[name] = v
		values = append(values, v)
	}
	return env, values, nil
}

func (e *Engine) newRunDir() (string, string, error) {
	base := e.now().Format("060102-150405")
	for i := 0; i < 100; i++ {
		id := base
		if i > 0 {
			id = fmt.Sprintf("%s-%d", base, i)
		}
		dir := filepath.Join(e.RunsDir, id)
		if err := os.MkdirAll(e.RunsDir, 0o755); err != nil {
			return "", "", err
		}
		if err := os.Mkdir(dir, 0o755); err == nil {
			return id, dir, nil
		} else if !errors.Is(err, fs.ErrExist) {
			return "", "", err
		}
	}
	return "", "", errors.New("không tạo được thư mục lượt chạy")
}

// deviceFailed: thiết bị không chạy được (preflight, bộ chạy, driver): mọi flow × lặp của nó thành lỗi môi trường.
// Lượt đã bị dừng trước khi thiết bị bắt đầu thì không phải lỗi (trả nil), trừ khi thiết bị bị rút.
func (e *Engine) deviceFailed(ctx context.Context, runID string, dev Device, names []string, err error, secrets []string,
	req RunRequest) []FlowRun {
	msg := redact(err.Error(), secrets)
	if ctx.Err() != nil {
		if !errors.Is(context.Cause(ctx), ErrDeviceDisconnected) {
			return nil
		}
		msg = "thiết bị đã ngắt kết nối"
	}
	e.emit(Event{RunID: runID, Kind: "device_error", DeviceID: dev.ID, Error: msg})
	var out []FlowRun
	for it := 1; it <= req.Repeat; it++ {
		for _, n := range names {
			out = append(out, FlowRun{RunID: runID, DeviceID: dev.ID, Platform: dev.Platform, Driver: dev.Driver,
				Flow: n, Iteration: it, DeviceCount: len(req.Devices), FailureClass: FailEnvironment, Error: msg})
		}
	}
	return out
}

// runDevice: preflight, bộ driver, rồi mọi flow × lặp trên driver ấm của một thiết bị.
func (e *Engine) runDevice(ctx context.Context, runID, outDir string, dev Device, flows []flow.Flow,
	env map[string]string, secrets []string, req RunRequest) []FlowRun {
	fail := func(err error) []FlowRun {
		names := make([]string, len(flows))
		for i, f := range flows {
			names[i] = e.flowName(req.App, f)
		}
		return e.deviceFailed(ctx, runID, dev, names, err, secrets, req)
	}
	if e.Preflight != nil {
		if err := e.Preflight.Check(ctx, dev); err != nil {
			return fail(err)
		}
	}
	if err := e.EnsureRuntime(ctx, dev); err != nil {
		return fail(err)
	}

	var out []FlowRun
	err := e.Pool.Run(ctx, dev, func(ctx context.Context, sess Session) error {
		if _, err := maestroOf(sess.Driver); err != nil {
			return err
		}
		first := true
		for it := 1; it <= req.Repeat; it++ {
			for _, f := range flows {
				if ctx.Err() != nil {
					return nil
				}
				e.pauseIfHeld(ctx, runID, dev, sess.Driver, nil) // người dùng giữ máy giữa hai flow
				if ctx.Err() != nil {
					return nil
				}
				fr, err := e.runFlow(ctx, sess.Driver, runID, outDir, dev, f, it, env, secrets, req)
				if err == nil && ctx.Err() == nil && !fr.Passed && isAgentFault(fr.Error) {
					// Agent trên máy tự khởi động lại giữa lệnh (không gửi lại lệnh đang chạy): thử lại cả flow một lần.
					// Vẫn lỗi thì báo rõ đây là lỗi hạ tầng, không phải flow sai.
					if retry, rerr := e.runFlow(ctx, sess.Driver, runID, outDir, dev, f, it, env, secrets, req); rerr != nil || retry.Passed || !isAgentFault(retry.Error) {
						fr, err = retry, rerr
					} else {
						fr = retry
						fr.FailureClass, fr.Error = FailEnvironment, "lỗi hạ tầng (agent trên máy), đã thử lại 1 lần: "+fr.Error
					}
				}
				if first && sess.Cold {
					fr.Cold, fr.DriverStartMs = true, sess.StartMs
				}
				first = false
				out = append(out, fr)
				e.emit(Event{RunID: runID, Kind: "flow_end", DeviceID: dev.ID, Flow: fr.Flow, Iteration: it, FlowRun: &fr})
				if err != nil {
					return err // driver hỏng: pool dọn driver, các flow còn lại không chạy
				}
			}
		}
		return nil
	})
	if err != nil && len(out) == 0 {
		return fail(err)
	}
	return out
}

func (e *Engine) flowName(app string, f flow.Flow) string {
	if dir, err := e.Flows.appDir(app); err == nil {
		return relName(dir, f.SourcePath)
	}
	return filepath.Base(f.SourcePath)
}

func (e *Engine) runFlow(ctx context.Context, drv DeviceDriver, runID, outDir string, dev Device, f flow.Flow, it int,
	env map[string]string, secrets []string, req RunRequest) (FlowRun, error) {
	name := e.flowName(req.App, f)
	fr := FlowRun{RunID: runID, DeviceID: dev.ID, Platform: dev.Platform, Driver: dev.Driver, Flow: name,
		Iteration: it, DeviceCount: len(req.Devices)}
	e.emit(Event{RunID: runID, Kind: "flow_start", DeviceID: dev.ID, Flow: name, Iteration: it})

	dir := flowOutDir(outDir, dev.ID, it, name)
	typing := typingFrequency(dev.Platform, req.TypingFrequency)
	_, artifacts := artifactMode(req.Artifacts)
	cfg := &cli.RunConfig{Platform: dev.Platform, Driver: dev.Driver, Devices: []string{dev.ID}, TeamID: dev.TeamID,
		Env: env, OutputDir: dir, Record: req.Record != "", RecordMode: req.Record, TypingFrequency: typing, Artifacts: artifacts}
	// typingFrequency trong chính flow thắng cờ toàn cục (executor áp theo thứ tự đó), nên báo cáo ghi giá trị thực dùng.
	if f.Config.TypingFrequency != nil {
		typing = *f.Config.TypingFrequency
	}
	fr.TypingFrequency = typing
	var stepsMu sync.Mutex
	var pausedMs atomic.Int64 // thời gian người dùng giữ máy giữa các bước, không tính vào thời lượng flow
	finished := false         // sau khi trả kết quả, callback muộn của lệnh driver treo bị bỏ qua
	addStep := func(s StepRun) {
		s.Desc, s.Error = redact(s.Desc, secrets), redact(s.Error, secrets)
		s.Command = commandOf(s.Desc)
		stepsMu.Lock()
		if finished {
			stepsMu.Unlock()
			return
		}
		fr.Steps = append(fr.Steps, s)
		stepsMu.Unlock()
		e.emit(Event{RunID: runID, Kind: "step", DeviceID: dev.ID, Flow: name, Iteration: it, Step: &s})
	}
	// Hạn mỗi flow ngừng đếm trong lúc người dùng giữ máy (nhập 2FA không làm flow quá hạn).
	fctx, cancel := context.WithCancel(ctx)
	defer cancel()
	clock := newFlowClock(req.Timeout, cancel)
	defer clock.stop()
	start := e.now()
	type outcome struct {
		res *executor.RunResult
		err error
	}
	done := make(chan outcome, 1)
	mdrv, _ := maestroOf(drv) // runDevice đã kiểm tra: flow YAML chỉ chạy trên điện thoại
	go func() {
		res, err := e.Execute(fctx, mdrv, cfg, []flow.Flow{f}, func(rc *executor.RunnerConfig) {
			rc.OnFlowStart, rc.OnFlowEnd, rc.OnNestedFlowStart, rc.Pauser = nil, nil, nil, nil
			rc.OnStepComplete = func(idx int, desc string, passed bool, ms int64, errMsg string) {
				addStep(StepRun{Index: idx, Desc: desc, Passed: passed, DurationMs: ms, Error: errMsg})
				stepsMu.Lock()
				late := finished
				stepsMu.Unlock()
				if late { // lệnh treo trả muộn sau khi lượt đã bỏ driver: không được giành máy
					return
				}
				// Gọi trên goroutine của flow ngay sau mỗi bước: dừng ở đây là "dừng sau bước hiện tại".
				pausedMs.Add(e.pauseIfHeld(fctx, runID, dev, drv, clock).Milliseconds())
			}
			rc.OnNestedStep = func(depth int, desc string, passed bool, ms int64, errMsg string) {
				addStep(StepRun{Index: -1, Depth: depth, Desc: desc, Passed: passed, DurationMs: ms, Error: errMsg})
			}
		})
		// Executor gắn context của flow vào driver và không gỡ ra; flow xong thì context đó bị hủy, nên live view và
		// công cụ đọc màn hình gọi driver ấm sau đó sẽ hỏng ngay ("aborted: context canceled").
		mdrv.SetContext(context.Background())
		done <- outcome{res, err}
	}()
	// Lệnh driver không nhận context: hết hạn hoặc bị dừng mà quá hungGrace vẫn chưa trả thì coi driver treo,
	// trả về ngay (nhả khoá thiết bị) và để pool dọn driver; lệnh treo kết thúc khi phiên trên máy bị dọn.
	var out outcome
	hung := false
	select {
	case out = <-done:
	case <-fctx.Done():
		select {
		case out = <-done:
		case <-time.After(e.hungGrace()):
			hung = true
		}
	}
	stepsMu.Lock()
	finished = true
	stepsMu.Unlock()
	fr.DurationMs = e.now().Sub(start).Milliseconds() - pausedMs.Load()
	if !hung {
		// Runner đã ghi xong báo cáo của flow: bổ sung evidence. Đọc hỏng thì giữ bước như callback đã báo.
		if fd, err := loadFlowDetail(dir); err == nil {
			enrichSteps(fr.Steps, fd, dir, outDir, secrets)
		}
	}

	disconnected := errors.Is(context.Cause(ctx), ErrDeviceDisconnected)
	switch {
	case disconnected:
		fr.FailureClass, fr.Error = FailEnvironment, "thiết bị đã ngắt kết nối"
		return fr, fmt.Errorf("%s: %w", dev.ID, ErrDriverBroken)
	case hung:
		fr.FailureClass, fr.Error = FailEnvironment, "lệnh trên thiết bị không phản hồi"
		return fr, fmt.Errorf("%s: driver treo: %w", dev.ID, ErrDriverBroken)
	case fctx.Err() != nil && ctx.Err() == nil:
		// Quá hạn mỗi flow: lệnh đã trả nhưng flow không xong kịp; driver có thể đã kẹt.
		fr.FailureClass, fr.Error = FailEnvironment, "quá hạn "+req.Timeout.String()
		if !e.driverAlive(drv) {
			return fr, fmt.Errorf("%s: quá hạn và driver không phản hồi: %w", dev.ID, ErrDriverBroken)
		}
	case ctx.Err() != nil:
		fr.FailureClass, fr.Error = FailEnvironment, userStopError
	case out.err != nil:
		// Lỗi trước khi chạy (vd không ghi được báo cáo): chỉ bỏ driver khi driver thật sự không phản hồi.
		fr.FailureClass, fr.Error = FailEnvironment, redact(out.err.Error(), secrets)
		if !e.driverAlive(drv) {
			return fr, fmt.Errorf("%s: %w", fr.Error, ErrDriverBroken)
		}
	default:
		fr.Passed = out.res.Status == report.StatusPassed
		if !fr.Passed {
			fr.Error = redact(firstFlowError(out.res), secrets)
			fr.FailureClass = classify(fr.Steps, fr.Error)
			// Executor không báo lỗi khi agent/phiên chết: flow chỉ "không đạt". Hỏi driver một câu để phân biệt.
			if !e.driverAlive(drv) {
				fr.FailureClass = FailEnvironment
				fr.Video = findVideo(dir)
				return fr, fmt.Errorf("%s: driver không phản hồi sau flow lỗi: %w", dev.ID, ErrDriverBroken)
			}
		}
	}
	fr.Video = findVideo(dir)
	fr.VideoTruncated = fr.Video != "" && dev.Platform == PlatformAndroid && fr.DurationMs > androidVideoLimit.Milliseconds()
	return fr, nil
}

// userStopError: lỗi của flow bị dừng giữa chừng theo lệnh người dùng (Esc, Dừng).
const userStopError = "đã dừng theo lệnh người dùng, không phải lỗi máy hay app; không chạy lại"

// flowOutDir: thư mục báo cáo của một flow trong lượt: <thiết bị>/rNN/<tên flow bỏ đuôi cuối>.
func flowOutDir(outDir, devID string, it int, name string) string {
	return filepath.Join(outDir, safeName(devID), fmt.Sprintf("r%02d", it), strings.TrimSuffix(filepath.Base(name), filepath.Ext(name)))
}

// flowClock: hạn mỗi flow, ngừng đếm khi người dùng giữ máy. Hết hạn thì huỷ context của flow.
type flowClock struct {
	mu    sync.Mutex
	timer *time.Timer
	left  time.Duration
	since time.Time
	fired bool
}

func newFlowClock(d time.Duration, expire func()) *flowClock {
	c := &flowClock{left: d, since: time.Now()}
	c.timer = time.AfterFunc(d, func() {
		c.mu.Lock()
		c.fired = true
		c.mu.Unlock()
		expire()
	})
	return c
}

func (c *flowClock) pause() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.fired && c.timer.Stop() {
		c.left -= time.Since(c.since)
	}
}

func (c *flowClock) resume() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.fired {
		c.since = time.Now()
		c.timer.Reset(max(c.left, 0))
	}
}

func (c *flowClock) stop() { c.timer.Stop() }

// Thời gian chờ thêm sau khi hết hạn/dừng trước khi coi lệnh driver là treo, và hạn của câu hỏi kiểm tra driver.
const (
	defaultHungGrace  = 10 * time.Second
	driverProbeWithin = 15 * time.Second
)

func (e *Engine) hungGrace() time.Duration {
	if e.HungGrace > 0 {
		return e.HungGrace
	}
	return defaultHungGrace
}

// driverAlive hỏi driver cây UI hiện tại; lỗi hoặc không trả lời kịp nghĩa là agent/phiên trên máy đã chết.
func (e *Engine) driverAlive(drv DeviceDriver) bool {
	ch := make(chan error, 1)
	go func() {
		_, err := drv.Hierarchy()
		ch <- err
	}()
	select {
	case err := <-ch:
		return err == nil
	case <-time.After(driverProbeWithin):
		return false
	}
}

func firstFlowError(res *executor.RunResult) string {
	if res == nil {
		return ""
	}
	for _, f := range res.FlowResults {
		if f.Status != report.StatusPassed && f.Error != "" {
			return f.Error
		}
	}
	return "flow không đạt"
}

// classify: bước assert hỏng là lỗi sản phẩm; bước thao tác không tìm thấy phần tử là lỗi tự động hoá;
// lỗi kết nối/driver là môi trường.
// isAgentFault: lỗi do agent trên máy không phản hồi hoặc tự khởi động lại, không do flow.
func isAgentFault(errMsg string) bool {
	low := strings.ToLower(errMsg)
	for _, k := range []string{"agent restarted", "agent did not answer", "agent unreachable"} {
		if strings.Contains(low, k) {
			return true
		}
	}
	return false
}

func classify(steps []StepRun, errMsg string) string {
	low := strings.ToLower(errMsg)
	if isAgentFault(errMsg) {
		return FailEnvironment
	}
	for _, k := range []string{"connection refused", "device offline", "session", "driver", "eof", "broken pipe", "timeout waiting for device"} {
		if strings.Contains(low, k) {
			return FailEnvironment
		}
	}
	for i := len(steps) - 1; i >= 0; i-- {
		if !steps[i].Passed {
			if strings.HasPrefix(steps[i].Command, "assert") {
				return FailProduct
			}
			return FailAutomation
		}
	}
	return FailAutomation
}

func commandOf(desc string) string {
	if i := strings.IndexAny(desc, ": "); i > 0 {
		return desc[:i]
	}
	return desc
}

func findVideo(dir string) string {
	var found string
	_ = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() && strings.EqualFold(filepath.Ext(p), ".mp4") && found == "" {
			found = p
		}
		return nil
	})
	return found
}

func safeName(s string) string {
	return strings.Map(func(r rune) rune {
		if r == '/' || r == '\\' || r == ':' || r == '*' || r == '?' || r == '"' || r == '<' || r == '>' || r == '|' {
			return '_'
		}
		return r
	}, s)
}

// redact thay mọi giá trị bí mật bằng ***: dạng gốc, dạng thoát JSON và dạng thoát HTML (báo cáo HTML/JSON),
// giá trị dài trước để một bí mật chứa bí mật khác không còn sót phần đuôi.
func redact(s string, secrets []string) string {
	for _, v := range secretForms(secrets) {
		s = strings.ReplaceAll(s, v, "***")
	}
	return s
}

// Redact: như redact, cho phần khác của app (kết quả tool gửi cho Claude, client MCP).
func Redact(s string, secrets []string) string { return redact(s, secrets) }

func secretForms(secrets []string) []string {
	seen := map[string]bool{}
	var forms []string
	for _, v := range secrets {
		if v == "" {
			continue
		}
		j, _ := json.Marshal(v)
		h := html.EscapeString(v) // " thành &#34;; báo cáo HTML có thể dùng &quot;
		named := strings.NewReplacer("&#34;", "&quot;", "&#39;", "&apos;").Replace(h)
		// URL của trang web (thanh địa chỉ, link trong aria snapshot, lỗi toHaveURL) mang giá trị đã mã hoá phần trăm,
		// Go viết hoa %2F còn trình duyệt có thể viết thường %2f.
		q, path := url.QueryEscape(v), url.PathEscape(v)
		for _, f := range []string{v, strings.Trim(string(j), `"`), h, named, q, lowerPercent(q), path, lowerPercent(path)} {
			if !seen[f] {
				seen[f] = true
				forms = append(forms, f)
			}
		}
	}
	sort.Slice(forms, func(i, k int) bool { return len(forms[i]) > len(forms[k]) })
	return forms
}

var percentHex = regexp.MustCompile(`%[0-9A-F]{2}`)

// lowerPercent viết thường các mã %XX (%2F thành %2f).
func lowerPercent(s string) string { return percentHex.ReplaceAllStringFunc(s, strings.ToLower) }

// Ảnh và video không chứa chữ gõ vào; mọi file khác của báo cáo đều được quét.
var mediaExt = map[string]bool{".png": true, ".jpg": true, ".jpeg": true, ".gif": true, ".webp": true, ".mp4": true, ".mov": true, ".webm": true}

// binaryExt: file nhị phân của lượt chạy không quét được bằng thay chuỗi (ghi đè làm hỏng file). trace.zip của flow web
// có thể chứa giá trị đã điền: nó chỉ giữ khi flow lỗi, quyền 0600, bị xoá theo hạn giữ lượt và không bao giờ được xuất.
var binaryExt = map[string]bool{".zip": true}

// skipRedact: file không đi qua lớp che chữ (ảnh, video, file nhị phân).
func skipRedact(p string) bool {
	ext := strings.ToLower(filepath.Ext(p))
	return mediaExt[ext] || binaryExt[ext]
}

// redactDir che mọi giá trị bí mật còn sót trong file văn bản của báo cáo (maestro-runner đã che chữ gõ vào,
// đây là lớp chặn cuối). Trả số chỗ đã che.
func redactDir(dir string, secrets []string) (int, error) {
	if len(secrets) == 0 {
		return 0, nil
	}
	total := 0
	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || skipRedact(p) {
			return err
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		s := string(b)
		n := 0
		for _, v := range secretForms(secrets) {
			n += strings.Count(s, v)
			s = strings.ReplaceAll(s, v, "***")
		}
		if n == 0 {
			return nil
		}
		total += n
		return os.WriteFile(p, []byte(s), 0o644)
	})
	return total, err
}

// Stop dừng một lượt chạy (giữa các bước); driver vẫn ấm cho lượt sau.
func (e *Engine) Stop(runID string) bool {
	e.mu.Lock()
	cancel, ok := e.active[runID]
	e.mu.Unlock()
	if ok {
		cancel()
	}
	return ok
}

// StopAll (Esc / Dừng tất cả): hủy mọi lượt và dọn mọi driver, chờ mỗi thiết bị tối đa wait. Trả số lượt đã hủy.
func (e *Engine) StopAll(wait time.Duration) int {
	e.mu.Lock()
	n := len(e.active)
	for _, cancel := range e.active {
		cancel()
	}
	e.mu.Unlock()
	e.releaseHolds()
	e.Pool.CloseAll(wait)
	e.Pool.Reopen()
	return n
}
