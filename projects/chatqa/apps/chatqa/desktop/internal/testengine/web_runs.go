package testengine

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image/jpeg"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"chatqa/internal/pw"
	"deskcore/apperr"
)

// Chạy flow web: mỗi (thiết bị, flow, lần lặp) một tiến trình playwright test riêng (pw.Runner). Thiết bị web giữ khoá
// bằng Pool.LockForRun (bỏ phiên ấm, live view đọc ảnh xoay vòng của lượt), báo cáo NDJSON của reporter thành bước,
// sự kiện và FlowRun giống mobile; ảnh, video và trace được chép vào thư mục lượt trước khi thư mục làm việc bị xoá.

// SpecRunner chạy một lượt playwright test và chuyển từng sự kiện của reporter (pw.Runner là bản thật).
type SpecRunner interface {
	Run(ctx context.Context, job pw.Job, onEvent func(pw.Event)) (pw.Result, error)
}

const traceFile = "trace.zip"

func (e *Engine) specRunner() (SpecRunner, error) {
	if e.SpecRunner != nil {
		return e.SpecRunner, nil
	}
	if e.Web == nil || e.Web.RT == nil {
		return nil, errNoWebRuntime()
	}
	return &pw.Runner{RT: e.Web.RT}, nil
}

// webPlan: phần web của một lượt, đã kiểm tra trước khi giữ thiết bị.
type webPlan struct {
	env   map[string]string // env đã gộp cho nền tảng web (mặc định all + web, env của lượt, bí mật)
	specs []SpecFlow        // đã qua bộ kiểm tra an toàn (EnvUsed, Steps)
}

// checkWeb kiểm tra spec cho mọi thiết bị web của lượt: giá trị bí mật dạng chữ, bộ kiểm tra an toàn với host của
// từng hồ sơ (mỗi bộ host một lần), biến dùng mà lượt không có (env_missing), và lượt mang bí mật chỉ chạy trên hồ sơ
// họ Chromium. Lượt không có thiết bị web thì không làm gì (không cần bộ chạy web).
func (e *Engine) checkWeb(ctx context.Context, req RunRequest, specs []SpecFlow, env map[string]string) (webPlan, error) {
	var devs []Device
	for _, d := range req.Devices {
		if isWebDevice(d) {
			devs = append(devs, d)
		}
	}
	if len(devs) == 0 || len(specs) == 0 {
		return webPlan{}, nil
	}
	merged, err := e.Flows.envFor(req.App, PlatformWeb, env)
	if err != nil {
		return webPlan{}, err
	}
	var secretNames []string
	if e.Secrets != nil {
		secretNames, _ = FlowSecretNames(e.Secrets)
	}
	// Tên khai báo: biến của lượt và mọi bí mật đã lưu. Tên chưa khai báo ở đâu là lỗi của spec (kèm dòng); tên chỉ có
	// trong kho bí mật mà lượt không chọn là env_missing. Tên dành riêng không bao giờ được khai báo.
	declared := map[string]bool{}
	for n := range merged {
		declared[n] = true
	}
	for _, n := range secretNames {
		declared[n] = true
	}
	var names []string
	for n := range declared {
		if ValidVarName(n) == nil {
			names = append(names, n)
		}
	}
	sort.Strings(names)

	values := e.SecretValues()
	checked := make([]SpecFlow, len(specs))
	var errs FlowErrors
	seenErr := map[string]bool{}
	addErrs := func(fe FlowErrors) {
		for _, x := range fe {
			if k := x.Error(); !seenErr[k] {
				seenErr[k] = true
				errs = append(errs, x)
			}
		}
	}
	done := map[string]bool{}
	for _, dev := range devs {
		p, err := e.webProfile(dev.ID)
		if err != nil {
			return webPlan{}, err
		}
		hosts := pw.AllowedHosts(p)
		key := strings.Join(hosts, "\x00")
		if done[key] {
			continue
		}
		first := len(done) == 0
		done[key] = true
		for i, sf := range specs {
			if err := specSecretLiteral(sf.Name, sf.Source, values); err != nil {
				addErrs(err.(FlowErrors))
				continue
			}
			v, err := e.Flows.ValidateSpec(ctx, req.App, sf.Name, sf.Source, names, hosts)
			var fe FlowErrors
			switch {
			case err == nil:
				if first {
					checked[i] = v
				}
			case asFlowErrors(err, &fe):
				addErrs(fe)
			default:
				return webPlan{}, err
			}
		}
	}
	if len(errs) > 0 {
		return webPlan{}, errs
	}

	isSecret := map[string]bool{}
	for _, n := range secretNames {
		isSecret[n] = true
	}
	bearing := len(req.Secrets) > 0
	var problems []string
	for _, sf := range checked {
		var miss []string
		for _, n := range sf.EnvUsed {
			bearing = bearing || isSecret[n]
			if _, ok := merged[n]; !ok {
				miss = append(miss, n)
			}
		}
		if len(miss) > 0 {
			problems = append(problems, fmt.Sprintf("%s (web): %s", sf.Name, strings.Join(miss, ", ")))
		}
	}
	if len(problems) > 0 {
		return webPlan{}, apperr.New(CodeEnvMissing, strings.Join(problems, "; ")+
			". Truyền qua env, đặt mặc định bằng test_set_env, hoặc dùng secrets cho biến bí mật")
	}
	if bearing {
		for _, dev := range devs {
			if err := e.RequireSecretSafe(dev); err != nil {
				return webPlan{}, err
			}
		}
	}
	return webPlan{env: merged, specs: checked}, nil
}

