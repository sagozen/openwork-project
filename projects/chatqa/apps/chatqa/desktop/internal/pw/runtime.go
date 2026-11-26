package pw

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	goruntime "runtime"
	"strings"
	"sync"

	"chatqa/internal/fetch"
	"chatqa/internal/proc"
	"deskcore/apperr"
)

// Loại artifact trong Pins.
const (
	KindNode    = "node"
	KindNPM     = "npm"
	KindBrowser = "browser"
)

// Trạng thái một thành phần trong Status.
const (
	StateMissing     = "missing"
	StateInstalling  = "installing"
	StateReady       = "ready"
	StateUnsupported = "unsupported"
)

const (
	codeDeviceNotReady = "device_not_ready"
	pointerFile        = "current.json"
	completeMarker     = "INSTALLATION_COMPLETE" // Playwright chỉ dùng thư mục trình duyệt có file này
	maxUnpinnedSize    = 1 << 30
)

// Artifact: một file tải về đã ghim.
type Artifact struct {
	URL       string // nơi tải
	Mirror    string // nguồn thứ hai đã đối chiếu cùng SHA-256 lúc ghim (trình duyệt); "" nếu không có
	SHA256    string
	Size      int64
	Kind      string // KindNode | KindNPM | KindBrowser
	Dir       string // trình duyệt: thư mục dưới browsers/ (chromium-1248)
	Rev       string // trình duyệt: revision của Playwright
	Integrity string // npm: sha512 đã khớp registry và package-lock.json gốc
}

// Pins: phiên bản và artifact đã ghim. Khoá Artifacts: "<goos>/<goarch>/<tên>" (WebKit macOS:
// "darwin/arm64/webkit@mac15"), gói npm: "npm/<tên gói>".
type Pins struct {
	Node, Playwright, TypeScript string
	Artifacts                    map[string]Artifact
}

// NPMPackages: các gói npm của bộ chạy, cài chung một thư mục modules-*.
var NPMPackages = []string{"playwright-core", "playwright", "@playwright/test", "typescript"}

// Browsers: trình duyệt tải về được. msedge/chrome là kênh có sẵn trên máy, không tải.
var Browsers = []string{"chromium", "firefox", "webkit"}

// ComponentStatus: trạng thái Node hoặc bộ gói npm. Size: số byte cần tải khi chưa cài.
type ComponentStatus struct {
	State   string `json:"state"`
	Version string `json:"version"`
	Size    int64  `json:"size,omitempty"`
}

// BrowserStatus: trạng thái một trình duyệt tải về (chromium gồm cả ffmpeg).
type BrowserStatus struct {
	Name  string `json:"name"`
	State string `json:"state"`
	Size  int64  `json:"size,omitempty"`
}

// Status: ảnh chụp bộ chạy để UI hiển thị.
type Status struct {
	Platform string          `json:"platform"`
	Node     ComponentStatus `json:"node"`
	Modules  ComponentStatus `json:"modules"`
	Browsers []BrowserStatus `json:"browsers"`
	Channels []ChannelStatus `json:"channels"`
}

// Runtime: bộ chạy trình duyệt trong <data dir>/playwright. Chỉ Ensure tải; đường chạy và điều khiển
// không bao giờ tải.
type Runtime struct {
	Dir    string
	Client *http.Client
	// URL thay nơi tải theo khoá artifact; nil = Artifact.URL.
	URL func(key string) string
	// Pins thay bộ ghim; nil = DefaultPins.
	Pins *Pins
	// InUse: true khi một lượt chạy web giữ thiết bị hoặc sidecar đang chạy; khi đó Ensure từ chối cài.
	InUse func() bool
	// Platform "<goos>/<goarch>"; "" = máy đang chạy.
	Platform string

	locks      fetch.KeyLock
	mu         sync.Mutex // con trỏ current.json và installing
	installing map[string]bool
	lock       *os.File // khoá <Dir>/.lock của Startup, giữ suốt đời tiến trình
	foreign    bool     // Startup không giữ được khoá: bộ chạy thuộc phiên bản app khác
	pidOnce    sync.Once
	pids       *proc.PIDFile
}

// lockFile: khoá độc quyền giữa các tiến trình app trên cùng thư mục dữ liệu.
const lockFile = ".lock"

