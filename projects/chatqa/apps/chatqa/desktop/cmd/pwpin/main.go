// Command pwpin sinh internal/pw/pins_gen.go: SHA-256 của mọi file bộ chạy trình duyệt tải về (Node, bốn
// gói npm, trình duyệt) cho darwin/arm64 và windows/amd64. Không tin lần tải đầu tiên: chỉ ghi pin khi
//   - gói npm có sha512 bằng dist.integrity của registry và bằng integrity trong package-lock.json gốc;
//   - Node có SHA-256 bằng dòng trong SHASUMS256.txt, và `gpg --verify` file đó qua khoá phát hành Node
//     lưu trong repo (node-release-keys.asc) thành công;
//   - mỗi zip trình duyệt tải từ hai nguồn của Playwright cho cùng SHA-256 (nguồn thứ hai ghi vào pin).
//
// Chạy từ apps/chatqa/desktop:
//
//	go run ./cmd/pwpin            xác minh rồi ghi pins_gen.go (thiếu một điều kiện thì không ghi gì)
//	go run ./cmd/pwpin -check     xác minh lại, so với pins_gen.go hiện có, không ghi
//	go run ./cmd/pwpin -partial   chỉ ghi các pin đã xác minh đủ, liệt kê phần thiếu ở đầu file, thoát mã 2
package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"github.com/ProtonMail/go-crypto/openpgp"
	"go/format"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// Nguồn tải. Test thay bằng máy chủ cục bộ.
type sources struct {
	NodeDist string   // https://nodejs.org/dist
	Registry string   // https://registry.npmjs.org
	CDN      []string // PLAYWRIGHT_CDN_MIRRORS của Playwright, theo thứ tự Playwright thử
	// CfT: Playwright tải Chrome for Testing từ cdn.playwright.dev (chuyển tiếp về kho của Google); kho
	// công khai của Google là nguồn thứ hai.
	CfT []string
}

var defaultSources = sources{
	NodeDist: "https://nodejs.org/dist",
	Registry: "https://registry.npmjs.org",
	CDN: []string{
		"https://cdn.playwright.dev/dbazure/download/playwright",
		"https://playwright.download.prss.microsoft.com/dbazure/download/playwright",
		"https://cdn.playwright.dev",
	},
	CfT: []string{
		"https://cdn.playwright.dev/builds/cft",
		"https://storage.googleapis.com/chrome-for-testing-public",
	},
}

// artifact: cùng các trường với pw.Artifact (file sinh ra thuộc package pw).
type artifact struct {
	URL, Mirror, SHA256 string
	Size                int64
	Kind                string
	Dir, Rev            string
	Integrity           string
}

// browserFile: một zip trình duyệt trên một nền tảng. host: tên nền tảng theo Playwright, path: đường dẫn
// trong bảng DOWNLOAD_PATHS của Playwright (%s = revision); cft: hậu tố Chrome for Testing.
type browserFile struct {
	key, name, host, path, cft string
}

type target struct {
	platform string
	nodeFile string // %s = phiên bản Node
	browsers []browserFile
}

// Bảng lấy từ registry của playwright-core; run kiểm tra từng dòng còn nguyên trong gói đã xác minh, nên
// khi nâng Playwright mà bảng lệch thì pwpin dừng thay vì ghim nhầm file.
var targets = []target{
	{
		platform: "darwin/arm64",
		nodeFile: "node-v%s-darwin-arm64.tar.gz",
		browsers: []browserFile{
			{key: "chromium", name: "chromium", host: "mac15-arm64", cft: "mac-arm64/chrome-mac-arm64.zip"},
			{key: "ffmpeg", name: "ffmpeg", host: "mac15-arm64", path: "builds/ffmpeg/%s/ffmpeg-mac-arm64.zip"},
			{key: "firefox", name: "firefox", host: "mac15-arm64", path: "builds/firefox/%s/firefox-mac-arm64.zip"},
			{key: "webkit@mac14", name: "webkit", host: "mac14-arm64", path: "builds/webkit/%s/webkit-mac-14-arm64.zip"},
			{key: "webkit@mac15", name: "webkit", host: "mac15-arm64", path: "builds/webkit/%s/webkit-mac-15-arm64.zip"},
			{key: "webkit@mac26", name: "webkit", host: "mac26-arm64", path: "builds/webkit/%s/webkit-mac-26-arm64.zip"},
		},
	},
	{
		platform: "windows/amd64",
		nodeFile: "node-v%s-win-x64.zip",
		browsers: []browserFile{
			{key: "chromium", name: "chromium", host: "win64", cft: "win64/chrome-win64.zip"},
			{key: "ffmpeg", name: "ffmpeg", host: "win64", path: "builds/ffmpeg/%s/ffmpeg-win64.zip"},
			{key: "firefox", name: "firefox", host: "win64", path: "builds/firefox/%s/firefox-win64.zip"},
			{key: "webkit", name: "webkit", host: "win64", path: "builds/webkit/%s/webkit-win64.zip"},
		},
	},
}