// specVars: biến tiến trình test nhận, chỉ các tên spec thật sự dùng (process.env.TÊN) và không dành riêng.
func specVars(sf SpecFlow, env map[string]string) map[string]string {
	out := map[string]string{}
	for _, n := range sf.EnvUsed {
		if v, ok := env[n]; ok && ValidVarName(n) == nil {
			out[n] = v
		}
	}
	return out
}

// orphanRuns: flow được gọi tên mà không có thiết bị cùng loại thành flow lỗi môi trường, để task không bao giờ "đạt"
// khi một phần yêu cầu không chạy.
func (e *Engine) orphanRuns(runID string, names []string, req RunRequest) []FlowRun {
	var out []FlowRun
	for _, n := range names {
		kind := FlowKind(n)
		for it := 1; it <= req.Repeat; it++ {
			fr := FlowRun{RunID: runID, Flow: n, Iteration: it, DeviceCount: len(req.Devices), FailureClass: FailEnvironment,
				Error: "không có thiết bị cho loại flow này (" + kind + ")"}
			if kind == KindWeb {
				fr.Platform, fr.Driver = PlatformWeb, DriverPlaywright
			}
			out = append(out, fr)
			e.emit(Event{RunID: runID, Kind: "flow_end", Flow: n, Iteration: it, FlowRun: &fr})
		}
	}
	return out
}