// Startup gọi một lần lúc app khởi động, trước khi mở tiến trình Node nào. Nó giữ khoá độc quyền <Dir>/.lock
// suốt đời tiến trình; giữ được thì giết tiến trình mồ côi trong pids.json (app trước sập) và dọn phần cài dở
// (Sweep), trả owner = true. Khoá đang thuộc tiến trình khác (mở app lần hai trong lúc lần một còn chạy) thì
// không đụng gì: tiến trình, pids.json và phần đang cài của phiên bản kia giữ nguyên, và bộ chạy của tiến trình
// này từ chối cài, mở sidecar và chạy flow. Không xác định được khoá (lỗi khác) cũng xử như vậy.
func (r *Runtime) Startup() (owner bool, reaped int, err error) {
	owner, fresh, err := r.acquire()
	if !owner || !fresh {
		return owner, 0, err // đã giữ khoá từ lần gọi trước: không dọn lại tiến trình của chính mình
	}
	var errs []error
	if reaped, err = r.PIDs().Reap(); err != nil {
		errs = append(errs, err)
	}
	if err := r.Sweep(); err != nil {
		errs = append(errs, err)
	}
	return true, reaped, errors.Join(errs...)
}

// acquire lấy khoá <Dir>/.lock (fresh = vừa lấy ở lần gọi này); không lấy được thì đánh dấu bộ chạy thuộc
// tiến trình khác.
func (r *Runtime) acquire() (owner, fresh bool, err error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.lock != nil {
		return true, false, nil
	}
	err = os.MkdirAll(r.Dir, 0o755)
	var f *os.File
	if err == nil {
		f, err = proc.LockFile(filepath.Join(r.Dir, lockFile))
	}
	if err != nil {
		r.foreign = true
		if errors.Is(err, proc.ErrLocked) {
			return false, false, nil
		}
		return false, false, err
	}
	r.lock, r.foreign = f, false
	return true, true, nil
}

// Release nhả khoá của Startup (đóng app, test).
func (r *Runtime) Release() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.lock != nil {
		r.lock.Close()
		r.lock = nil
	}
}

// ownerErr: lỗi device_not_ready khi bộ chạy thuộc phiên bản app khác (Startup không giữ được khoá).
func (r *Runtime) ownerErr() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.foreign {
		return apperr.New(codeDeviceNotReady, "bộ chạy trình duyệt đang thuộc một phiên bản app khác")
	}
	return nil
}

type pointer struct {
	Node    string `json:"node,omitempty"`
	Modules string `json:"modules,omitempty"`
}

func (r *Runtime) pins() *Pins {
	if r.Pins != nil {
		return r.Pins
	}
	return &DefaultPins
}

func (r *Runtime) platform() string {
	if r.Platform != "" {
		return r.Platform
	}
	return goruntime.GOOS + "/" + goruntime.GOARCH
}

func (r *Runtime) goos() string { return strings.SplitN(r.platform(), "/", 2)[0] }

// supported: chỉ macOS arm64 và Windows x64 là nền tảng phát hành.
func (r *Runtime) supported() bool {
	p := r.platform()
	return p == "darwin/arm64" || p == "windows/amd64"
}

// key: khoá artifact của một thành phần trên nền tảng này.
func (r *Runtime) key(name string) string {
	switch {
	case name == KindNode:
		return r.platform() + "/node"
	case strings.HasPrefix(name, "npm/"):
		return name
	case name == "webkit" && r.goos() == "darwin":
		return r.platform() + "/webkit@" + macHost() // bản WebKit khác nhau theo phiên bản macOS
	}
	return r.platform() + "/" + name
}

func (r *Runtime) artifact(name string) (string, Artifact, bool) {
	k := r.key(name)
	a, ok := r.pins().Artifacts[k]
	return k, a, ok && a.SHA256 != ""
}

func (r *Runtime) nodeDirName() string { return "node-" + r.pins().Node }
func (r *Runtime) modulesDirName() string {
	return "modules-" + r.pins().Playwright + "-" + r.pins().TypeScript
}

func (r *Runtime) nodeBin() string {
	if r.goos() == "windows" {
		return "node.exe"
	}
	return "bin/node"
}