var npmPackages = []string{"playwright-core", "playwright", "@playwright/test", "typescript"}

type config struct {
	node, lock, keys, out string
	check, partial        bool
	jobs                  int
	src                   sources
	client                *http.Client
	gpg                   string // "" = tìm gpg trong PATH
	log                   io.Writer
}

func main() {
	// Không đặt Timeout tổng: zip trình duyệt vài trăm MB trên mạng chậm có thể mất hàng giờ.
	transport := &http.Transport{Proxy: http.ProxyFromEnvironment, ResponseHeaderTimeout: time.Minute}
	c := config{src: defaultSources, client: &http.Client{Transport: transport}, log: os.Stderr}
	flag.StringVar(&c.node, "node", "26.13.1", "phiên bản Node")
	flag.StringVar(&c.lock, "lock", filepath.Join("..", "..", "..", "package-lock.json"), "package-lock.json gốc của repo")
	flag.StringVar(&c.keys, "keys", filepath.Join("cmd", "pwpin", "node-release-keys.asc"), "khoá phát hành Node")
	flag.StringVar(&c.out, "out", filepath.Join("internal", "pw", "pins_gen.go"), "file sinh ra")
	flag.BoolVar(&c.check, "check", false, "xác minh lại và so với file hiện có, không ghi")
	flag.BoolVar(&c.partial, "partial", false, "ghi các pin đã xác minh đủ dù còn pin thiếu (thoát mã 2)")
	flag.IntVar(&c.jobs, "j", 10, "số artifact xác minh song song")
	flag.Parse()
	os.Exit(run(context.Background(), c))
}

// result: kết quả xác minh. failures: khoá -> lý do, không bao giờ có pin cho khoá đó.
type result struct {
	mu             sync.Mutex
	playwright, ts string
	pins           map[string]artifact
	failures       map[string]string
	gpgOutput      string
}

func (r *result) ok(key string, a artifact) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.pins[key] = a
}

func (r *result) fail(key string, err error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.failures[key] = err.Error()
}

// syncWriter: các artifact xác minh song song cùng ghi log.
type syncWriter struct {
	mu sync.Mutex
	w  io.Writer
}

func (s *syncWriter) Write(b []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.w.Write(b)
}

func run(ctx context.Context, c config) int {
	c.log = &syncWriter{w: c.log}
	res, err := verify(ctx, c)
	if err != nil {
		fmt.Fprintln(c.log, "pwpin:", err)
		return 1
	}
	if res.gpgOutput != "" {
		fmt.Fprintf(c.log, "gpg --verify SHASUMS256.txt:\n%s\n", res.gpgOutput)
	}
	keys := sortedKeys(res.failures)
	for _, k := range keys {
		fmt.Fprintf(c.log, "CHƯA XÁC MINH %s: %s\n", k, res.failures[k])
	}
	if len(keys) > 0 && !c.partial {
		fmt.Fprintln(c.log, "pwpin: còn pin chưa xác minh, không ghi gì")
		return 1
	}
	src, err := render(c.node, res)
	if err != nil {
		fmt.Fprintln(c.log, "pwpin:", err)
		return 1
	}
	if c.check {
		cur, err := os.ReadFile(c.out)
		if err != nil || !bytes.Equal(cur, src) {
			fmt.Fprintf(c.log, "pwpin: %s khác kết quả xác minh lại (%v)\n", c.out, err)
			return 1
		}
		fmt.Fprintf(c.log, "pwpin: %s khớp\n", c.out)
	} else if err := os.WriteFile(c.out, src, 0o644); err != nil {
		fmt.Fprintln(c.log, "pwpin:", err)
		return 1
	} else {
		fmt.Fprintf(c.log, "pwpin: đã ghi %s (%d pin)\n", c.out, len(res.pins))
	}
	if len(keys) > 0 {
		return 2
	}
	return 0
}

