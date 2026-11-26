package pw

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"chatqa/internal/fetch"
	"deskcore/apperr"
)

// Tiến trình phụ: chính binary test chạy lại.
//   - CQS_PW_HELPER=ensure: chạy Ensure với pin đọc từ file (test giết giữa lúc giải nén).
//   - CQS_PW_HELPER=sleep: ngủ 60s (tiến trình con mà phiên bản app đang chạy ghi trong pids.json).
//   - tham số fakeSidecarArg <mode>: sidecar giả nói NDJSON (sidecar_test.go).
func TestMain(m *testing.M) {
	if len(os.Args) > 2 && os.Args[1] == fakeSidecarArg {
		fakeSidecar(os.Args[2])
		return
	}
	if os.Getenv("CQS_PW_HELPER") == "sleep" {
		time.Sleep(60 * time.Second)
		os.Exit(0)
	}
	if os.Getenv("CQS_PW_HELPER") == "ensure" {
		var pins Pins
		b, err := os.ReadFile(os.Getenv("CQS_PW_PINS"))
		if err != nil || json.Unmarshal(b, &pins) != nil {
			os.Exit(3)
		}
		r := &Runtime{Dir: os.Getenv("CQS_PW_DIR"), Pins: &pins, Platform: "darwin/arm64"}
		if err := r.Ensure(context.Background(), nil, nil); err != nil {
			os.Exit(4)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

type file struct {
	name, body string
	mode       int64
}

func tgz(t testing.TB, files []file) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz, _ := gzip.NewWriterLevel(&buf, gzip.BestSpeed)
	tw := tar.NewWriter(gz)
	for _, f := range files {
		mode := f.mode
		if mode == 0 {
			mode = 0o644
		}
		if err := tw.WriteHeader(&tar.Header{Name: f.name, Typeflag: tar.TypeReg, Mode: mode, Size: int64(len(f.body))}); err != nil {
			t.Fatal(err)
		}
		tw.Write([]byte(f.body))
	}
	tw.Close()
	gz.Close()
	return buf.Bytes()
}

func zipOf(t testing.TB, files []file) []byte {
	t.Helper()
	var buf bytes.Buffer
	w := zip.NewWriter(&buf)
	for _, f := range files {
		h := &zip.FileHeader{Name: f.name, Method: zip.Deflate}
		h.SetMode(0o755)
		fw, err := w.CreateHeader(h)
		if err != nil {
			t.Fatal(err)
		}
		fw.Write([]byte(f.body))
	}
	w.Close()
	return buf.Bytes()
}

func sum(b []byte) string { s := sha256.Sum256(b); return hex.EncodeToString(s[:]) }

// cdn: máy chủ thử phục vụ artifact theo đường dẫn và đếm số lần tải mỗi đường dẫn.
type cdn struct {
	srv   *httptest.Server
	mu    sync.Mutex
	files map[string][]byte
	hits  map[string]int
}

func newCDN(t *testing.T) *cdn {
	c := &cdn{files: map[string][]byte{}, hits: map[string]int{}}
	c.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c.mu.Lock()
		body, ok := c.files[r.URL.Path]
		c.hits[r.URL.Path]++
		c.mu.Unlock()
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Write(body)
	}))
	t.Cleanup(c.srv.Close)
	return c
}

func (c *cdn) total() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	n := 0
	for _, v := range c.hits {
		n += v
	}
	return n
}

// add phục vụ body ở path và trả artifact đã ghim đúng.
func (c *cdn) add(path string, body []byte, a Artifact) Artifact {
	c.mu.Lock()
	c.files[path] = body
	c.mu.Unlock()
	a.URL, a.SHA256, a.Size = c.srv.URL+path, sum(body), int64(len(body))
	return a
}

