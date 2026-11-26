package pw

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	goruntime "runtime"
	"strconv"
	"sync"
	"time"

	"chatqa/internal/proc"
	"deskcore/apperr"
)

const (
	defaultCallTimeout = 30 * time.Second // lệnh không có hạn chót từ bên gọi
	closeCallTimeout   = time.Second      // dọn phiên không bao giờ giữ bên gọi lâu hơn
	helloTimeout       = 20 * time.Second
	stopGrace          = 2 * time.Second
	restartWindow      = time.Minute
	maxRestarts        = 3
	uptimeForReset     = time.Minute // open thành công sau chừng này thời gian sống thì xoá bộ đếm khởi động lại
	stderrBurst        = 20          // tối đa số dòng stderr ghi log trong mỗi stderrWindow
	stderrWindow       = 10 * time.Second
	stderrLineMax      = 500 // byte tối đa mỗi dòng stderr ghi log
)

// Sidecar: một tiến trình Node (bootstrap.mjs + sidecar.mjs) điều khiển trình duyệt cho mọi hồ sơ, nói
// JSON-RPC qua stdio. Mở lười ở lần dùng đầu (Start). Chết bất thường thì lần Start sau mở lại, tối đa
// maxRestarts lần mỗi phút; quá thì trả web_sidecar_failed tới khi ResetRestarts hoặc hết cửa sổ.
//
// Mỗi lần mở tăng thế hệ (Gen). Phiên trình duyệt chỉ sống trong thế hệ đã mở nó: Call với thế hệ cũ trả
// lỗi bọc ErrSidecarDown và không bao giờ mở tiến trình mới, nên lệnh dọn phiên cũ là vô hại.
type Sidecar struct {
	RT *Runtime
	// Log ghi log (stderr của Node đã giới hạn tốc độ, lần thoát bất thường); nil = log.Printf.
	Log func(format string, args ...any)
	// Scrub che giá trị bí mật trong một dòng stderr của Node trước khi ghi log (lỗi Playwright không bắt được có thể
	// chứa chữ đã điền); nil = không che.
	Scrub func(line string) string
	// OnDown(gen) chạy sau khi tiến trình thế hệ gen thoát vì bất kỳ lý do gì (mọi phiên của nó đã mất).
	// Chạy ngoài mọi khoá của Sidecar; không được gọi Close/Start đồng bộ trong đó.
	OnDown func(gen int)

	command func() (*exec.Cmd, error) // test thay lệnh node bằng tiến trình giả

	startMu  sync.Mutex // một lượt mở/đóng tiến trình một lúc
	mu       sync.Mutex // gen, cur, failed, restarts
	gen      int
	cur      *conn
	failed   bool // tiến trình trước thoát bất thường hoặc mở hỏng: lần mở tới tính là khởi động lại
	restarts []time.Time
}

type conn struct {
	gen     int
	tree    *proc.Tree
	stdin   io.WriteCloser
	started time.Time
	done    chan struct{} // tiến trình đã thoát, mọi lệnh đang chờ đã nhận lỗi
	gone    chan struct{} // Sidecar đã bỏ conn này (cur != conn)

	wmu sync.Mutex // ghi stdin

	mu       sync.Mutex
	nextID   int64
	pending  map[int64]chan reply
	closed   map[string]bool // phiên sidecar báo đã đóng (sự kiện closed)
	children map[int]bool    // tiến trình con trực tiếp của Node (trình duyệt), đã ghi vào pids.json
	stopping bool            // Close chủ động dừng: không tính là chết bất thường
}

type request struct {
	ID     int64  `json:"id"`
	Method string `json:"method"`
	Params any    `json:"params,omitempty"`
}

