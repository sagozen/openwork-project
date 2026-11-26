package pw

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	goruntime "runtime"
	"strings"
	"sync"
	"time"

	"chatqa/internal/proc"
	"deskcore/apperr"
)

const (
	runnerGrace  = time.Second            // bị dừng: chờ thoát êm chừng này rồi giết cả cây
	endGrace     = 5 * time.Second        // sau sự kiện end: chờ tiến trình tự thoát (đã đóng stdin) rồi giết
	hardMargin   = time.Minute            // quá hạn test chừng này mà tiến trình vẫn chưa xong thì giết cả cây
	pollEvery    = 100 * time.Millisecond // đọc tiếp báo cáo NDJSON
	trackEvery   = 500 * time.Millisecond // ghi nhận tiến trình con (worker, trình duyệt) vào pids.json
	staleRunAge  = 24 * time.Hour         // thư mục lượt cũ hơn bị xoá khi lượt mới bắt đầu
	logTailBytes = 8 << 10
	reportFile   = "report.ndjson"
	configFile   = "playwright.config.mjs"
	specFile     = "flow.spec.ts"
)

// runScripts: script nhúng cần cho một lượt chạy spec. guard.mjs dùng chung với sidecar (cùng luật chặn mạng).
var runScripts = []string{"bootstrap.mjs", "guard.mjs", "reporter.mjs", "chatqa.ts"}

// Ảnh theo bước (CQS_STEP_SHOTS), cùng giá trị với Artifacts của lệnh chạy.
const (
	ShotsAlways    = "always"
	ShotsOnFailure = "on-failure"
	ShotsNever     = "never"
)

// Job: một lượt playwright test của một flow trên một hồ sơ.
type Job struct {
	Dir       string            // thư mục làm việc riêng của lượt, dưới RunsDir (bị xoá rồi tạo lại)
	Spec      []byte            // nội dung flow.spec.ts (đã qua bộ kiểm tra an toàn)
	Profile   Profile           // hồ sơ trình duyệt (đã Validate)
	Video     string            // VideoOff | VideoOn | VideoOnFailure
	Timeout   time.Duration     // hạn của test; 0 = 10 phút
	Vars      map[string]string // biến flow dùng (process.env.TÊN); vào tiến trình dưới tên CQS_VAR_TÊN
	LiveDir   string            // thư mục ảnh live (live-0..2.jpg); "" = không chụp
	StepShots string            // ShotsAlways | ShotsOnFailure | ShotsNever
}

// Result: kết cục của tiến trình. Kết quả từng test đến qua các sự kiện của reporter.
type Result struct {
	Ended    bool   // reporter đã ghi end (lượt kết thúc bình thường, kể cả có test lỗi)
	Status   string // trạng thái của sự kiện end
	TimedOut bool   // quá hạn cứng của app: cây tiến trình đã bị giết
	Killed   bool   // bị dừng theo ctx
	Log      string // phần cuối stdout/stderr của tiến trình, để chẩn đoán khi lượt không kết thúc bình thường
}

// Runner chạy flow web: mỗi Job một tiến trình `node bootstrap.mjs cli.js test --config ...`, khởi động bằng
// exec.Command thường và dừng bằng proc.KillTree tường minh (không dùng CommandContext: nó chỉ giết tiến trình gốc).
// Tiến trình gốc và mọi tiến trình con thấy được (worker, trình duyệt) được ghi vào pids.json để dọn khi app sập.
type Runner struct {
	RT *Runtime
	// Log ghi log; nil = log.Printf.
	Log func(format string, args ...any)
}

// RunsDir: thư mục chứa thư mục làm việc của các lượt chạy spec (dưới thư mục có node_modules, vì Node tìm gói
// bằng cách đi ngược lên thư mục cha); "" khi chưa cài bộ chạy.
func RunsDir(rt *Runtime) string {
	if rt == nil {
		return ""
	}
	if w := rt.WorkDir(); w != "" {
		return filepath.Join(w, "runs")
	}
	return ""
}

func (r *Runner) logf(format string, args ...any) {
	if r.Log != nil {
		r.Log(format, args...)
		return
	}
	log.Printf(format, args...)
}