// verify xác minh mọi artifact. Lỗi trả về (không phải failures) là lỗi chặn mọi thứ: lockfile, gói
// playwright-core (nguồn danh sách trình duyệt) hay bảng đường dẫn lệch.
func verify(ctx context.Context, c config) (*result, error) {
	res := &result{pins: map[string]artifact{}, failures: map[string]string{}}
	lock, err := readLock(c.lock)
	if err != nil {
		return nil, err
	}
	pwLock, ok := lock["@playwright/test"]
	if !ok {
		return nil, errors.New("package-lock.json thiếu @playwright/test")
	}
	tsLock, ok := lock["typescript"]
	if !ok {
		return nil, errors.New("package-lock.json thiếu typescript")
	}
	res.playwright, res.ts = pwLock.Version, tsLock.Version

	// Gói npm trước: browsers.json và bảng đường dẫn đọc từ playwright-core đã xác minh.
	var core []byte
	for _, name := range npmPackages {
		ver := res.playwright
		if name == "typescript" {
			ver = res.ts
		}
		a, body, err := pinNPM(ctx, c, name, ver, lock)
		if err != nil {
			if name == "playwright-core" {
				return nil, fmt.Errorf("playwright-core: %w", err)
			}
			res.fail("npm/"+name, err)
			continue
		}
		res.ok("npm/"+name, a)
		fmt.Fprintf(c.log, "OK npm/%s %s\n", name, a.SHA256)
		if name == "playwright-core" {
			core = body
		}
	}
	browsers, js, err := readCore(core)
	if err != nil {
		return nil, err
	}
	if err := checkTables(c.src, js); err != nil {
		return nil, err
	}

	var tasks []func()
	nodeTasks, gpgOut := nodeTasks(ctx, c, res)
	res.gpgOutput = gpgOut
	tasks = append(tasks, nodeTasks...)
	for _, t := range targets {
		for _, bf := range t.browsers {
			key := t.platform + "/" + bf.key
			b, ok := browsers[bf.name]
			if !ok {
				return nil, fmt.Errorf("browsers.json thiếu %s", bf.name)
			}
			tasks = append(tasks, func() {
				a, err := pinBrowser(ctx, c, bf, b)
				if err != nil {
					res.fail(key, err)
					return
				}
				res.ok(key, a)
				fmt.Fprintf(c.log, "OK %s %s (%s = %s)\n", key, a.SHA256, a.URL, a.Mirror)
			})
		}
	}
	parallel(max(c.jobs, 1), tasks)
	return res, nil
}

func parallel(n int, tasks []func()) {
	sem := make(chan struct{}, n)
	var wg sync.WaitGroup
	for _, task := range tasks {
		wg.Add(1)
		sem <- struct{}{}
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			task()
		}()
	}
	wg.Wait()
}

type lockEntry struct {
	Version   string `json:"version"`
	Integrity string `json:"integrity"`
}

func readLock(path string) (map[string]lockEntry, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var l struct {
		Packages map[string]lockEntry `json:"packages"`
	}
	if err := json.Unmarshal(b, &l); err != nil {
		return nil, fmt.Errorf("package-lock.json: %w", err)
	}
	out := map[string]lockEntry{}
	for _, name := range npmPackages {
		if e, ok := l.Packages["node_modules/"+name]; ok {
			out[name] = e
		}
	}
	return out, nil
}