type reply struct {
	ID     int64           `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
	Event   string `json:"event"`
	Session string `json:"session"`
}

func (c *conn) alive() bool {
	select {
	case <-c.done:
		return false
	default:
		return true
	}
}

func (s *Sidecar) logf(format string, args ...any) {
	if s.Log != nil {
		s.Log(format, args...)
		return
	}
	log.Printf(format, args...)
}

// Gen: thế hệ của lần mở gần nhất (0 khi chưa mở lần nào).
func (s *Sidecar) Gen() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.gen
}

// Running: tiến trình đang sống (bộ chạy đang được dùng, không được cài đè).
func (s *Sidecar) Running() bool {
	s.mu.Lock()
	c := s.cur
	s.mu.Unlock()
	return c != nil && c.alive()
}

// ResetRestarts xoá bộ đếm khởi động lại (sau Prepare hay cài bộ chạy thành công).
func (s *Sidecar) ResetRestarts() {
	s.mu.Lock()
	s.restarts = nil
	s.mu.Unlock()
}

// Closed: sidecar đã báo phiên session của thế hệ gen đóng (trình duyệt/trang bị đóng), hoặc thế hệ đó
// không còn chạy. Phiên như vậy phải mở lại.
func (s *Sidecar) Closed(gen int, session string) bool {
	s.mu.Lock()
	c := s.cur
	s.mu.Unlock()
	if c == nil || c.gen != gen || !c.alive() {
		return true
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.closed[session]
}

// Start mở tiến trình nếu chưa chạy và trả thế hệ đang chạy. Chỉ Start mở tiến trình; Call thì không.
func (s *Sidecar) Start(ctx context.Context) (int, error) {
	if s.RT != nil {
		if err := s.RT.ownerErr(); err != nil {
			return 0, err
		}
	}
	s.startMu.Lock()
	defer s.startMu.Unlock()
	s.mu.Lock()
	c := s.cur
	s.mu.Unlock()
	if c != nil {
		if c.alive() {
			return c.gen, nil
		}
		<-c.gone
	}
	s.mu.Lock()
	if s.failed {
		now := time.Now()
		keep := s.restarts[:0]
		for _, t := range s.restarts {
			if now.Sub(t) < restartWindow {
				keep = append(keep, t)
			}
		}
		s.restarts = keep
		if len(keep) >= maxRestarts {
			s.mu.Unlock()
			return 0, apperr.New(CodeSidecarFailed, fmt.Sprintf("chết lặp lại %d lần trong 1 phút, tạm ngừng mở lại", maxRestarts))
		}
		s.restarts = append(s.restarts, now)
	}
	s.gen++
	gen := s.gen
	s.mu.Unlock()

	c, err := s.spawn(ctx, gen)
	s.mu.Lock()
	defer s.mu.Unlock()
	if err == nil && !c.alive() {
		err = downErr("tiến trình điều khiển thoát ngay sau khi mở")
	}
	if err != nil {
		if apperr.CodeOf(err) != CodeRuntimeMissing {
			s.failed = true
		}
		return 0, err
	}
	s.cur = c
	s.failed = false
	return gen, nil
}

// prepare dựng lệnh node bootstrap.mjs sidecar.mjs trong thư mục work của bộ chạy.
func (s *Sidecar) prepare() (*exec.Cmd, error) {
	if s.command != nil {
		return s.command()
	}
	node, modules, work := s.RT.NodePath(), s.RT.ModulesDir(), s.RT.WorkDir()
	if !exists(node) || work == "" || !exists(filepath.Join(modules, "node_modules", "playwright-core", "package.json")) {
		return nil, apperr.New(CodeRuntimeMissing, "")
	}
	dir := filepath.Join(work, "sidecar")
	if err := Install(dir); err != nil {
		return nil, apperr.Wrap(CodeSidecarFailed, err)
	}
	cmd := exec.Command(node, filepath.Join(dir, "bootstrap.mjs"), filepath.Join(dir, "sidecar.mjs"))
	cmd.Dir = dir
	return cmd, nil
}

func (s *Sidecar) spawn(ctx context.Context, gen int) (*conn, error) {
	if s.RT == nil {
		return nil, apperr.New(CodeRuntimeMissing, "")
	}
	cmd, err := s.prepare()
	if err != nil {
		return nil, err
	}
	cmd.Env = ChildEnv(os.Environ(), []EnvVar{
		{"PLAYWRIGHT_BROWSERS_PATH", s.RT.BrowsersPath()},
		{"CQS_SIDECAR_GEN", strconv.Itoa(gen)},
	})
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}
	// exec.Command thường + KillTree tường minh: CommandContext chỉ giết tiến trình gốc, bỏ sót trình duyệt.
	tree, err := proc.Start(cmd, stdin)
	if err != nil {
		return nil, apperr.Wrap(CodeSidecarFailed, err)
	}
	c := &conn{
		gen: gen, tree: tree, stdin: stdin, started: time.Now(),
		done: make(chan struct{}), gone: make(chan struct{}),
		pending: map[int64]chan reply{}, closed: map[string]bool{}, children: map[int]bool{},
	}
	pid := tree.PID()
	if err := s.RT.PIDs().Add(pid, goruntime.GOOS != "windows"); err != nil {
		s.logf("sidecar: không ghi được pids.json: %v", err)
	}
	go c.readReplies(stdout, s)
	go s.readStderr(gen, stderr)
	go func() {
		err := tree.Wait()
		s.exited(c, pid, err)
	}()

	// Cổng bootstrap: chỉ sau khi tiến trình đã nằm trong nhóm/Job thì Node mới được nạp script.
	if _, err := io.WriteString(stdin, "start\n"); err != nil {
		c.kill()
		return nil, downErr("không gửi được lệnh start: " + err.Error())
	}
	hctx, cancel := context.WithTimeout(ctx, helloTimeout)
	defer cancel()
	var hello struct {
		Playwright string `json:"playwright"`
		Node       string `json:"node"`
	}
	if err := c.call(hctx, "hello", nil, &hello); err != nil {
		c.kill() // hạn chót của bên gọi hết hoặc tiến trình không trả lời: dọn cả cây
		return nil, err
	}
	if want := s.RT.pins().Playwright; hello.Playwright != want {
		c.kill()
		return nil, apperr.New(CodeSidecarFailed, fmt.Sprintf("Playwright %s khác bản ghim %s", hello.Playwright, want))
	}
	return c, nil
}

// kill dừng cả cây tiến trình của một lần mở hỏng.
func (c *conn) kill() {
	c.mu.Lock()
	c.stopping = true
	c.mu.Unlock()
	c.tree.KillTree(stopGrace)
}

// exited: tiến trình đã thoát. Mọi lệnh đang chờ nhận ErrSidecarDown, Sidecar bỏ conn, rồi OnDown.
func (s *Sidecar) exited(c *conn, pid int, err error) {
	close(c.done)
	c.mu.Lock()
	stopping := c.stopping
	kids := make([]int, 0, len(c.children))
	for k := range c.children {
		kids = append(kids, k)
	}
	c.mu.Unlock()
	// Playwright mở trình duyệt trong nhóm tiến trình riêng, nên Node chết đột ngột (bị giết, hết bộ nhớ)
	// thì trình duyệt sống tiếp. Giết các trình duyệt đã ghi; sau Close chúng đã đóng, lệnh này vô hại.
	if _, err := s.RT.PIDs().Kill(kids); err != nil {
		s.logf("sidecar: không dừng được trình duyệt của tiến trình đã chết: %v", err)
	}
	if err := s.RT.PIDs().Remove(pid); err != nil {
		s.logf("sidecar: không cập nhật được pids.json: %v", err)
	}
	if !stopping {
		s.logf("sidecar: tiến trình thế hệ %d thoát bất thường: %v", c.gen, err)
	}

	s.mu.Lock()
	wasCur := s.cur == c
	if wasCur {
		s.cur = nil
	}
	if !stopping {
		s.failed = true
	}
	s.mu.Unlock()
	close(c.gone)

	if wasCur && s.OnDown != nil {
		s.OnDown(c.gen)
	}
}

// Close dừng tiến trình (đóng stdin: bootstrap gửi SIGTERM cho cả nhóm và Playwright đóng các trình duyệt;
// quá stopGrace thì giết cả cây). Không phải là chết bất thường. Lần Start sau mở lại bình thường.
func (s *Sidecar) Close() error {
	s.startMu.Lock()
	defer s.startMu.Unlock()
	s.mu.Lock()
	c := s.cur
	s.mu.Unlock()
	if c == nil {
		return nil
	}
	c.kill()
	<-c.gone
	return nil
}

// Call gửi một lệnh tới tiến trình thế hệ gen và giải kết quả vào out (có thể nil). Thế hệ không còn chạy
// thì trả lỗi bọc ErrSidecarDown ngay. Không có hạn chót thì dùng 30 s; close luôn bị chặn ở 1 s.
func (s *Sidecar) Call(ctx context.Context, gen int, method string, params, out any) error {
	s.mu.Lock()
	c := s.cur
	s.mu.Unlock()
	if c == nil || c.gen != gen || !c.alive() {
		return downErr(fmt.Sprintf("phiên thuộc tiến trình điều khiển thế hệ %d, tiến trình đó đã dừng", gen))
	}
	err := c.call(ctx, method, params, out)
	if method == "open" {
		s.trackChildren(c) // cả khi open lỗi: trình duyệt có thể đã mở xong trước lỗi
	}
	if err == nil && method == "open" {
		if session := sessionOf(params); session != "" {
			c.mu.Lock()
			delete(c.closed, session)
			c.mu.Unlock()
		}
		if time.Since(c.started) >= uptimeForReset {
			s.ResetRestarts()
		}
	}
	return err
}

// trackChildren ghi các tiến trình con hiện có của Node (mỗi trình duyệt là trưởng nhóm của nó) vào
// pids.json và bỏ những tiến trình đã thoát, để dọn được khi Node chết đột ngột hoặc app sập.
func (s *Sidecar) trackChildren(c *conn) {
	kids, err := proc.Children(c.tree.PID())
	if err != nil {
		s.logf("sidecar: không liệt kê được tiến trình con: %v", err)
		return
	}
	now := map[int]bool{}
	for _, k := range kids {
		now[k] = true
	}
	c.mu.Lock()
	var added, gone []int
	for k := range now {
		if !c.children[k] {
			added = append(added, k)
		}
	}
	for k := range c.children {
		if !now[k] {
			gone = append(gone, k)
		}
	}
	c.children = now
	c.mu.Unlock()
	pids := s.RT.PIDs()
	for _, k := range added {
		if err := pids.Add(k, goruntime.GOOS != "windows"); err != nil {
			s.logf("sidecar: không ghi được pids.json: %v", err)
		}
	}
	for _, k := range gone {
		_ = pids.Remove(k)
	}
}

// sessionOf lấy trường session của tham số (map hay struct có tag json "session").
func sessionOf(params any) string {
	b, err := json.Marshal(params)
	if err != nil {
		return ""
	}
	var p struct {
		Session string `json:"session"`
	}
	_ = json.Unmarshal(b, &p)
	return p.Session
}

func (c *conn) call(ctx context.Context, method string, params, out any) error {
	timeout := defaultCallTimeout
	if method == "close" {
		timeout = closeCallTimeout
	}
	if _, has := ctx.Deadline(); !has || method == "close" {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, timeout)
		defer cancel()
	}
	c.mu.Lock()
	if !c.alive() {
		c.mu.Unlock()
		return downErr("tiến trình điều khiển trình duyệt đã dừng")
	}
	c.nextID++
	id := c.nextID
	ch := make(chan reply, 1)
	c.pending[id] = ch
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
	}()
	line, err := json.Marshal(request{ID: id, Method: method, Params: params})
	if err != nil {
		return apperr.Wrap(apperr.CodeInvalid, err)
	}
	c.wmu.Lock()
	_, err = c.stdin.Write(append(line, '\n'))
	c.wmu.Unlock()
	if err != nil {
		return downErr("không gửi được lệnh " + method)
	}
	select {
	case r := <-ch:
		return r.decode(out)
	case <-c.done:
		select {
		case r := <-ch:
			return r.decode(out)
		default:
			return downErr("tiến trình điều khiển trình duyệt đã dừng giữa lệnh " + method)
		}
	case <-ctx.Done():
		return fmt.Errorf("sidecar %s: %w", method, ctx.Err())
	}
}

func (r reply) decode(out any) error {
	if r.Error != nil {
		return rpcError(r.Error.Code, r.Error.Message)
	}
	if out == nil || len(r.Result) == 0 {
		return nil
	}
	if err := json.Unmarshal(r.Result, out); err != nil {
		return apperr.Wrap(CodeSidecarFailed, err)
	}
	return nil
}

// readReplies: một bộ đọc stdout duy nhất, chuyển mỗi dòng NDJSON tới lệnh đang chờ theo id.
func (c *conn) readReplies(r io.Reader, s *Sidecar) {
	br := bufio.NewReaderSize(r, 64<<10)
	for {
		line, err := br.ReadBytes('\n')
		if len(line) > 1 {
			var rep reply
			if jerr := json.Unmarshal(line, &rep); jerr != nil {
				s.logf("sidecar: dòng stdout không phải JSON (%d byte)", len(line))
			} else if rep.Event == "closed" {
				c.mu.Lock()
				c.closed[rep.Session] = true
				c.mu.Unlock()
			} else {
				c.mu.Lock()
				ch := c.pending[rep.ID]
				c.mu.Unlock()
				if ch != nil {
					ch <- rep // kênh có chỗ cho đúng một trả lời
				}
			}
		}
		if err != nil {
			return
		}
	}
}

// readStderr ghi log stderr của Node, tối đa stderrBurst dòng mỗi stderrWindow; phần dư chỉ được đếm.
// Luôn đọc hết ống để Node không bao giờ bị chặn khi ghi stderr.
func (s *Sidecar) readStderr(gen int, r io.Reader) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64<<10), 1<<20)
	var window time.Time
	n, dropped := 0, 0
	for sc.Scan() {
		now := time.Now()
		if now.Sub(window) >= stderrWindow {
			if dropped > 0 {
				s.logf("sidecar[%d]: bỏ %d dòng stderr", gen, dropped)
			}
			window, n, dropped = now, 0, 0
		}
		if n >= stderrBurst {
			dropped++
			continue
		}
		n++
		line := sc.Text()
		if s.Scrub != nil {
			line = s.Scrub(line) // che trước khi cắt: cắt trước có thể để lại một phần giá trị bí mật
		}
		if len(line) > stderrLineMax {
			line = line[:stderrLineMax] + "…"
		}
		s.logf("sidecar[%d]: %s", gen, line)
	}
	_, _ = io.Copy(io.Discard, r)
}
