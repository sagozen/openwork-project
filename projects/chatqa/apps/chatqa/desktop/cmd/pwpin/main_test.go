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
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

const (
	pwVer   = "1.64.0"
	tsVer   = "5.9.3"
	nodeVer = "26.13.1"
)

// fixture: registry npm, kho Node và các mirror trình duyệt giả lập bằng một máy chủ cục bộ.
type fixture struct {
	t        *testing.T
	srv      *httptest.Server
	files    map[string][]byte // đường dẫn -> nội dung
	tamper   map[string][]byte // đường dẫn -> nội dung khác (một mirror bị sửa)
	down     map[string]bool   // đường dẫn trả 502 (mirror hỏng)
	meta     map[string]string // gói -> integrity registry công bố (mặc định: đúng)
	lockPath string
	dropJS   string // dòng bảng bị xoá khỏi mã playwright-core giả
}

func tarball(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for name, body := range files {
		tw.WriteHeader(&tar.Header{Name: name, Typeflag: tar.TypeReg, Mode: 0o644, Size: int64(len(body))})
		tw.Write([]byte(body))
	}
	tw.Close()
	gz.Close()
	return buf.Bytes()
}

func integrityOf(b []byte) string {
	s := sha512.Sum512(b)
	return "sha512-" + base64.StdEncoding.EncodeToString(s[:])
}

// hasPin: file sinh ra có pin cho khoá (gofmt căn lề nên giữa khoá và giá trị có thể nhiều dấu cách).
func hasPin(src []byte, key string) bool {
	return regexp.MustCompile(regexp.QuoteMeta(fmt.Sprintf("%q:", key)) + `\s+\{URL:`).Match(src)
}

func sha(b []byte) string { s := sha256.Sum256(b); return hex.EncodeToString(s[:]) }

func newFixture(t *testing.T) *fixture {
	f := &fixture{t: t, files: map[string][]byte{}, tamper: map[string][]byte{}, down: map[string]bool{}, meta: map[string]string{}}
	f.srv = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fixture) src() sources {
	u := f.srv.URL
	return sources{
		NodeDist: u + "/dist",
		Registry: u + "/npm",
		CDN:      []string{u + "/m1", u + "/m2", u + "/m3"},
		CfT:      []string{u + "/cft1", u + "/cft2"},
	}
}

func (f *fixture) serve(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Path
	if f.down[p] {
		http.Error(w, "down", http.StatusBadGateway)
		return
	}
	if b, ok := f.tamper[p]; ok {
		w.Write(b)
		return
	}
	if b, ok := f.files[p]; ok {
		w.Write(b)
		return
	}
	// Mirror trình duyệt: cùng nội dung ở mọi mirror (theo phần đường dẫn sau tên mirror).
	for _, m := range []string{"/m1/", "/m2/", "/m3/", "/cft1/", "/cft2/"} {
		if rest, ok := strings.CutPrefix(p, m); ok {
			w.Write([]byte("zip:" + rest))
			return
		}
	}
	http.NotFound(w, r)
}