// runWebDevice: preflight và bộ chạy (không tải gì), đánh dấu máy đang chạy (giành quyền bị từ chối), giữ khoá thiết bị
// bằng LockForRun, trả lỗi cho hold đang chờ, rồi mọi spec × lặp, mỗi lượt một tiến trình.
func (e *Engine) runWebDevice(ctx context.Context, runID, outDir string, dev Device, plan webPlan, secrets []string,
	req RunRequest) []FlowRun {
	names := make([]string, len(plan.specs))
	for i, sf := range plan.specs {
		names[i] = sf.Name
	}
	fail := func(err error) []FlowRun { return e.deviceFailed(ctx, runID, dev, names, err, secrets, req) }
	if e.Preflight != nil {
		if err := e.Preflight.Check(ctx, dev); err != nil {
			return fail(err)
		}
	}
	if err := e.EnsureRuntime(ctx, dev); err != nil {
		return fail(err)
	}
	profile, err := e.webProfile(dev.ID)
	if err != nil {
		return fail(err)
	}
	runner, err := e.specRunner()
	if err != nil {
		return fail(err)
	}
	runs := ""
	if e.Web != nil {
		runs = pw.RunsDir(e.Web.RT)
	}
	if runs == "" {
		return fail(errNoWebRuntime())
	}
	work := filepath.Join(runs, runID, safeName(dev.ID))
	defer os.RemoveAll(work)

	// Đếm số lượt đang giữ hoặc chờ máy: lượt chồng nhau trên cùng hồ sơ thì giành quyền vẫn bị từ chối tới khi lượt
	// cuối cùng xong.
	e.mu.Lock()
	if e.webRunning == nil {
		e.webRunning = map[string]int{}
	}
	e.webRunning[dev.ID]++
	e.mu.Unlock()
	defer func() {
		e.mu.Lock()
		if e.webRunning[dev.ID]--; e.webRunning[dev.ID] <= 0 {
			delete(e.webRunning, dev.ID)
		}
		e.mu.Unlock()
	}()

	frames := &liveFrames{dir: filepath.Join(work, "live")}
	var out []FlowRun
	err = e.Pool.LockForRun(ctx, dev, frames.read, func(ctx context.Context) error {
		e.refuseHoldForWebRun(dev.ID)
		for it := 1; it <= req.Repeat; it++ {
			for _, sf := range plan.specs {
				if ctx.Err() != nil {
					return nil
				}
				fr := e.runSpec(ctx, runner, runID, outDir, work, dev, profile, sf, it, plan.env, secrets, req)
				out = append(out, fr)
				e.emit(Event{RunID: runID, Kind: "flow_end", DeviceID: dev.ID, Flow: fr.Flow, Iteration: it, FlowRun: &fr})
			}
		}
		return nil
	})
	if err != nil && len(out) == 0 {
		return fail(err)
	}
	return out
}

// specBase: tên spec bỏ đuôi .spec.ts, dùng làm tên thư mục làm việc.
func specBase(name string) string {
	b := filepath.Base(name)
	if IsSpecName(b) {
		b = b[:len(b)-len(".spec.ts")]
	}
	return safeName(b)
}

// runSpec chạy một spec một lần trên một hồ sơ và trả FlowRun (đã che bí mật).
func (e *Engine) runSpec(ctx context.Context, runner SpecRunner, runID, outDir, work string, dev Device, profile pw.Profile,
	sf SpecFlow, it int, env map[string]string, secrets []string, req RunRequest) FlowRun {
	fr := FlowRun{RunID: runID, DeviceID: dev.ID, Platform: dev.Platform, Driver: dev.Driver, Flow: sf.Name, Iteration: it,
		DeviceCount: len(req.Devices)}
	e.emit(Event{RunID: runID, Kind: "flow_start", DeviceID: dev.ID, Flow: sf.Name, Iteration: it})
	mode, _ := artifactMode(req.Artifacts)
	job := pw.Job{Dir: filepath.Join(work, fmt.Sprintf("r%02d-%s", it, specBase(sf.Name))), Spec: sf.Source, Profile: profile,
		Video: pw.VideoFor(req.Record), Timeout: req.Timeout, Vars: specVars(sf, env), LiveDir: filepath.Join(work, "live"),
		StepShots: mode}
	defer os.RemoveAll(job.Dir)
	col := &webSteps{e: e, runID: runID, dev: dev, flow: sf.Name, it: it, secrets: secrets, byTest: map[string][]int{}}
	start := e.now()
	res, err := runner.Run(ctx, job, col.add)
	wall := e.now().Sub(start).Milliseconds()
	dir := flowOutDir(outDir, dev.ID, it, sf.Name)
	out := col.finish(job.Dir, dir, outDir)
	fr.Steps, fr.Video, fr.Trace = col.steps, out.video, out.trace
	fr.DurationMs = wall
	if out.testMs > 0 {
		fr.DurationMs = out.testMs // thời gian của chính các test, không gồm khởi động Node và trình duyệt
	}

	disconnected := errors.Is(context.Cause(ctx), ErrDeviceDisconnected)
	switch {
	case disconnected:
		fr.FailureClass, fr.Error = FailEnvironment, "thiết bị đã ngắt kết nối"
	case ctx.Err() != nil:
		fr.FailureClass, fr.Error = FailEnvironment, userStopError
	case err != nil:
		fr.FailureClass, fr.Error = FailEnvironment, redact(err.Error(), secrets)
	case res.TimedOut:
		fr.FailureClass, fr.Error = FailEnvironment, "quá hạn "+req.Timeout.String()
	case !res.Ended:
		msg := "tiến trình chạy test dừng bất thường"
		if t := strings.TrimSpace(res.Log); t != "" {
			msg += ": " + lastChars(t, 500)
		}
		fr.FailureClass, fr.Error = FailEnvironment, redact(msg, secrets)
	case out.passed:
		fr.Passed = true
	default:
		fr.FailureClass, fr.Error = classifyWeb(out.message, out.category, out.status), redact(out.message, secrets)
	}
	return fr
}