// pinNPM: sha512 của tarball phải bằng dist.integrity của registry và bằng integrity của lockfile; lockfile phải có
// gói này với đúng phiên bản (thiếu thì từ chối: không bao giờ chỉ tin một nguồn).
func pinNPM(ctx context.Context, c config, name, ver string, lock map[string]lockEntry) (artifact, []byte, error) {
	le, ok := lock[name]
	if !ok {
		return artifact{}, nil, fmt.Errorf("package-lock.json thiếu %s", name)
	}
	if le.Version != ver {
		return artifact{}, nil, fmt.Errorf("lockfile ghim %s@%s, khác %s", name, le.Version, ver)
	}
	meta, err := get(ctx, c.client, c.src.Registry+"/"+url.PathEscape(name)+"/"+ver)
	if err != nil {
		return artifact{}, nil, err
	}
	var m struct {
		Version string `json:"version"`
		Dist    struct {
			Tarball   string `json:"tarball"`
			Integrity string `json:"integrity"`
		} `json:"dist"`
	}
	if err := json.Unmarshal(meta, &m); err != nil {
		return artifact{}, nil, fmt.Errorf("metadata registry: %w", err)
	}
	if m.Version != ver || !strings.HasPrefix(m.Dist.Tarball, c.src.Registry+"/") {
		return artifact{}, nil, fmt.Errorf("metadata registry lạ: %s %s", m.Version, m.Dist.Tarball)
	}
	if !strings.HasPrefix(m.Dist.Integrity, "sha512-") {
		return artifact{}, nil, fmt.Errorf("registry không có integrity sha512: %q", m.Dist.Integrity)
	}
	body, err := get(ctx, c.client, m.Dist.Tarball)
	if err != nil {
		return artifact{}, nil, err
	}
	s512 := sha512.Sum512(body)
	integrity := "sha512-" + base64.StdEncoding.EncodeToString(s512[:])
	if integrity != m.Dist.Integrity {
		return artifact{}, nil, fmt.Errorf("sha512 %s khác registry %s", integrity, m.Dist.Integrity)
	}
	if le.Integrity != integrity {
		return artifact{}, nil, fmt.Errorf("sha512 %s khác package-lock.json %s", integrity, le.Integrity)
	}
	s256 := sha256.Sum256(body)
	return artifact{URL: m.Dist.Tarball, SHA256: hex.EncodeToString(s256[:]), Size: int64(len(body)), Kind: "KindNPM", Integrity: integrity}, body, nil
}

type hashed struct {
	url, sum string
	size     int64
}

type browserEntry struct {
	Name              string            `json:"name"`
	Revision          string            `json:"revision"`
	BrowserVersion    string            `json:"browserVersion"`
	RevisionOverrides map[string]string `json:"revisionOverrides"`
}

// readCore đọc browsers.json và mã JS của playwright-core (để đối chiếu bảng đường dẫn).
func readCore(tgz []byte) (map[string]browserEntry, []byte, error) {
	gz, err := gzip.NewReader(bytes.NewReader(tgz))
	if err != nil {
		return nil, nil, err
	}
	tr := tar.NewReader(gz)
	var js bytes.Buffer
	var bj []byte
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, nil, err
		}
		switch {
		case h.Name == "package/browsers.json":
			if bj, err = io.ReadAll(tr); err != nil {
				return nil, nil, err
			}
		case strings.HasPrefix(h.Name, "package/lib/") && strings.HasSuffix(h.Name, ".js"):
			if _, err := io.Copy(&js, tr); err != nil {
				return nil, nil, err
			}
		}
	}
	var b struct {
		Browsers []browserEntry `json:"browsers"`
	}
	if err := json.Unmarshal(bj, &b); err != nil {
		return nil, nil, fmt.Errorf("browsers.json của playwright-core: %w", err)
	}
	out := map[string]browserEntry{}
	for _, e := range b.Browsers {
		out[e.Name] = e
	}
	return out, js.Bytes(), nil
}

