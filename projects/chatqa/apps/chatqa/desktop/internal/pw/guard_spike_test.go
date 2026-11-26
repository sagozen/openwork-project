//go:build pwintegration

package pw

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"deskcore/apperr"
)

// Thử nghiệm lớp chặn mạng qua sidecar thật, với từng trình duyệt có trên máy. Máy chủ "được phép" nghe ở
// localhost; máy chủ "lạ" đếm mọi request và mọi kết nối TCP, gọi bằng 127.0.0.1 (khác host) hoặc bằng
// tên công cộng cqs-spike.localtest.me (phân giải về 127.0.0.1 qua DNS thật) cho cổng DNS.
//
//	go test -tags pwintegration ./internal/pw/ -run GuardSpike -count=1 -v -timeout 15m
//
// Cổng (đạt khi máy chủ lạ không nhận gì). Họ Chromium phải đạt mọi cổng quan sát được; Firefox/WebKit
// không có lớp DNS nên lọt ở đó chỉ được ghi lại (biện pháp vệ sinh, không phải ranh giới bảo mật):
//
//	redirect   trang được phép 302 sang host lạ
//	websocket  trang mở WebSocket tới host lạ
//	popup      target=_blank tới host lạ; popup phải bị đóng
//	data       iframe data: chạy fetch + WebSocket tới host lạ
//	dns        <link rel=dns-prefetch/preconnect> tới tên lạ (không đi qua route; chỉ --host-resolver-rules
//	           của họ Chromium chặn được). Đối chứng: cùng trình duyệt mở không có luật phải kết nối được,
//	           không thì cổng này "không quan sát được".
//	dns-redirect  trang được phép 302 sang tên lạ (cùng đối chứng): bước redirect không phải lúc nào cũng
//	           qua route, nên đây là phép thử lớp DNS quan sát được trên Chromium.
const spikeName = "cqs-spike.localtest.me"

type offHost struct {
	srv     *httptest.Server
	mu      sync.Mutex
	hits    []string
	accepts atomic.Int32
}

type countingListener struct {
	net.Listener
	n *atomic.Int32
}

func (l countingListener) Accept() (net.Conn, error) {
	c, err := l.Listener.Accept()
	if err == nil {
		l.n.Add(1)
	}
	return c, err
}

func newOffHost(t *testing.T) *offHost {
	o := &offHost{}
	o.srv = httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		o.mu.Lock()
		o.hits = append(o.hits, r.URL.Path)
		o.mu.Unlock()
		fmt.Fprint(w, "off-host")
	}))
	o.srv.Listener = countingListener{o.srv.Listener, &o.accepts}
	o.srv.Start()
	t.Cleanup(o.srv.Close)
	return o
}

func (o *offHost) reset() {
	o.mu.Lock()
	o.hits = nil
	o.mu.Unlock()
	o.accepts.Store(0)
}

func (o *offHost) got() []string {
	o.mu.Lock()
	defer o.mu.Unlock()
	return append([]string(nil), o.hits...)
}

func (o *offHost) port() string { return strconv.Itoa(o.srv.Listener.Addr().(*net.TCPAddr).Port) }

func newAllowed(t *testing.T, off *offHost) string {
	ip := "http://127.0.0.1:" + off.port()
	pages := map[string]string{
		"/":      `<title>ok</title><p>ok</p>`,
		"/ws":    `<title>ws</title><script>new WebSocket('ws://127.0.0.1:` + off.port() + `/ws')</script>`,
		"/popup": `<title>popup</title><a id="p" target="_blank" href="` + ip + `/popup">mở</a>`,
		"/data": `<title>data</title><iframe src="data:text/html,<script>fetch('` + ip + `/data-fetch').catch(()=>{});` +
			`new WebSocket('ws://127.0.0.1:` + off.port() + `/data-ws')</script>"></iframe>`,
		"/prefetch": `<title>dns</title><link rel="dns-prefetch" href="//` + spikeName + `:` + off.port() + `">` +
			`<link rel="preconnect" href="http://` + spikeName + `:` + off.port() + `">`,
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/redirect":
			http.Redirect(w, r, ip+"/redirected", http.StatusFound)
			return
		case "/redirect-name":
			http.Redirect(w, r, "http://"+spikeName+":"+off.port()+"/redirected-name", http.StatusFound)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, pages[r.URL.Path])
	}))
	t.Cleanup(srv.Close)
	return strings.Replace(srv.URL, "127.0.0.1", "localhost", 1)
}