func lastChars(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return "…" + string(r[len(r)-n:])
}

// classifyWeb: chặn host, lỗi mạng, trình duyệt không mở được hay sập, quá hạn cả test là môi trường; expect không đạt là
// lỗi sản phẩm; còn lại (hết hạn chờ locator, strict mode, flow sai) là lỗi tự động hoá.
func classifyWeb(msg, category, status string) string {
	low := strings.ToLower(msg)
	for _, k := range []string{pw.CodeHostBlocked, "net::err_", "browsertype.launch", "executable doesn't exist", "failed to launch",
		"target page, context or browser has been closed", "browser has been closed", "browser closed", "crash"} {
		if strings.Contains(low, k) {
			return FailEnvironment
		}
	}
	if status == "timedOut" {
		return FailEnvironment
	}
	if category == "expect" || strings.Contains(msg, "expect(") {
		return FailProduct
	}
	return FailAutomation
}

// webCommand: tên lệnh của bước web (step, expect, hoặc từ đầu của lệnh Playwright: navigate, click, fill...).
func webCommand(ev pw.Event) string {
	switch {
	case ev.Depth == 0:
		return "step"
	case ev.Category == "expect":
		return "expect"
	}
	if f := strings.Fields(ev.Title); len(f) > 0 {
		return strings.ToLower(f[0])
	}
	return "api"
}

// webSteps gom sự kiện reporter của một lượt thành bước (đã che bí mật, phát sự kiện "step" ngay khi có) và test.
type webSteps struct {
	e       *Engine
	runID   string
	dev     Device
	flow    string
	it      int
	secrets []string

	steps   []StepRun
	byTest  map[string][]int // mã test -> vị trí các bước depth 0 của test đó trong steps
	pending []StepRun        // lệnh của bước depth 0 chưa kết thúc (reporter báo lệnh con trước bước cha)
	next    int              // Index của bước depth 0 kế tiếp
	tests   []pw.Event
	errs    []pw.TestError // lỗi ngoài test (cấu hình, biên dịch spec)
}

func (c *webSteps) add(ev pw.Event) {
	switch ev.Type {
	case pw.EventStep:
		s := StepRun{Index: -1, Depth: ev.Depth, Command: webCommand(ev), Desc: redact(ev.Title, c.secrets), Passed: ev.Error == nil,
			DurationMs: ev.DurationMs}
		if ev.Error != nil {
			s.Error = redact(ev.Error.Message, c.secrets)
		}
		if ev.Depth > 0 {
			c.pending = append(c.pending, s)
			return
		}
		s.Index = c.next
		c.next++
		c.byTest[ev.Test] = append(c.byTest[ev.Test], len(c.steps))
		c.push(s)
		for _, p := range c.pending {
			c.push(p)
		}
		c.pending = nil
	case pw.EventTest:
		for _, p := range c.pending { // lệnh ngoài mọi step() (không xảy ra với spec hợp lệ)
			c.push(p)
		}
		c.pending = nil
		c.tests = append(c.tests, ev)
	case pw.EventError:
		if ev.Error != nil {
			c.errs = append(c.errs, *ev.Error)
		}
	}
}