// checkTables: mọi dòng của bảng targets và danh sách mirror phải có nguyên văn trong mã playwright-core.
func checkTables(src sources, js []byte) error {
	var want []string
	for _, m := range src.CDN {
		want = append(want, fmt.Sprintf("%q", m))
	}
	for _, t := range targets {
		for _, bf := range t.browsers {
			if bf.cft != "" {
				want = append(want, fmt.Sprintf("%q: cftUrl(%q)", bf.host, bf.cft))
			} else {
				want = append(want, fmt.Sprintf("%q: %q", bf.host, bf.path))
			}
		}
	}
	for _, w := range want {
		if !bytes.Contains(js, []byte(w)) {
			return fmt.Errorf("playwright-core không còn %s: cập nhật bảng targets theo registry của phiên bản mới", w)
		}
	}
	return nil
}

// browserDir: thư mục Playwright dùng dưới PLAYWRIGHT_BROWSERS_PATH (revisionOverrides đổi cả tên).
func browserDir(b browserEntry, host string) (dir, rev string) {
	rev = b.Revision
	prefix := b.Name
	if o, ok := b.RevisionOverrides[host]; ok {
		rev = o
		prefix = b.Name + "_" + host + "_special"
	}
	return strings.ReplaceAll(prefix, "-", "_") + "-" + rev, rev
}

// pinBrowser tải zip từ hai nguồn (thử lần lượt tới khi đủ hai nguồn trả 200) và chỉ ghim khi hai SHA-256 trùng.
func pinBrowser(ctx context.Context, c config, bf browserFile, b browserEntry) (artifact, error) {
	dir, rev := browserDir(b, bf.host)
	var urls []string
	if bf.cft != "" {
		for _, m := range c.src.CfT {
			urls = append(urls, m+"/"+b.BrowserVersion+"/"+bf.cft)
		}
	} else {
		for _, m := range c.src.CDN {
			urls = append(urls, m+"/"+fmt.Sprintf(bf.path, rev))
		}
	}
	// Hai nguồn đầu tải song song; nguồn nào lỗi thì thử nguồn kế tiếp.
	got := make([]hashed, 0, 2)
	var errs []error
	next := 0
	for len(got) < 2 && next < len(urls) {
		batch := urls[next:min(len(urls), next+2-len(got))]
		next += len(batch)
		out := make([]hashed, len(batch))
		bad := make([]error, len(batch))
		var wg sync.WaitGroup
		for i, u := range batch {
			wg.Add(1)
			go func() {
				defer wg.Done()
				out[i].url = u
				out[i].sum, out[i].size, bad[i] = hashURL(ctx, c.client, u)
			}()
		}
		wg.Wait()
		for i := range batch {
			if bad[i] != nil {
				errs = append(errs, bad[i])
			} else {
				got = append(got, out[i])
			}
		}
	}
	if len(got) < 2 {
		return artifact{}, fmt.Errorf("không đủ hai nguồn: %w", errors.Join(errs...))
	}
	if got[0].sum != got[1].sum || got[0].size != got[1].size {
		return artifact{}, fmt.Errorf("hai nguồn khác nhau: %s=%s, %s=%s", got[0].url, got[0].sum, got[1].url, got[1].sum)
	}
	return artifact{URL: got[0].url, Mirror: got[1].url, SHA256: got[0].sum, Size: got[0].size, Kind: "KindBrowser", Dir: dir, Rev: rev}, nil
}