func (r *Runtime) readPointer() pointer {
	var p pointer
	if b, err := os.ReadFile(filepath.Join(r.Dir, pointerFile)); err == nil {
		_ = json.Unmarshal(b, &p) // hỏng thì coi như chưa cài: Ensure cài lại vào thư mục có phiên bản
	}
	return p
}

// setPointer đổi current.json nguyên tử (ghi file .part rồi đổi tên): app tắt giữa chừng để lại con trỏ
// cũ hoặc mới, không bao giờ nửa vời.
func (r *Runtime) setPointer(update func(*pointer)) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	p := r.readPointer()
	update(&p)
	b, err := json.Marshal(p)
	if err != nil {
		return err
	}
	tmp := filepath.Join(r.Dir, pointerFile+".part")
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(r.Dir, pointerFile))
}

// NodePath: node của phiên bản đang trỏ; "" nếu chưa cài.
func (r *Runtime) NodePath() string {
	p := r.readPointer()
	if p.Node == "" {
		return ""
	}
	return filepath.Join(r.Dir, p.Node, filepath.FromSlash(r.nodeBin()))
}

// ModulesDir: thư mục modules-* đang trỏ (chứa node_modules và work); "" nếu chưa cài.
func (r *Runtime) ModulesDir() string {
	p := r.readPointer()
	if p.Modules == "" {
		return ""
	}
	return filepath.Join(r.Dir, p.Modules)
}

// CLIPath: cli.js của @playwright/test; "" nếu chưa cài.
func (r *Runtime) CLIPath() string {
	if m := r.ModulesDir(); m != "" {
		return filepath.Join(m, "node_modules", "@playwright", "test", "cli.js")
	}
	return ""
}

// PIDs: danh sách tiến trình Node đang sống (pids.json), một đối tượng dùng chung cho sidecar và bộ chạy
// test. App gọi PIDs().Reap() lúc khởi động, trước khi mở tiến trình Node nào.
func (r *Runtime) PIDs() *proc.PIDFile {
	r.pidOnce.Do(func() { r.pids = &proc.PIDFile{Path: filepath.Join(r.Dir, "pids.json")} })
	return r.pids
}

// BrowsersPath: giá trị PLAYWRIGHT_BROWSERS_PATH.
func (r *Runtime) BrowsersPath() string { return filepath.Join(r.Dir, "browsers") }

// WorkDir: thư mục tạm cho script sidecar và từng lượt chạy. Nằm dưới thư mục có node_modules vì Node tìm
// gói bằng cách đi ngược lên thư mục cha (ESM bỏ qua NODE_PATH); mất cùng phiên bản cũ khi Sweep.
func (r *Runtime) WorkDir() string {
	if m := r.ModulesDir(); m != "" {
		return filepath.Join(m, "work")
	}
	return ""
}

func exists(p string) bool {
	_, err := os.Stat(p)
	return p != "" && err == nil
}

func (r *Runtime) nodeReady() bool {
	return r.readPointer().Node == r.nodeDirName() && exists(r.NodePath())
}

func (r *Runtime) modulesReady() bool {
	if r.readPointer().Modules != r.modulesDirName() {
		return false
	}
	return exists(r.CLIPath()) && exists(filepath.Join(r.ModulesDir(), "node_modules", "typescript", "package.json"))
}

func (r *Runtime) browserReady(name string) bool {
	_, a, ok := r.artifact(name)
	return ok && exists(filepath.Join(r.BrowsersPath(), a.Dir, completeMarker))
}

// job: một thành phần cần cài, mỗi thành phần một khoá riêng (bốn gói npm chung một khoá).
type job struct {
	lock    string
	ready   func() bool
	install func(ctx context.Context, progress func(done, total int64)) error
}