func (c *webSteps) push(s StepRun) {
	c.steps = append(c.steps, s)
	c.e.emit(Event{RunID: c.runID, Kind: "step", DeviceID: c.dev.ID, Flow: c.flow, Iteration: c.it, Step: &s})
}

// specOutcome: kết quả của một lượt theo các test reporter đã báo.
type specOutcome struct {
	passed   bool
	status   string // trạng thái của test lỗi đầu tiên
	category string // loại lệnh hỏng trong bước lỗi (expect | pw:api)
	message  string // lỗi đầu tiên, kèm URL trang lúc lỗi
	testMs   int64
	video    string
	trace    string
}

// finish chép ảnh bước, aria snapshot, video và trace của các test từ thư mục làm việc jobDir vào thư mục flow dir (trong
// outDir của lượt), gắn ảnh trước/sau vào bước và tính kết quả. Ảnh sau thứ i của một test thuộc về bước depth 0 đạt thứ
// i của test đó; ảnh lỗi và aria snapshot thuộc về bước lỗi.
func (c *webSteps) finish(jobDir, dir, outDir string) specOutcome {
	out := specOutcome{passed: len(c.tests) > 0 && len(c.errs) == 0}
	shot := 0
	copyShot := func(src, name string) string {
		shot++
		dst := filepath.Join(dir, "assets", fmt.Sprintf("%s-%d.png", name, shot))
		if !copyArtifact(jobDir, src, dst, 0o644) {
			return ""
		}
		return relSlash(outDir, dst)
	}
	traces := 0
	for _, t := range c.tests {
		out.testMs += t.DurationMs
		var initial, failure, aria, page string
		var afters []string
		for _, a := range t.Attachments {
			switch a.Name {
			case "cqs-initial":
				initial = copyShot(a.Path, "initial")
			case "cqs-after":
				afters = append(afters, copyShot(a.Path, "after"))
			case "cqs-failure":
				failure = copyShot(a.Path, "failure")
			case "failure-aria":
				aria = a.Body
			case "failure-url":
				page = strings.TrimSpace(a.Body)
			case "video":
				if out.video == "" {
					dst := filepath.Join(dir, "video"+strings.ToLower(filepath.Ext(a.Path)))
					if copyArtifact(jobDir, a.Path, dst, 0o644) {
						out.video = dst
					}
				}
			case "trace":
				name := traceFile
				if traces > 0 {
					name = fmt.Sprintf("trace-%d.zip", traces+1)
				}
				dst := filepath.Join(dir, name)
				if copyArtifact(jobDir, a.Path, dst, 0o600) {
					traces++
					if out.trace == "" {
						out.trace = dst
					}
				}
			}
		}
		ariaRel := ""
		if aria != "" {
			p := filepath.Join(dir, "assets", fmt.Sprintf("failure-aria-%d.txt", shot+1))
			if os.MkdirAll(filepath.Dir(p), 0o755) == nil && os.WriteFile(p, []byte(redact(aria, c.secrets)), 0o644) == nil {
				ariaRel = relSlash(outDir, p)
			}
		}
		prev, ai := initial, 0
		for _, i := range c.byTest[t.Test] {
			s := &c.steps[i]
			s.ShotBefore = prev
			switch {
			case s.Passed && ai < len(afters):
				s.ShotAfter, prev = afters[ai], afters[ai]
				ai++
			case !s.Passed:
				s.ShotAfter, s.Hierarchy = failure, ariaRel
			}
		}
		if t.Status == "passed" || t.Status == "skipped" {
			continue
		}
		if out.passed || out.message == "" {
			out.status = t.Status
			out.message = "test " + t.Title + " không đạt"
			if t.Error != nil && t.Error.Message != "" {
				out.message = t.Error.Message
			} else if len(t.Errors) > 0 {
				out.message = t.Errors[0].Message
			}
			if page != "" {
				out.message += " (trang: " + page + ")"
			}
			out.category = c.failedCategory(t.Test)
		}
		out.passed = false
	}
	if len(c.tests) == 0 || (out.message == "" && len(c.errs) > 0) {
		out.passed = false
		out.message = "spec không có test nào chạy"
		if len(c.errs) > 0 {
			out.message = c.errs[0].Message
		}
	}
	return out
}