// build tạo gói npm, lockfile và kho Node. Gọi sau khi đặt dropJS/meta.
func (f *fixture) build(sums map[string][]byte, sig []byte) {
	t := f.t
	var js strings.Builder
	for _, m := range f.src().CDN {
		fmt.Fprintf(&js, "%q,\n", m)
	}
	for _, tg := range targets {
		for _, bf := range tg.browsers {
			line := fmt.Sprintf("%q: %q", bf.host, bf.path)
			if bf.cft != "" {
				line = fmt.Sprintf("%q: cftUrl(%q)", bf.host, bf.cft)
			}
			if line != f.dropJS {
				js.WriteString(line + ",\n")
			}
		}
	}
	browsers := `{"browsers":[
		{"name":"chromium","revision":"1248","browserVersion":"156.0.8078.4"},
		{"name":"firefox","revision":"1555","browserVersion":"157.0"},
		{"name":"webkit","revision":"2370","revisionOverrides":{"mac14-arm64":"2251"},"browserVersion":"27.2"},
		{"name":"ffmpeg","revision":"1013"}]}`
	lock := map[string]map[string]string{}
	for _, name := range npmPackages {
		ver := pwVer
		if name == "typescript" {
			ver = tsVer
		}
		files := map[string]string{"package/package.json": `{"name":"` + name + `"}`}
		if name == "playwright-core" {
			files["package/browsers.json"] = browsers
			files["package/lib/server/registry.js"] = js.String()
		}
		body := tarball(t, files)
		tgzPath := "/npm/" + name + "/-/" + strings.TrimPrefix(name, "@playwright/") + "-" + ver + ".tgz"
		f.files[tgzPath] = body
		integrity := integrityOf(body)
		if v, ok := f.meta[name]; ok {
			integrity = v
		}
		meta, _ := json.Marshal(map[string]any{"version": ver, "dist": map[string]string{"tarball": f.srv.URL + tgzPath, "integrity": integrity}})
		f.files["/npm/"+name+"/"+ver] = meta
		lock["node_modules/"+name] = map[string]string{"version": ver, "integrity": integrityOf(body)}
	}
	lb, _ := json.Marshal(map[string]any{"packages": lock})
	f.lockPath = filepath.Join(t.TempDir(), "package-lock.json")
	if err := os.WriteFile(f.lockPath, lb, 0o644); err != nil {
		t.Fatal(err)
	}
	var shasums strings.Builder
	for name, body := range sums {
		f.files["/dist/v"+nodeVer+"/"+name] = body
		fmt.Fprintf(&shasums, "%s  %s\n", sha(body), name)
	}
	f.files["/dist/v"+nodeVer+"/SHASUMS256.txt"] = []byte(shasums.String())
	f.files["/dist/v"+nodeVer+"/SHASUMS256.txt.sig"] = sig
}

func nodeSums() map[string][]byte {
	return map[string][]byte{
		"node-v" + nodeVer + "-darwin-arm64.tar.gz": []byte("node-mac"),
		"node-v" + nodeVer + "-win-x64.zip":         []byte("node-win"),
	}
}

func (f *fixture) config(out string) config {
	return config{
		node: nodeVer, lock: f.lockPath, keys: filepath.Join(f.t.TempDir(), "keys.asc"), out: out,
		jobs: 4, src: f.src(), client: f.srv.Client(), gpg: filepath.Join(f.t.TempDir(), "không-có-gpg"),
		log: &bytes.Buffer{},
	}
}

func TestNodeWithoutGPGFailsClosed(t *testing.T) {
	f := newFixture(t)
	f.build(nodeSums(), []byte("sig"))
	out := filepath.Join(t.TempDir(), "pins_gen.go")
	c := f.config(out)
	if code := run(context.Background(), c); code != 1 {
		t.Fatalf("exit %d, muốn 1: %s", code, c.log)
	}
	if _, err := os.Stat(out); err == nil {
		t.Fatal("thiếu gpg thì không được ghi pin nào")
	}
	if !strings.Contains(c.log.(*bytes.Buffer).String(), "darwin/arm64/node") {
		t.Fatalf("phải nêu pin Node chưa xác minh: %s", c.log)
	}
}

func TestPartialWritesOnlyVerifiedPinsAndCheckCompares(t *testing.T) {
	f := newFixture(t)
	f.build(nodeSums(), []byte("sig"))
	out := filepath.Join(t.TempDir(), "pins_gen.go")
	c := f.config(out)
	c.partial = true
	if code := run(context.Background(), c); code != 2 {
		t.Fatalf("exit %d, muốn 2: %s", code, c.log)
	}
	src, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	s := string(src)
	for _, want := range []string{
		"// Code generated by cmd/pwpin; DO NOT EDIT.",
		`Dir: "webkit_mac14_arm64_special-2251", Rev: "2251"`,
		`Dir: "chromium-1248", Rev: "1248"`,
		"//   - darwin/arm64/node:",
	} {
		if !strings.Contains(s, want) {
			t.Errorf("pins_gen.go thiếu %s", want)
		}
	}
	for _, k := range []string{"npm/@playwright/test", "darwin/arm64/chromium", "darwin/arm64/webkit@mac26", "windows/amd64/webkit"} {
		if !hasPin(src, k) {
			t.Errorf("thiếu pin %s", k)
		}
	}
	if hasPin(src, "darwin/arm64/node") {
		t.Error("Node chưa xác minh không được có pin")
	}

	c.check, c.log = true, &bytes.Buffer{}
	if code := run(context.Background(), c); code != 2 || !strings.Contains(c.log.(*bytes.Buffer).String(), "khớp") {
		t.Fatalf("-check trên file vừa sinh: exit %d %s", code, c.log)
	}
	os.WriteFile(out, bytes.Replace(src, []byte("1248"), []byte("1249"), 1), 0o644)
	c.log = &bytes.Buffer{}
	if code := run(context.Background(), c); code != 1 {
		t.Fatalf("-check trên file bị sửa phải thất bại: exit %d", code)
	}
}