// Ensure cài Node, bộ gói npm và các trình duyệt được yêu cầu nếu chưa có (chromium kéo theo ffmpeg).
// Đã đủ thì không gửi request nào. Từ chối (device_not_ready) khi bộ chạy đang được dùng; sai SHA-256 thì
// trả bad_checksum, không đổi con trỏ và không để lại thư mục dở.
func (r *Runtime) Ensure(ctx context.Context, browsers []string, progress func(component string, done, total int64)) error {
	if !r.supported() {
		return apperr.New(fetch.CodeUnavailable, "nền tảng không hỗ trợ")
	}
	if err := r.ownerErr(); err != nil {
		return err
	}
	jobs := []job{
		{lock: KindNode, ready: r.nodeReady, install: r.installNode},
		{lock: "modules", ready: r.modulesReady, install: r.installModules},
	}
	seen := map[string]bool{}
	for _, b := range browsers {
		if !isBrowser(b) {
			return apperr.New(apperr.CodeInvalid, "trình duyệt "+b)
		}
		names := []string{b}
		if b == "chromium" {
			names = append(names, "ffmpeg") // quay video của Chromium cần ffmpeg
		}
		for _, n := range names {
			if seen[n] {
				continue
			}
			seen[n] = true
			jobs = append(jobs, job{lock: "browser:" + n, ready: func() bool { return r.browserReady(n) },
				install: func(ctx context.Context, p func(done, total int64)) error { return r.installBrowser(ctx, n, p) }})
		}
	}
	var need []job
	for _, j := range jobs {
		if !j.ready() {
			need = append(need, j)
		}
	}
	if len(need) == 0 {
		return nil
	}
	if r.InUse != nil && r.InUse() {
		return apperr.New(codeDeviceNotReady, "bộ chạy trình duyệt đang được dùng: dừng các lượt chạy web rồi cài lại")
	}
	if err := os.MkdirAll(r.Dir, 0o755); err != nil {
		return err
	}
	for _, j := range need {
		if err := r.run(ctx, j, progress); err != nil {
			return err
		}
	}
	return nil
}

func (r *Runtime) run(ctx context.Context, j job, progress func(component string, done, total int64)) error {
	defer r.locks.Lock(j.lock)()
	if j.ready() { // lượt Ensure khác vừa cài xong trong lúc chờ khoá
		return nil
	}
	r.setInstalling(j.lock, true)
	defer r.setInstalling(j.lock, false)
	var p func(done, total int64)
	if progress != nil {
		p = func(done, total int64) { progress(strings.TrimPrefix(j.lock, "browser:"), done, total) }
	}
	return j.install(ctx, p)
}

func (r *Runtime) setInstalling(lock string, on bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.installing == nil {
		r.installing = map[string]bool{}
	}
	if on {
		r.installing[lock] = true
	} else {
		delete(r.installing, lock)
	}
}

func (r *Runtime) isInstalling(lock string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.installing[lock]
}

func isBrowser(name string) bool {
	for _, b := range Browsers {
		if b == name {
			return true
		}
	}
	return false
}

func (r *Runtime) download(ctx context.Context, key string, a Artifact, dest string, progress func(done, total int64)) error {
	url := a.URL
	if r.URL != nil {
		url = r.URL(key)
	}
	max := a.Size
	if max <= 0 {
		max = maxUnpinnedSize
	}
	return fetch.Download(ctx, fetch.Request{URL: url, SHA256: a.SHA256, Max: max, Client: r.Client, Progress: progress}, dest)
}

// stage tạo thư mục .staging-* trong parent; mọi file tải và giải nén của một lượt cài nằm trong đó, nên
// lượt cài bị giết giữa chừng chỉ để lại .staging-* cho Sweep xoá.
func stage(parent, label string) (string, func(), error) {
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return "", nil, err
	}
	dir, err := os.MkdirTemp(parent, ".staging-"+label+"-")
	if err != nil {
		return "", nil, err
	}
	return dir, func() { _ = os.RemoveAll(dir) }, nil
}

func missingPin(key string) error { return apperr.New(fetch.CodeUnavailable, "chưa ghim "+key) }

// place đổi tên thư mục đã giải nén đủ thành thư mục có phiên bản. Thư mục cùng tên chỉ có thể là phần
// sót của lượt cài bị giết (chưa được trỏ tới, hoặc hỏng), nên xoá trước.
func place(src, dst string) error {
	if err := os.RemoveAll(dst); err != nil {
		return err
	}
	return os.Rename(src, dst)
}