// fixturePins: bộ ghim darwin/arm64 trỏ vào máy chủ thử. node: phiên bản Node; nodeBody: nội dung bin/node.
func fixturePins(t testing.TB, c *cdn, node, playwright string, nodeBody string) *Pins {
	p := &Pins{Node: node, Playwright: playwright, TypeScript: "5.0.0", Artifacts: map[string]Artifact{}}
	p.Artifacts["darwin/arm64/node"] = c.add("/node-"+node+".tar.gz", tgz(t, []file{
		{name: "node-v" + node + "-darwin-arm64/bin/node", body: nodeBody, mode: 0o755},
		{name: "node-v" + node + "-darwin-arm64/LICENSE", body: "mit"},
		{name: "node-v" + node + "-darwin-arm64/lib/npm-cli.js", body: "npm"},
	}), Artifact{Kind: KindNode})
	for _, name := range NPMPackages {
		files := []file{{name: "package/package.json", body: `{"name":"` + name + `"}`}}
		switch name {
		case "@playwright/test":
			files = append(files, file{name: "package/cli.js", body: "cli"})
		case "playwright-core":
			files = append(files, file{name: "package/LICENSE", body: "apache"}, file{name: "package/NOTICE", body: "notice"})
		}
		p.Artifacts["npm/"+name] = c.add("/npm/"+name+"-"+playwright+".tgz", tgz(t, files), Artifact{Kind: KindNPM})
	}
	for _, b := range []string{"chromium", "ffmpeg"} {
		p.Artifacts["darwin/arm64/"+b] = c.add("/"+b+".zip", zipOf(t, []file{{name: b + "-mac/" + b, body: b}}),
			Artifact{Kind: KindBrowser, Dir: b + "-1", Rev: "1"})
	}
	return p
}