// nodeTasks: gpg --verify SHASUMS256.txt trước; không qua thì không tải Node và cả hai pin Node thất bại.
func nodeTasks(ctx context.Context, c config, res *result) ([]func(), string) {
	base := c.src.NodeDist + "/v" + c.node
	failAll := func(err error) {
		for _, t := range targets {
			res.fail(t.platform+"/node", err)
		}
	}
	sums, err := get(ctx, c.client, base+"/SHASUMS256.txt")
	if err != nil {
		failAll(err)
		return nil, ""
	}
	sig, err := get(ctx, c.client, base+"/SHASUMS256.txt.sig")
	if err != nil {
		failAll(err)
		return nil, ""
	}
	out, err := gpgVerify(c, sums, sig)
	if err != nil {
		failAll(err)
		return nil, out
	}
	want := parseSums(sums)
	var tasks []func()
	for _, t := range targets {
		file := fmt.Sprintf(t.nodeFile, c.node)
		key := t.platform + "/node"
		tasks = append(tasks, func() {
			exp, ok := want[file]
			if !ok {
				res.fail(key, fmt.Errorf("SHASUMS256.txt không có %s", file))
				return
			}
			u := base + "/" + file
			sum, size, err := hashURL(ctx, c.client, u)
			if err != nil {
				res.fail(key, err)
				return
			}
			if sum != exp {
				res.fail(key, fmt.Errorf("sha256 %s khác SHASUMS256.txt %s", sum, exp))
				return
			}
			res.ok(key, artifact{URL: u, SHA256: sum, Size: size, Kind: "KindNode"})
			fmt.Fprintf(c.log, "OK %s %s\n", key, sum)
		})
	}
	return tasks, out
}

// gpgVerify chạy gpg thật trong GNUPGHOME tạm chỉ chứa khoá phát hành Node của repo. Yêu cầu chữ ký hợp lệ
// (GOODSIG + VALIDSIG); trả output để ghi làm bằng chứng.
func gpgVerify(c config, data, sig []byte) (string, error) {
	gpg := c.gpg
	if gpg == "" {
		p, err := exec.LookPath("gpg")
		if err != nil {
			// Không có GnuPG: kiểm cùng chữ ký, cùng khoá phát hành trong repo, bằng thư viện OpenPGP của Go.
			return pgpVerify(c.keys, data, sig)
		}
		gpg = p
	}
	home, err := os.MkdirTemp("", "pwpin-gnupg-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(home)
	if err := os.Chmod(home, 0o700); err != nil {
		return "", err
	}
	dataPath, sigPath := filepath.Join(home, "SHASUMS256.txt"), filepath.Join(home, "SHASUMS256.txt.sig")
	if err := os.WriteFile(dataPath, data, 0o600); err != nil {
		return "", err
	}
	if err := os.WriteFile(sigPath, sig, 0o600); err != nil {
		return "", err
	}
	if out, err := exec.Command(gpg, "--batch", "--no-tty", "--homedir", home, "--import", c.keys).CombinedOutput(); err != nil {
		return string(out), fmt.Errorf("gpg --import %s: %w", c.keys, err)
	}
	out, err := exec.Command(gpg, "--batch", "--no-tty", "--homedir", home, "--status-fd", "1", "--verify", sigPath, dataPath).CombinedOutput()
	if err != nil {
		return string(out), fmt.Errorf("gpg --verify thất bại: %w", err)
	}
	if !bytes.Contains(out, []byte("[GNUPG:] GOODSIG")) || !bytes.Contains(out, []byte("[GNUPG:] VALIDSIG")) {
		return string(out), errors.New("gpg --verify không báo chữ ký hợp lệ")
	}
	return string(out), nil
}

// pgpVerify kiểm chữ ký tách rời của SHASUMS256.txt trong tiến trình, chỉ với khoá phát hành Node của repo
// (cùng điều kiện với gpg --verify, không cần cài GnuPG).
func pgpVerify(keysPath string, data, sig []byte) (string, error) {
	raw, err := os.ReadFile(keysPath)
	if err != nil {
		return "", err
	}
	// Mỗi khoá là một khối ASCII-armor riêng: đọc từng khối rồi gộp lại.
	var ring openpgp.EntityList
	for _, blk := range bytes.SplitAfter(raw, []byte("-----END PGP PUBLIC KEY BLOCK-----")) {
		if !bytes.Contains(blk, []byte("BEGIN PGP PUBLIC KEY BLOCK")) {
			continue
		}
		part, err := openpgp.ReadArmoredKeyRing(bytes.NewReader(blk))
		if err != nil {
			return "", fmt.Errorf("đọc khoá %s: %w", keysPath, err)
		}
		ring = append(ring, part...)
	}
	if len(ring) == 0 {
		return "", fmt.Errorf("%s không có khoá nào", keysPath)
	}
	signer, err := openpgp.CheckDetachedSignature(ring, bytes.NewReader(data), bytes.NewReader(sig), nil)
	if err != nil {
		return "", fmt.Errorf("kiểm chữ ký OpenPGP thất bại: %w", err)
	}
	return fmt.Sprintf("openpgp: chữ ký hợp lệ của khoá %X\n", signer.PrimaryKey.Fingerprint), nil
}

func parseSums(b []byte) map[string]string {
	out := map[string]string{}
	for _, line := range strings.Split(string(b), "\n") {
		f := strings.Fields(line)
		if len(f) == 2 && len(f[0]) == 64 {
			out[f[1]] = strings.ToLower(f[0])
		}
	}
	return out
}

func get(ctx context.Context, client *http.Client, u string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s: http %d", u, res.StatusCode)
	}
	return io.ReadAll(res.Body)
}