// Run chạy job tới khi tiến trình thoát và trả kết cục; onEvent nhận từng sự kiện của reporter ngay khi đọc được.
// Lỗi trả về nghĩa là lượt không chạy được (thiếu bộ chạy, không ghi được file, không mở được tiến trình).
func (r *Runner) Run(ctx context.Context, job Job, onEvent func(Event)) (Result, error) {
	if r.RT == nil {
		return Result{}, apperr.New(CodeRuntimeMissing, "")
	}
	if err := r.RT.ownerErr(); err != nil {
		return Result{}, err
	}
	node, cli := r.RT.NodePath(), r.RT.CLIPath()
	if !exists(node) || !exists(cli) {
		return Result{}, apperr.New(CodeRuntimeMissing, "chưa cài Node và Playwright")
	}
	runs := RunsDir(r.RT)
	if job.Dir == "" || !inside(runs, job.Dir) {
		return Result{}, apperr.New(apperr.CodeInvalid, "thư mục lượt chạy phải nằm trong "+runs)
	}
	r.sweep(runs, job.Dir)
	if err := writeJob(job); err != nil {
		return Result{}, err
	}
	hosts, _ := json.Marshal(AllowedHosts(job.Profile))
	shots := job.StepShots
	if shots != ShotsAlways && shots != ShotsNever {
		shots = ShotsOnFailure
	}
	cmd := exec.Command(node, filepath.Join(job.Dir, "bootstrap.mjs"), cli, "test", "--config", filepath.Join(job.Dir, configFile))
	cmd.Dir = job.Dir
	cmd.Env = RunnerEnv(os.Environ(), job.Vars, []EnvVar{
		{"PLAYWRIGHT_BROWSERS_PATH", r.RT.BrowsersPath()},
		{"CQS_ALLOWED_HOSTS", string(hosts)},
		{"CQS_LIVE_DIR", job.LiveDir},
		{"CQS_STEP_SHOTS", shots},
	})
	out := &tailBuffer{max: logTailBytes}
	cmd.Stdout, cmd.Stderr = out, out
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return Result{}, err
	}
	tree, err := proc.Start(cmd, stdin)
	if err != nil {
		return Result{}, apperr.Wrap(CodeSidecarFailed, err)
	}
	pid := tree.PID()
	pids := r.RT.PIDs()
	if err := pids.Add(pid, goruntime.GOOS != "windows"); err != nil {
		r.logf("pw: không ghi được pids.json: %v", err)
	}
	tracked := map[int]bool{}
	defer func() {
		r.reap(tracked)
		if err := pids.Remove(pid); err != nil {
			r.logf("pw: không cập nhật được pids.json: %v", err)
		}
	}()
	// Cổng bootstrap: chỉ sau khi tiến trình đã nằm trong nhóm/Job thì Node mới nạp Playwright.
	if _, err := io.WriteString(stdin, "start\n"); err != nil {
		tree.KillTree(runnerGrace)
		return Result{Log: out.String()}, apperr.New(CodeSidecarFailed, "không gửi được lệnh start: "+err.Error())
	}

	var res Result
	var closeOnce sync.Once
	handle := func(ev Event) {
		if ev.Type == EventEnd && !res.Ended {
			res.Ended, res.Status = true, ev.Status
			// Playwright xong nhưng bootstrap còn giữ stdin: đóng stdin để nó dừng cả nhóm và thoát.
			closeOnce.Do(func() { _ = stdin.Close() })
		}
		if onEvent != nil {
			onEvent(ev)
		}
	}
	timeout := job.Timeout
	if timeout <= 0 {
		timeout = defaultTestTimeout
	}
	hard := time.NewTimer(timeout + hardMargin)
	defer hard.Stop()
	poll := time.NewTicker(pollEvery)
	defer poll.Stop()
	track := time.NewTicker(trackEvery)
	defer track.Stop()
	tail := &reportTail{path: filepath.Join(job.Dir, reportFile)}
	var ended <-chan time.Time
loop:
	for {
		select {
		case <-tree.Done():
			break loop
		case <-ctx.Done():
			res.Killed = true
			r.track(pid, tracked)
			tree.KillTree(runnerGrace)
			break loop
		case <-hard.C:
			res.TimedOut = true
			r.track(pid, tracked)
			tree.KillTree(runnerGrace)
			break loop
		case <-ended:
			tree.KillTree(runnerGrace)
			break loop
		case <-poll.C:
			tail.Poll(handle)
			if res.Ended && ended == nil {
				ended = time.After(endGrace)
			}
		case <-track.C:
			r.track(pid, tracked)
		}
	}
	tail.Flush(handle)
	res.Log = out.String()
	return res, nil
}