func TestEnsureInstallsVersionedDirsThenPointer(t *testing.T) {
	c := newCDN(t)
	r := &Runtime{Dir: t.TempDir(), Pins: fixturePins(t, c, "1.0.0", "1.1.0", "#!node"), Platform: "darwin/arm64"}
	if st := r.Status(); st.Node.State != StateMissing || st.Modules.State != StateMissing || st.Node.Size == 0 {
		t.Fatalf("chưa cài: %+v", st)
	}
	seen := map[string]bool{}
	var mu sync.Mutex
	err := r.Ensure(context.Background(), []string{"chromium"}, func(comp string, _, _ int64) {
		mu.Lock()
		seen[comp] = true
		mu.Unlock()
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, comp := range []string{"node", "modules", "chromium", "ffmpeg"} {
		if !seen[comp] {
			t.Errorf("không báo tiến độ cho %s", comp)
		}
	}
	b, _ := os.ReadFile(filepath.Join(r.Dir, pointerFile))
	var p pointer
	if json.Unmarshal(b, &p) != nil || p.Node != "node-1.0.0" || p.Modules != "modules-1.1.0-5.0.0" {
		t.Fatalf("current.json = %s", b)
	}
	for _, path := range []string{
		r.NodePath(), r.CLIPath(), r.WorkDir(),
		filepath.Join(r.ModulesDir(), "node_modules", "typescript", "package.json"),
		filepath.Join(r.BrowsersPath(), "chromium-1", completeMarker),
		filepath.Join(r.BrowsersPath(), "ffmpeg-1", completeMarker),
		filepath.Join(r.Dir, "LICENSES", "node-LICENSE"),
		filepath.Join(r.Dir, "LICENSES", "playwright-NOTICE"),
	} {
		if !exists(path) {
			t.Errorf("thiếu %s", path)
		}
	}
	if strings.Contains(r.NodePath(), "lib") || exists(filepath.Join(r.Dir, "node-1.0.0", "lib")) {
		t.Error("chỉ giải nén node và LICENSE")
	}
	st := r.Status()
	if st.Node.State != StateReady || st.Modules.State != StateReady || st.Browsers[0].Name != "chromium" || st.Browsers[0].State != StateReady {
		t.Fatalf("đã cài: %+v", st)
	}
	if st.Browsers[1].State != StateUnsupported { // firefox chưa ghim trong bộ thử
		t.Fatalf("firefox không có pin phải là unsupported: %+v", st.Browsers[1])
	}

	before := c.total()
	if err := r.Ensure(context.Background(), []string{"chromium"}, nil); err != nil || c.total() != before {
		t.Fatalf("lần 2 không được tải: hits %d -> %d, err %v", before, c.total(), err)
	}
	leftovers, _ := filepath.Glob(filepath.Join(r.Dir, ".staging-*"))
	more, _ := filepath.Glob(filepath.Join(r.BrowsersPath(), ".staging-*"))
	if len(leftovers)+len(more) != 0 {
		t.Fatalf("còn thư mục tạm: %v %v", leftovers, more)
	}
}

func TestEnsureBadChecksumKeepsPointer(t *testing.T) {
	c := newCDN(t)
	dir := t.TempDir()
	old := &Runtime{Dir: dir, Pins: fixturePins(t, c, "1.0.0", "1.1.0", "#!node"), Platform: "darwin/arm64"}
	if err := old.Ensure(context.Background(), nil, nil); err != nil {
		t.Fatal(err)
	}
	ptr, _ := os.ReadFile(filepath.Join(dir, pointerFile))

	pins := fixturePins(t, c, "1.0.0", "1.2.0", "#!node")
	a := pins.Artifacts["npm/typescript"]
	a.SHA256 = sum([]byte("khác"))
	pins.Artifacts["npm/typescript"] = a
	r := &Runtime{Dir: dir, Pins: pins, Platform: "darwin/arm64"}
	if err := r.Ensure(context.Background(), nil, nil); apperr.CodeOf(err) != fetch.CodeBadChecksum {
		t.Fatalf("err = %v, muốn bad_checksum", err)
	}
	if now, _ := os.ReadFile(filepath.Join(dir, pointerFile)); !bytes.Equal(now, ptr) {
		t.Fatalf("con trỏ đổi: %s -> %s", ptr, now)
	}
	if exists(filepath.Join(dir, "modules-1.2.0-5.0.0")) {
		t.Fatal("không được để lại thư mục phiên bản dở")
	}
	if left, _ := filepath.Glob(filepath.Join(dir, ".staging-*")); len(left) != 0 {
		t.Fatalf("còn thư mục tạm: %v", left)
	}
	if old.Status().Modules.State != StateReady {
		t.Fatal("bộ gói cũ phải còn dùng được")
	}
}

func TestConcurrentEnsureDownloadsEachTarballOnce(t *testing.T) {
	c := newCDN(t)
	r := &Runtime{Dir: t.TempDir(), Pins: fixturePins(t, c, "1.0.0", "1.1.0", "#!node"), Platform: "darwin/arm64"}
	var wg sync.WaitGroup
	errs := make(chan error, 6)
	for range 6 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs <- r.Ensure(context.Background(), nil, nil)
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	for path, n := range c.hits {
		if n != 1 {
			t.Errorf("%s tải %d lần", path, n)
		}
	}
}

func TestEnsureRefusedWhileInUse(t *testing.T) {
	c := newCDN(t)
	r := &Runtime{Dir: t.TempDir(), Pins: fixturePins(t, c, "1.0.0", "1.1.0", "#!node"), Platform: "darwin/arm64",
		InUse: func() bool { return true }}
	if err := r.Ensure(context.Background(), nil, nil); apperr.CodeOf(err) != codeDeviceNotReady {
		t.Fatalf("err = %v, muốn device_not_ready", err)
	}
	if c.total() != 0 {
		t.Fatal("đang dùng thì không được tải")
	}
	if err := r.Sweep(); apperr.CodeOf(err) != codeDeviceNotReady {
		t.Fatalf("Sweep khi đang dùng: %v", err)
	}
}

func TestEnsureRejectsUnknownBrowserAndUnsupportedPlatform(t *testing.T) {
	c := newCDN(t)
	pins := fixturePins(t, c, "1.0.0", "1.1.0", "#!node")
	r := &Runtime{Dir: t.TempDir(), Pins: pins, Platform: "darwin/arm64"}
	if err := r.Ensure(context.Background(), []string{"msedge"}, nil); apperr.CodeOf(err) != apperr.CodeInvalid {
		t.Fatalf("msedge là kênh có sẵn, không tải: %v", err)
	}
	r = &Runtime{Dir: t.TempDir(), Pins: pins, Platform: "linux/amd64"}
	err := r.Ensure(context.Background(), nil, nil)
	if apperr.CodeOf(err) != fetch.CodeUnavailable || !strings.Contains(err.Error(), "nền tảng không hỗ trợ") {
		t.Fatalf("err = %v", err)
	}
	if st := r.Status(); st.Node.State != StateUnsupported || st.Modules.State != StateUnsupported || st.Browsers[0].State != StateUnsupported {
		t.Fatalf("nền tảng không hỗ trợ: %+v", st)
	}
	if c.total() != 0 {
		t.Fatal("không được tải gì")
	}
}

func TestEnsureMissingPinIsUnavailable(t *testing.T) {
	c := newCDN(t)
	pins := fixturePins(t, c, "1.0.0", "1.1.0", "#!node")
	delete(pins.Artifacts, "darwin/arm64/node")
	r := &Runtime{Dir: t.TempDir(), Pins: pins, Platform: "darwin/arm64"}
	if err := r.Ensure(context.Background(), nil, nil); apperr.CodeOf(err) != fetch.CodeUnavailable {
		t.Fatalf("err = %v", err)
	}
	if r.Status().Node.State != StateUnsupported {
		t.Fatal("thiếu pin thì Status báo unsupported")
	}
}

func TestSweepRemovesOldVersionsAndLeftovers(t *testing.T) {
	c := newCDN(t)
	r := &Runtime{Dir: t.TempDir(), Pins: fixturePins(t, c, "1.0.0", "1.1.0", "#!node"), Platform: "darwin/arm64"}
	if err := r.Ensure(context.Background(), []string{"chromium"}, nil); err != nil {
		t.Fatal(err)
	}
	junk := []string{
		filepath.Join(r.Dir, "node-0.9.0"),
		filepath.Join(r.Dir, "modules-1.0.0-4.0.0"),
		filepath.Join(r.Dir, ".staging-node-123"),
		filepath.Join(r.BrowsersPath(), "chromium-0"),
		filepath.Join(r.BrowsersPath(), ".staging-chromium-1"),
	}
	for _, d := range junk {
		if err := os.MkdirAll(filepath.Join(d, "x"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for _, f := range []string{filepath.Join(r.Dir, "archive.part"), filepath.Join(r.BrowsersPath(), "a.zip.part")} {
		os.WriteFile(f, []byte("x"), 0o644)
		junk = append(junk, f)
	}
	if err := r.Sweep(); err != nil {
		t.Fatal(err)
	}
	for _, j := range junk {
		if _, err := os.Lstat(j); err == nil {
			t.Errorf("chưa xoá %s", j)
		}
	}
	st := r.Status()
	if st.Node.State != StateReady || st.Modules.State != StateReady || st.Browsers[0].State != StateReady {
		t.Fatalf("Sweep xoá nhầm phiên bản đang trỏ: %+v", st)
	}
}

func TestKillDuringExtractKeepsOldStateAndSweepCleans(t *testing.T) {
	c := newCDN(t)
	dir := t.TempDir()
	old := &Runtime{Dir: dir, Pins: fixturePins(t, c, "1.0.0", "1.1.0", "#!node"), Platform: "darwin/arm64"}
	if err := old.Ensure(context.Background(), nil, nil); err != nil {
		t.Fatal(err)
	}
	before := old.Status()
	ptr, _ := os.ReadFile(filepath.Join(dir, pointerFile))

	// Bản Node mới có file 256MB toàn số 0: nén còn vài trăm KB, giải nén đủ lâu để giết giữa chừng.
	newPins := fixturePins(t, c, "2.0.0", "1.1.0", strings.Repeat("\x00", 256<<20))
	pinsPath := filepath.Join(t.TempDir(), "pins.json")
	b, _ := json.Marshal(newPins)
	if err := os.WriteFile(pinsPath, b, 0o644); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(os.Args[0], "-test.run=^$")
	cmd.Env = append(os.Environ(), "CQS_PW_HELPER=ensure", "CQS_PW_DIR="+dir, "CQS_PW_PINS="+pinsPath)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	extracting := false
	for deadline := time.Now().Add(30 * time.Second); time.Now().Before(deadline); time.Sleep(time.Millisecond) {
		if bins, _ := filepath.Glob(filepath.Join(dir, ".staging-node-*", "out", "bin", "node")); len(bins) > 0 {
			extracting = true
			break
		}
	}
	_ = cmd.Process.Kill() // SIGKILL trên POSIX, TerminateProcess trên Windows
	waitErr := cmd.Wait()
	if !extracting {
		t.Fatalf("tiến trình phụ chưa tới bước giải nén (wait: %v)", waitErr)
	}
	if waitErr == nil {
		t.Fatal("tiến trình phụ cài xong trước khi bị giết: tăng kích thước file thử")
	}

	if now, _ := os.ReadFile(filepath.Join(dir, pointerFile)); !bytes.Equal(now, ptr) {
		t.Fatalf("con trỏ đổi sau khi bị giết: %s -> %s", ptr, now)
	}
	if after := old.Status(); after.Node != before.Node || after.Modules != before.Modules {
		t.Fatalf("trạng thái đổi: %+v -> %+v", before, after)
	}
	if left, _ := filepath.Glob(filepath.Join(dir, ".staging-*")); len(left) == 0 {
		t.Fatal("muốn còn phần sót của lượt cài bị giết để kiểm tra Sweep")
	}
	if err := (&Runtime{Dir: dir, Pins: newPins, Platform: "darwin/arm64"}).Sweep(); err != nil {
		t.Fatal(err)
	}
	if left, _ := filepath.Glob(filepath.Join(dir, ".staging-*")); len(left) != 0 {
		t.Fatalf("Sweep chưa xoá phần sót: %v", left)
	}
	if old.Status().Node.State != StateReady || !exists(old.NodePath()) {
		t.Fatal("Sweep xoá nhầm Node đang trỏ")
	}
}

func TestChannelPaths(t *testing.T) {
	env := map[string]string{"LOCALAPPDATA": `C:\Users\a\AppData\Local`, "PROGRAMFILES": `C:\Program Files`}
	paths := channelPaths("windows", func(k string) string { return env[k] })
	if len(paths["msedge"]) != 2 || !strings.HasSuffix(paths["msedge"][1], "msedge.exe") {
		t.Fatalf("msedge: %v", paths["msedge"])
	}
	has := func(p string) bool { return p == paths["msedge"][1] }
	st := channelStatus(paths, has)
	if len(st) != 2 || st[0] != (ChannelStatus{Name: "msedge", Installed: true}) || st[1].Installed {
		t.Fatalf("status = %+v", st)
	}
	if len(channelPaths("darwin", nil)["chrome"]) != 1 {
		t.Fatal("macOS dò Google Chrome trong /Applications")
	}
}

func TestSecondInstanceStartupLeavesLiveHolderUntouched(t *testing.T) {
	dir := t.TempDir()
	first := &Runtime{Dir: dir, Platform: "darwin/arm64"}
	if owner, _, err := first.Startup(); !owner || err != nil {
		t.Fatalf("phiên bản đầu: owner=%v err=%v", owner, err)
	}
	t.Cleanup(first.Release)
	child := exec.Command(os.Args[0], "-test.run=^$")
	child.Env = append(os.Environ(), "CQS_PW_HELPER=sleep")
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = child.Process.Kill() })
	done := make(chan struct{})
	go func() { _, _ = child.Process.Wait(); close(done) }()
	if err := first.PIDs().Add(child.Process.Pid, false); err != nil {
		t.Fatal(err)
	}
	staging := filepath.Join(dir, ".staging-node-1")
	if err := os.MkdirAll(staging, 0o755); err != nil {
		t.Fatal(err)
	}

	second := &Runtime{Dir: dir, Platform: "darwin/arm64"}
	owner, n, err := second.Startup()
	if owner || n != 0 || err != nil {
		t.Fatalf("phiên bản thứ hai: owner=%v reaped=%d err=%v; muốn không giữ khoá, không dọn gì", owner, n, err)
	}
	select {
	case <-done:
		t.Fatal("phiên bản thứ hai giết tiến trình của phiên bản đang chạy")
	case <-time.After(300 * time.Millisecond):
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "pids.json")); !strings.Contains(string(b), strconv.Itoa(child.Process.Pid)) {
		t.Fatalf("pids.json mất bản ghi của phiên bản đang chạy: %s", b)
	}
	if _, err := os.Stat(staging); err != nil {
		t.Fatalf("phần đang cài bị xoá: %v", err)
	}
	for name, err := range map[string]error{
		"Ensure": second.Ensure(context.Background(), nil, nil),
		"Sweep":  second.Sweep(),
		"Sidecar.Start": func() error {
			_, err := (&Sidecar{RT: second}).Start(context.Background())
			return err
		}(),
		"Runner.Run": func() error {
			_, err := (&Runner{RT: second}).Run(context.Background(), Job{}, nil)
			return err
		}(),
	} {
		if apperr.CodeOf(err) != codeDeviceNotReady {
			t.Errorf("%s ở phiên bản không giữ khoá = %v; muốn device_not_ready", name, err)
		}
	}

	// Phiên bản đầu thoát (khoá nhả): lần khởi động sau mới dọn tiến trình mồ côi.
	first.Release()
	third := &Runtime{Dir: dir, Platform: "darwin/arm64"}
	t.Cleanup(third.Release)
	if owner, n, err := third.Startup(); !owner || n != 1 || err != nil {
		t.Fatalf("khởi động sau khi nhả khoá: owner=%v reaped=%d err=%v", owner, n, err)
	}
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("tiến trình mồ côi chưa bị giết")
	}
	if _, err := os.Stat(staging); err == nil {
		t.Fatal("chưa dọn phần cài dở")
	}
}