func TestBrowserMirrorsMustAgree(t *testing.T) {
	f := newFixture(t)
	f.build(nodeSums(), []byte("sig"))
	f.tamper["/m2/builds/firefox/1555/firefox-win64.zip"] = []byte("bị sửa")
	c := f.config(filepath.Join(t.TempDir(), "pins_gen.go"))
	c.partial = true
	run(context.Background(), c)
	src, _ := os.ReadFile(c.out)
	if hasPin(src, "windows/amd64/firefox") {
		t.Fatal("hai mirror khác nhau thì không được ghim")
	}
	if !strings.Contains(string(src), "windows/amd64/firefox: hai nguồn khác nhau") {
		t.Fatalf("phải ghi lý do: %s", src)
	}
}

func TestBrowserFallsBackToThirdMirror(t *testing.T) {
	f := newFixture(t)
	f.build(nodeSums(), []byte("sig"))
	f.down["/m1/builds/ffmpeg/1013/ffmpeg-win64.zip"] = true
	c := f.config(filepath.Join(t.TempDir(), "pins_gen.go"))
	c.partial = true
	run(context.Background(), c)
	src, _ := os.ReadFile(c.out)
	want := fmt.Sprintf(`URL: %q`, f.srv.URL+"/m2/builds/ffmpeg/1013/ffmpeg-win64.zip")
	if !strings.Contains(string(src), want) || !strings.Contains(string(src), f.srv.URL+"/m3/builds/ffmpeg/1013/ffmpeg-win64.zip") {
		t.Fatalf("mirror 1 hỏng thì đối chiếu mirror 2 với mirror 3:\n%s", src)
	}
}

func TestNPMIntegrityMustMatchRegistryAndLockfile(t *testing.T) {
	f := newFixture(t)
	f.meta["playwright"] = "sha512-" + base64.StdEncoding.EncodeToString(make([]byte, 64))
	f.build(nodeSums(), []byte("sig"))
	c := f.config(filepath.Join(t.TempDir(), "pins_gen.go"))
	c.partial = true
	run(context.Background(), c)
	src, _ := os.ReadFile(c.out)
	if hasPin(src, "npm/playwright") || !strings.Contains(string(src), "npm/playwright: sha512") {
		t.Fatalf("integrity registry sai thì không được ghim:\n%s", src)
	}

	f2 := newFixture(t)
	f2.build(nodeSums(), []byte("sig"))
	raw, _ := os.ReadFile(f2.lockPath)
	var lock map[string]map[string]map[string]string
	json.Unmarshal(raw, &lock)
	lock["packages"]["node_modules/typescript"]["integrity"] = "sha512-khác"
	raw, _ = json.Marshal(lock)
	os.WriteFile(f2.lockPath, raw, 0o644)
	c2 := f2.config(filepath.Join(t.TempDir(), "pins_gen.go"))
	c2.partial = true
	run(context.Background(), c2)
	src, _ = os.ReadFile(c2.out)
	if hasPin(src, "npm/typescript") || !strings.Contains(string(src), "khác package-lock.json") {
		t.Fatalf("lockfile khác thì không được ghim:\n%s", src)
	}
}