func (r *Runtime) installNode(ctx context.Context, progress func(done, total int64)) error {
	key, a, ok := r.artifact(KindNode)
	if !ok {
		return missingPin(key)
	}
	staging, cleanup, err := stage(r.Dir, "node")
	if err != nil {
		return err
	}
	defer cleanup()
	archive := filepath.Join(staging, "archive")
	if err := r.download(ctx, key, a, archive, progress); err != nil {
		return err
	}
	out := filepath.Join(staging, "out")
	only := map[string]bool{r.nodeBin(): true, "LICENSE": true} // bỏ npm/corepack và các symlink của chúng
	o := fetch.Options{Strip: 1, Include: func(n string) bool { return only[n] }}
	if strings.HasSuffix(a.URL, ".zip") {
		err = fetch.UnzipSafe(archive, out, o)
	} else {
		err = fetch.UntarGz(archive, out, o)
	}
	if err != nil {
		return apperr.Wrap(fetch.CodeUnavailable, err)
	}
	if !exists(filepath.Join(out, filepath.FromSlash(r.nodeBin()))) {
		return apperr.New(fetch.CodeUnavailable, "gói Node thiếu "+r.nodeBin())
	}
	removeQuarantine(out)
	dst := filepath.Join(r.Dir, r.nodeDirName())
	if err := place(out, dst); err != nil {
		return err
	}
	r.copyLicense(filepath.Join(dst, "LICENSE"), "node-LICENSE")
	return r.setPointer(func(p *pointer) { p.Node = r.nodeDirName() })
}

func (r *Runtime) installModules(ctx context.Context, progress func(done, total int64)) error {
	staging, cleanup, err := stage(r.Dir, "modules")
	if err != nil {
		return err
	}
	defer cleanup()
	out := filepath.Join(staging, "out")
	for _, name := range NPMPackages {
		key, a, ok := r.artifact("npm/" + name)
		if !ok {
			return missingPin(key)
		}
		archive := filepath.Join(staging, strings.ReplaceAll(name, "/", "__")+".tgz")
		if err := r.download(ctx, key, a, archive, progress); err != nil {
			return err
		}
		dest := filepath.Join(out, "node_modules", filepath.FromSlash(name))
		if err := fetch.UntarGz(archive, dest, fetch.Options{Strip: 1}); err != nil { // bỏ tiền tố package/
			return apperr.Wrap(fetch.CodeUnavailable, err)
		}
		_ = os.Remove(archive)
	}
	if err := os.MkdirAll(filepath.Join(out, "work"), 0o755); err != nil {
		return err
	}
	dst := filepath.Join(r.Dir, r.modulesDirName())
	if err := place(out, dst); err != nil {
		return err
	}
	core := filepath.Join(dst, "node_modules", "playwright-core")
	r.copyLicense(filepath.Join(core, "LICENSE"), "playwright-LICENSE")
	r.copyLicense(filepath.Join(core, "NOTICE"), "playwright-NOTICE")
	return r.setPointer(func(p *pointer) { p.Modules = r.modulesDirName() })
}

func (r *Runtime) installBrowser(ctx context.Context, name string, progress func(done, total int64)) error {
	key, a, ok := r.artifact(name)
	if !ok {
		return missingPin(key)
	}
	staging, cleanup, err := stage(r.BrowsersPath(), name)
	if err != nil {
		return err
	}
	defer cleanup()
	archive := filepath.Join(staging, "archive.zip")
	if err := r.download(ctx, key, a, archive, progress); err != nil {
		return err
	}
	out := filepath.Join(staging, "out")
	// Gói .app/.framework macOS cần symlink trong thư mục (Versions/Current).
	if err := fetch.UnzipSafe(archive, out, fetch.Options{AllowSymlinks: true}); err != nil {
		return apperr.Wrap(fetch.CodeUnavailable, err)
	}
	if err := os.WriteFile(filepath.Join(out, completeMarker), nil, 0o644); err != nil {
		return err
	}
	removeQuarantine(out)
	return place(out, filepath.Join(r.BrowsersPath(), a.Dir))
}

// copyLicense chép giấy phép vào LICENSES/ (bắt buộc đi kèm bản phân phối; thiếu file thì bỏ qua).
func (r *Runtime) copyLicense(src, name string) {
	b, err := os.ReadFile(src)
	if err != nil {
		return
	}
	dir := filepath.Join(r.Dir, "LICENSES")
	if os.MkdirAll(dir, 0o755) == nil {
		_ = os.WriteFile(filepath.Join(dir, name), b, 0o644)
	}
}