type spikeBrowser struct {
	name, browser, channel string
	dnsGuard               bool
}

type gateResult struct {
	browser, gate, verdict, detail string
}

func TestGuardSpike(t *testing.T) {
	rt := integrationRuntime(t)
	off := newOffHost(t)
	base := newAllowed(t, off)
	s := &Sidecar{RT: rt, Log: t.Logf}
	defer s.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Minute)
	defer cancel()
	gen, err := s.Start(ctx)
	if err != nil {
		t.Fatal(err)
	}

	installed := map[string]bool{}
	for _, c := range detectChannels() {
		installed[c.Name] = c.Installed
	}
	for _, b := range []string{"chromium", "firefox", "webkit"} {
		_, a, ok := rt.artifact(b)
		installed[b] = ok && exists(filepath.Join(rt.BrowsersPath(), a.Dir, completeMarker))
	}
	all := []spikeBrowser{
		{"chromium", "chromium", "", true},
		{"chrome", "chromium", "chrome", true},
		{"msedge", "chromium", "msedge", true},
		{"firefox", "firefox", "", false},
		{"webkit", "webkit", "", false},
	}
	var results []gateResult
	record := func(b, gate, verdict, detail string) {
		results = append(results, gateResult{b, gate, verdict, detail})
		t.Logf("%-8s %-9s %s %s", b, gate, verdict, detail)
	}

	for _, b := range all {
		key := b.browser
		if b.channel != "" {
			key = b.channel
		}
		if !installed[key] {
			record(b.name, "*", "KHÔNG CHẠY", "chưa cài trên máy này")
			continue
		}
		session := "web-spike-" + b.name
		profile := Profile{ID: session, Name: b.name, Browser: b.browser, Channel: b.channel, Width: 1000, Height: 700,
			BaseURL: base, Headless: true}
		if err := profile.Validate(); err != nil {
			t.Fatal(err)
		}
		if err := s.Call(ctx, gen, "open", map[string]any{"session": session, "profile": profile}, nil); err != nil {
			record(b.name, "open", "LỖI", err.Error())
			t.Errorf("%s: open: %v", b.name, err)
			continue
		}
		call := func(method string, params map[string]any) error {
			params["session"] = session
			return s.Call(ctx, gen, method, params, nil)
		}
		if err := call("navigate", map[string]any{"url": "/"}); err != nil {
			t.Errorf("%s: trang được phép bị chặn: %v", b.name, err)
		}

		gate := func(name string, run func() error) {
			off.reset()
			err := run()
			_ = call("wait", map[string]any{"sec": 1.5}) // để request muộn (nếu lọt) kịp tới máy chủ lạ
			hits := off.got()
			blocked := apperr.CodeOf(err) == CodeHostBlocked
			switch {
			case len(hits) == 0:
				record(b.name, name, "ĐẠT", fmt.Sprintf("máy chủ lạ 0 request; web_host_blocked=%v", blocked))
			case b.dnsGuard:
				record(b.name, name, "TRƯỢT", fmt.Sprintf("máy chủ lạ nhận %v (lỗi: %v)", hits, err))
				t.Errorf("%s: cổng %s lọt: %v", b.name, name, hits)
			default:
				// Firefox/WebKit không có lớp DNS: lớp chặn của chúng chỉ là biện pháp vệ sinh, lỗ hổng được ghi lại.
				record(b.name, name, "TRƯỢT (đã biết)", fmt.Sprintf("máy chủ lạ nhận %v (lỗi: %v); chỉ có lớp route", hits, err))
			}
			if !blocked {
				t.Errorf("%s: cổng %s phải trả web_host_blocked, được %v", b.name, name, err)
			}
		}
		gate("redirect", func() error { return call("navigate", map[string]any{"url": "/redirect"}) })
		gate("websocket", func() error {
			if err := call("navigate", map[string]any{"url": "/ws"}); err != nil {
				return err
			}
			return call("wait", map[string]any{"sec": 1})
		})
		gate("popup", func() error {
			if err := call("navigate", map[string]any{"url": "/popup"}); err != nil {
				return fmt.Errorf("mở trang popup: %w", err)
			}
			err := call("click", map[string]any{"locator": "locator('#p')"})
			if err == nil {
				err = call("wait", map[string]any{"sec": 1})
			}
			if err != nil && !strings.Contains(err.Error(), "cửa sổ bật lên") {
				return fmt.Errorf("lỗi không nói về popup: %w", err)
			}
			return err
		})
		gate("data", func() error {
			if err := call("navigate", map[string]any{"url": "/data"}); err != nil {
				return err
			}
			return call("wait", map[string]any{"sec": 1})
		})

		// Cổng DNS: đối chứng trước (cùng trình duyệt, không route, không luật), rồi qua sidecar.
		dnsGate := func(name, path string) {
			off.reset()
			control := controlVisit(t, rt, b, base+path)
			controlAccepts := off.accepts.Load()
			off.reset()
			_ = call("navigate", map[string]any{"url": path})
			_ = call("wait", map[string]any{"sec": 2})
			accepts := off.accepts.Load()
			detail := fmt.Sprintf("kết nối TCP tới %s: đối chứng %d, qua sidecar %d", spikeName, controlAccepts, accepts)
			switch {
			case control != nil:
				record(b.name, name, "KHÔNG QUAN SÁT", "đối chứng lỗi: "+control.Error())
			case controlAccepts == 0:
				record(b.name, name, "KHÔNG QUAN SÁT", detail+" (không có lớp chặn trình duyệt cũng không kết nối)")
			case accepts == 0:
				record(b.name, name, "ĐẠT", detail)
			case b.dnsGuard:
				record(b.name, name, "TRƯỢT", detail)
				t.Errorf("%s: %s tới tên lạ lọt dù có --host-resolver-rules", b.name, name)
			default:
				record(b.name, name, "TRƯỢT (đã biết)", detail+"; không có lớp DNS")
			}
		}
		dnsGate("dns", "/prefetch")
		dnsGate("dns-redirect", "/redirect-name")
		_ = call("close", map[string]any{})
	}

	var sb strings.Builder
	sb.WriteString("\n| Trình duyệt | Cổng | Kết quả | Chi tiết |\n|---|---|---|---|\n")
	for _, r := range results {
		fmt.Fprintf(&sb, "| %s | %s | %s | %s |\n", r.browser, r.gate, r.verdict, r.detail)
	}
	t.Log(sb.String())
}