func TestNPMMissingFromLockfileFailsClosed(t *testing.T) {
	f := newFixture(t)
	f.build(nodeSums(), []byte("sig"))
	raw, _ := os.ReadFile(f.lockPath)
	var lock map[string]map[string]map[string]string
	json.Unmarshal(raw, &lock)
	delete(lock["packages"], "node_modules/playwright")
	raw, _ = json.Marshal(lock)
	os.WriteFile(f.lockPath, raw, 0o644)
	c := f.config(filepath.Join(t.TempDir(), "pins_gen.go"))
	c.partial = true
	run(context.Background(), c)
	src, _ := os.ReadFile(c.out)
	if hasPin(src, "npm/playwright") || !strings.Contains(string(src), "package-lock.json thiếu playwright") {
		t.Fatalf("gói không có trong lockfile thì không được ghim theo registry:\n%s", src)
	}
	if !hasPin(src, "npm/playwright-core") {
		t.Fatalf("gói còn lại vẫn phải được ghim:\n%s", src)
	}
}

func TestTableDriftBlocksEverything(t *testing.T) {
	f := newFixture(t)
	f.dropJS = `"win64": "builds/webkit/%s/webkit-win64.zip"`
	f.build(nodeSums(), []byte("sig"))
	c := f.config(filepath.Join(t.TempDir(), "pins_gen.go"))
	c.partial = true
	if code := run(context.Background(), c); code != 1 {
		t.Fatalf("bảng lệch playwright-core phải dừng hẳn: exit %d", code)
	}
	if _, err := os.Stat(c.out); err == nil {
		t.Fatal("không được ghi gì")
	}
}

// Đường đầy đủ với gpg thật: tạo khoá tạm, ký SHASUMS256.txt, mọi pin phải được ghi. Bỏ qua khi máy không có gpg.
func TestFullRunWithRealGPG(t *testing.T) {
	gpg, err := exec.LookPath("gpg")
	if err != nil {
		t.Skip("máy không có gpg")
	}
	home := t.TempDir()
	os.Chmod(home, 0o700)
	g := func(args ...string) []byte {
		out, err := exec.Command(gpg, append([]string{"--batch", "--no-tty", "--homedir", home}, args...)...).CombinedOutput()
		if err != nil {
			t.Fatalf("gpg %v: %v\n%s", args, err, out)
		}
		return out
	}
	g("--pinentry-mode", "loopback", "--passphrase", "", "--quick-gen-key", "pwpin-test@example.invalid", "ed25519", "sign", "never")
	keys := filepath.Join(t.TempDir(), "keys.asc")
	os.WriteFile(keys, g("--armor", "--export"), 0o644)

	f := newFixture(t)
	f.build(nodeSums(), nil)
	sumsPath := filepath.Join(t.TempDir(), "SHASUMS256.txt")
	os.WriteFile(sumsPath, f.files["/dist/v"+nodeVer+"/SHASUMS256.txt"], 0o644)
	g("--pinentry-mode", "loopback", "--passphrase", "", "--detach-sign", "--output", sumsPath+".sig", sumsPath)
	sig, _ := os.ReadFile(sumsPath + ".sig")
	f.files["/dist/v"+nodeVer+"/SHASUMS256.txt.sig"] = sig

	c := f.config(filepath.Join(t.TempDir(), "pins_gen.go"))
	c.keys, c.gpg = keys, gpg
	if code := run(context.Background(), c); code != 0 {
		t.Fatalf("exit %d: %s", code, c.log)
	}
	src, _ := os.ReadFile(c.out)
	for _, k := range []string{"darwin/arm64/node", "windows/amd64/node"} {
		if !hasPin(src, k) {
			t.Errorf("thiếu pin %s", k)
		}
	}
	if strings.Contains(string(src), "CHƯA ĐỦ") {
		t.Errorf("đủ pin thì không có danh sách thiếu:\n%s", src)
	}

	// SHASUMS256.txt bị sửa sau khi ký: gpg --verify thất bại, không ghi gì.
	f.files["/dist/v"+nodeVer+"/SHASUMS256.txt"] = append(f.files["/dist/v"+nodeVer+"/SHASUMS256.txt"], []byte("x  extra\n")...)
	c.out, c.log = filepath.Join(t.TempDir(), "pins_gen.go"), &bytes.Buffer{}
	if code := run(context.Background(), c); code != 1 {
		t.Fatalf("chữ ký sai phải thất bại: exit %d", code)
	}
}