func (r *Runtime) state(lock string, pinned, ready bool) string {
	switch {
	case !r.supported() || !pinned:
		return StateUnsupported
	case r.isInstalling(lock):
		return StateInstalling
	case ready:
		return StateReady
	}
	return StateMissing
}

// Status: trạng thái từng thành phần và trình duyệt, cùng các kênh trình duyệt có sẵn trên máy.
func (r *Runtime) Status() Status {
	pins := r.pins()
	s := Status{Platform: r.platform(), Channels: detectChannels()}

	_, node, nodePinned := r.artifact(KindNode)
	nodeReady := r.nodeReady()
	s.Node = ComponentStatus{State: r.state(KindNode, nodePinned, nodeReady), Version: pins.Node}
	if !nodeReady {
		s.Node.Size = node.Size
	}

	modulesPinned, modulesSize := true, int64(0)
	for _, name := range NPMPackages {
		_, a, ok := r.artifact("npm/" + name)
		modulesPinned = modulesPinned && ok
		modulesSize += a.Size
	}
	modulesReady := r.modulesReady()
	s.Modules = ComponentStatus{State: r.state("modules", modulesPinned, modulesReady), Version: pins.Playwright + "-" + pins.TypeScript}
	if !modulesReady {
		s.Modules.Size = modulesSize
	}

	for _, b := range Browsers {
		names := []string{b}
		if b == "chromium" {
			names = append(names, "ffmpeg")
		}
		bs := BrowserStatus{Name: b}
		pinned, ready, installing := true, true, false
		for _, n := range names {
			_, a, ok := r.artifact(n)
			pinned = pinned && ok
			if !r.browserReady(n) {
				ready = false
				bs.Size += a.Size
			}
			installing = installing || r.isInstalling("browser:"+n)
		}
		bs.State = r.state("browser:"+b, pinned, ready)
		if installing && bs.State == StateMissing {
			bs.State = StateInstalling
		}
		if ready {
			bs.Size = 0
		}
		s.Browsers = append(s.Browsers, bs)
	}
	return s
}

// Sweep xoá phiên bản cũ không còn được trỏ tới, trình duyệt không còn ghim, và phần sót của lượt cài bị
// giết (.staging-*, *.part). Chỉ gọi lúc app khởi động, trước khi sidecar chạy; từ chối khi đang cài hoặc
// đang dùng.
func (r *Runtime) Sweep() error {
	if err := r.ownerErr(); err != nil {
		return err
	}
	r.mu.Lock()
	busy := len(r.installing) > 0
	r.mu.Unlock()
	if busy || (r.InUse != nil && r.InUse()) {
		return apperr.New(codeDeviceNotReady, "bộ chạy trình duyệt đang được dùng")
	}
	p := r.readPointer()
	var errs []error
	sweepDir(r.Dir, func(name string, dir bool) bool {
		switch {
		case strings.HasPrefix(name, "node-"):
			return dir && name != p.Node
		case strings.HasPrefix(name, "modules-"):
			return dir && name != p.Modules
		}
		return false
	}, &errs)
	keep := map[string]bool{}
	prefix := r.platform() + "/"
	for k, a := range r.pins().Artifacts {
		if a.Kind == KindBrowser && strings.HasPrefix(k, prefix) {
			keep[a.Dir] = true
		}
	}
	sweepDir(r.BrowsersPath(), func(name string, dir bool) bool {
		return dir && !strings.HasPrefix(name, ".") && !keep[name]
	}, &errs)
	return errors.Join(errs...)
}

// sweepDir xoá trong dir mọi .staging-*, *.part và mục mà extra chọn.
func sweepDir(dir string, extra func(name string, dir bool) bool, errs *[]error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			*errs = append(*errs, err)
		}
		return
	}
	for _, e := range entries {
		n := e.Name()
		if strings.HasPrefix(n, ".staging-") || strings.HasSuffix(n, ".part") || extra(n, e.IsDir()) {
			if err := os.RemoveAll(filepath.Join(dir, n)); err != nil {
				*errs = append(*errs, err)
			}
		}
	}
}