// controlVisit mở cùng trình duyệt bằng Playwright trực tiếp, không route và không --host-resolver-rules,
// để chứng minh kết nối tới tên lạ quan sát được trên máy này (nếu không, cổng DNS không chứng minh gì).
func controlVisit(t *testing.T, rt *Runtime, b spikeBrowser, url string) error {
	t.Helper()
	script := `const pw = require(process.argv[1]);
(async () => {
  const opts = { headless: true };
  if (process.argv[3]) opts.channel = process.argv[3];
  const browser = await pw[process.argv[2]].launch(opts);
  const page = await browser.newPage();
  await page.goto(process.argv[4]).catch(() => {});
  await page.waitForTimeout(2000);
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });`
	channel := b.channel
	if b.browser == "chromium" && channel == "" {
		channel = "chromium"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	core := filepath.Join(rt.ModulesDir(), "node_modules", "playwright-core")
	cmd := exec.CommandContext(ctx, rt.NodePath(), "-e", script, core, b.browser, channel, url)
	cmd.Dir = rt.WorkDir()
	cmd.Env = ChildEnv(os.Environ(), []EnvVar{{"PLAYWRIGHT_BROWSERS_PATH", rt.BrowsersPath()}})
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("%v: %s", err, out)
	}
	return nil
}