// failedCategory: loại của lệnh hỏng đầu tiên trong bước lỗi của test (expect hay lệnh Playwright).
func (c *webSteps) failedCategory(test string) string {
	for _, i := range c.byTest[test] {
		if c.steps[i].Passed {
			continue
		}
		for j := i + 1; j < len(c.steps) && c.steps[j].Depth > 0; j++ {
			if !c.steps[j].Passed {
				if c.steps[j].Command == "expect" {
					return "expect"
				}
				return "pw:api"
			}
		}
	}
	return ""
}

// copyArtifact chép src (phải nằm trong thư mục làm việc root) sang dst với quyền perm; false nếu không chép được.
func copyArtifact(root, src, dst string, perm os.FileMode) bool {
	if src == "" {
		return false
	}
	r, err1 := filepath.EvalSymlinks(root)
	s, err2 := filepath.EvalSymlinks(src)
	if err1 != nil || err2 != nil {
		return false
	}
	if rel, err := filepath.Rel(r, s); err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return false
	}
	in, err := os.Open(s)
	if err != nil {
		return false
	}
	defer in.Close()
	if st, err := in.Stat(); err != nil || !st.Mode().IsRegular() {
		return false
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return false
	}
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, perm)
	if err != nil {
		return false
	}
	_, err = io.Copy(out, in)
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Chmod(dst, perm) // file đã có từ trước giữ quyền cũ khi OpenFile
	}
	if err != nil {
		_ = os.Remove(dst)
		return false
	}
	return true
}

func relSlash(base, p string) string {
	r, err := filepath.Rel(base, p)
	if err != nil {
		return ""
	}
	return filepath.ToSlash(r)
}

// liveFrames đọc ảnh live xoay vòng (live-0..2.jpg) fixture ghi trong lúc chạy: lấy file mới nhất giải được; file đang
// bị ghi dở hay bị khoá thì giữ khung hình trước, không bao giờ lùi về khung cũ hơn.
type liveFrames struct {
	dir    string
	mu     sync.Mutex
	last   []byte
	lastAt time.Time
}

func (l *liveFrames) read() ([]byte, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	type cand struct {
		path string
		at   time.Time
	}
	var cs []cand
	for i := 0; i < 3; i++ {
		p := filepath.Join(l.dir, fmt.Sprintf("live-%d.jpg", i))
		if st, err := os.Stat(p); err == nil && st.Mode().IsRegular() {
			cs = append(cs, cand{p, st.ModTime()})
		}
	}
	sort.Slice(cs, func(i, j int) bool { return cs[i].at.After(cs[j].at) })
	for _, c := range cs {
		if l.last != nil && c.at.Before(l.lastAt) {
			break
		}
		b, err := os.ReadFile(c.path)
		if err != nil || len(b) == 0 {
			continue
		}
		if _, err := jpeg.Decode(bytes.NewReader(b)); err != nil {
			continue
		}
		l.last, l.lastAt = b, c.at
		return b, nil
	}
	if l.last != nil {
		return l.last, nil
	}
	return nil, ErrPeekBusy
}

// AttachTraces điền FlowRun.Trace (không lưu DB) cho mọi flow web lỗi còn trace.zip trong thư mục lượt.
func (e *Engine) AttachTraces(run RunRecord, flows []FlowRun) {
	for i := range flows {
		f := &flows[i]
		if f.Platform != PlatformWeb || f.Passed || f.DeviceID == "" || run.OutDir == "" {
			continue
		}
		p := filepath.Join(flowOutDir(run.OutDir, f.DeviceID, f.Iteration, f.Flow), traceFile)
		if st, err := os.Lstat(p); err == nil && st.Mode().IsRegular() {
			f.Trace = p
		}
	}
}