// writeJob dựng thư mục làm việc: script của app, package.json (ESM để fixture import được guard.mjs), spec và cấu hình.
func writeJob(job Job) error {
	if err := os.RemoveAll(job.Dir); err != nil {
		return err
	}
	if err := os.MkdirAll(job.Dir, 0o700); err != nil {
		return err
	}
	if job.LiveDir != "" {
		if err := os.MkdirAll(job.LiveDir, 0o700); err != nil {
			return err
		}
	}
	files := map[string][]byte{
		"package.json": []byte(`{"private":true,"type":"module"}` + "\n"),
		specFile:       job.Spec,
	}
	for _, name := range runScripts {
		b, err := scripts.ReadFile("js/" + name)
		if err != nil {
			return err
		}
		files[name] = b
	}
	cfg, err := RenderConfig(ConfigOptions{
		Profile: job.Profile, Video: job.Video, Timeout: job.Timeout,
		Reporter: filepath.Join(job.Dir, "reporter.mjs"), Report: filepath.Join(job.Dir, reportFile),
		OutputDir: filepath.Join(job.Dir, "test-results"),
	})
	if err != nil {
		return err
	}
	files[configFile] = cfg
	for name, body := range files {
		if err := os.WriteFile(filepath.Join(job.Dir, name), body, 0o600); err != nil {
			return err
		}
	}
	return nil
}

// track ghi các hậu duệ hiện có của pid vào pids.json. Trình duyệt Playwright mở nằm trong nhóm tiến trình riêng,
// nên giết nhóm của tiến trình gốc không tới được nó; danh sách này để dọn nó khi lượt bị giết hoặc app sập.
func (r *Runner) track(pid int, tracked map[int]bool) {
	queue := []int{pid}
	for len(queue) > 0 && len(tracked) < 256 {
		kids, err := proc.Children(queue[0])
		queue = queue[1:]
		if err != nil {
			return
		}
		for _, k := range kids {
			if tracked[k] {
				queue = append(queue, k)
				continue
			}
			tracked[k] = true
			queue = append(queue, k)
			if err := r.RT.PIDs().Add(k, goruntime.GOOS != "windows"); err != nil {
				r.logf("pw: không ghi được pids.json: %v", err)
			}
		}
	}
}

// reap giết các hậu duệ đã ghi còn sống (đúng thời điểm bắt đầu đã ghi) và bỏ chúng khỏi pids.json. Lượt kết thúc
// êm thì chúng đã thoát và lệnh này không làm gì.
func (r *Runner) reap(tracked map[int]bool) {
	if len(tracked) == 0 {
		return
	}
	ids := make([]int, 0, len(tracked))
	for k := range tracked {
		ids = append(ids, k)
	}
	if n, err := r.RT.PIDs().Kill(ids); err != nil {
		r.logf("pw: không dừng được tiến trình con còn sót: %v", err)
	} else if n > 0 {
		r.logf("pw: đã dừng %d tiến trình con còn sót của lượt chạy", n)
	}
}

// sweep xoá thư mục lượt cũ hơn staleRunAge trong runs (trừ lượt chứa keep): lượt bị giết giữa chừng để lại chúng.
// Tuổi của lượt là mục mới nhất trong cả cây: lượt dài hơn staleRunAge tạo thư mục việc sâu bên dưới mà không đổi
// mtime của thư mục lượt, nên không bao giờ bị lượt khác xoá khi còn đang chạy.
func (r *Runner) sweep(runs, keep string) {
	entries, err := os.ReadDir(runs)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			r.logf("pw: không đọc được %s: %v", runs, err)
		}
		return
	}
	for _, e := range entries {
		p := filepath.Join(runs, e.Name())
		if inside(p, keep) || p == keep || touchedWithin(p, staleRunAge) {
			continue
		}
		if err := os.RemoveAll(p); err != nil {
			r.logf("pw: không xoá được lượt cũ %s: %v", p, err)
		}
	}
}

// touchedWithin: có mục nào trong cây dir (kể cả dir) đổi trong khoảng age vừa qua. Không đọc được một phần cây thì
// coi như vừa đổi (không xoá thứ không kiểm được).
func touchedWithin(dir string, age time.Duration) bool {
	found := false
	_ = filepath.WalkDir(dir, func(_ string, d fs.DirEntry, err error) error {
		var info fs.FileInfo
		if err == nil {
			info, err = d.Info()
		}
		if err != nil || time.Since(info.ModTime()) < age {
			found = true
			return filepath.SkipAll
		}
		return nil
	})
	return found
}

// inside: p nằm hẳn bên trong root (so theo đường dẫn đã làm sạch).
func inside(root, p string) bool {
	if root == "" || p == "" {
		return false
	}
	rel, err := filepath.Rel(filepath.Clean(root), filepath.Clean(p))
	return err == nil && rel != "." && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}

// tailBuffer giữ max byte cuối cùng được ghi vào.
type tailBuffer struct {
	mu  sync.Mutex
	max int
	b   []byte
}

func (t *tailBuffer) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.b = append(t.b, p...)
	if over := len(t.b) - t.max; over > 0 {
		t.b = append(t.b[:0:0], t.b[over:]...)
	}
	return len(p), nil
}

func (t *tailBuffer) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return strings.ToValidUTF8(string(t.b), "")
}