// hashURL tải và băm theo luồng, không giữ file (zip trình duyệt vài trăm MB).
func hashURL(ctx context.Context, client *http.Client, u string) (string, int64, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return "", 0, err
	}
	res, err := client.Do(req)
	if err != nil {
		return "", 0, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return "", 0, fmt.Errorf("%s: http %d", u, res.StatusCode)
	}
	h := sha256.New()
	n, err := io.Copy(h, res.Body)
	if err != nil {
		return "", 0, fmt.Errorf("%s: %w", u, err)
	}
	if res.ContentLength >= 0 && n != res.ContentLength {
		return "", 0, fmt.Errorf("%s: nhận %d/%d byte", u, n, res.ContentLength)
	}
	return hex.EncodeToString(h.Sum(nil)), n, nil
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// render sinh pins_gen.go. Không ghi ngày giờ để -check so được từng byte.
func render(node string, res *result) ([]byte, error) {
	var b bytes.Buffer
	b.WriteString("// Code generated by cmd/pwpin; DO NOT EDIT.\n//\n")
	b.WriteString("// Sinh lại: cd apps/chatqa/desktop && go run ./cmd/pwpin (kiểm tra: go run ./cmd/pwpin -check).\n")
	b.WriteString("// Gói npm khớp sha512 của registry và package-lock.json gốc; Node khớp SHASUMS256.txt đã gpg --verify\n")
	b.WriteString("// bằng cmd/pwpin/node-release-keys.asc; mỗi zip trình duyệt tải từ hai nguồn cho cùng SHA-256 (Mirror).\n")
	if keys := sortedKeys(res.failures); len(keys) > 0 {
		b.WriteString("//\n// CHƯA ĐỦ: các artifact sau chưa xác minh được nên không có pin; Ensure của chúng trả\n")
		b.WriteString("// driver_bundle_unavailable cho tới khi chạy lại pwpin thành công.\n")
		for _, k := range keys {
			fmt.Fprintf(&b, "//   - %s: %s\n", k, strings.ReplaceAll(res.failures[k], "\n", " "))
		}
	}
	b.WriteString("\npackage pw\n\n")
	b.WriteString("// DefaultPins: bộ ghim của bản phát hành.\n")
	fmt.Fprintf(&b, "var DefaultPins = Pins{\n\tNode: %q,\n\tPlaywright: %q,\n\tTypeScript: %q,\n\tArtifacts: map[string]Artifact{\n", node, res.playwright, res.ts)
	for _, k := range sortedKeys(res.pins) {
		a := res.pins[k]
		fmt.Fprintf(&b, "\t\t%q: {URL: %q, SHA256: %q, Size: %d, Kind: %s", k, a.URL, a.SHA256, a.Size, a.Kind)
		if a.Mirror != "" {
			fmt.Fprintf(&b, ", Mirror: %q", a.Mirror)
		}
		if a.Dir != "" {
			fmt.Fprintf(&b, ", Dir: %q, Rev: %q", a.Dir, a.Rev)
		}
		if a.Integrity != "" {
			fmt.Fprintf(&b, ", Integrity: %q", a.Integrity)
		}
		b.WriteString("},\n")
	}
	b.WriteString("\t},\n}\n")
	return format.Source(b.Bytes())
}
