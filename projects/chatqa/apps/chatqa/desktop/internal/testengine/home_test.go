package testengine

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"testing"

	"deskcore/apperr"
)

func buildZip(t *testing.T, files map[string]string, modes map[string]os.FileMode) []byte {
	t.Helper()
	var buf bytes.Buffer
	w := zip.NewWriter(&buf)
	for name, body := range files {
		h := &zip.FileHeader{Name: name, Method: zip.Deflate}
		mode := os.FileMode(0o644)
		if m, ok := modes[name]; ok {
			mode = m
		}
		h.SetMode(mode)
		f, err := w.CreateHeader(h)
		if err != nil {
			t.Fatal(err)
		}
		f.Write([]byte(body))
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func shaHex(b []byte) string { s := sha256.Sum256(b); return hex.EncodeToString(s[:]) }

func serve(t *testing.T, body []byte, hits *int) *httptest.Server {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*hits++
		w.Write(body)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestRunnerTagMatchesGoMod(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", "go.mod"))
	if err != nil {
		t.Fatal(err)
	}
	m := regexp.MustCompile(`replace github.com/devicelab-dev/maestro-runner => github.com/LaBanHSPO/maestro-runner (\S+)`).FindSubmatch(b)
	if m == nil {
		t.Fatal("go.mod không replace maestro-runner bằng fork")
	}
	if string(m[1]) != RunnerTag {
		t.Fatalf("go.mod ghim %s nhưng RunnerTag = %s: đổi cả hai và SHA-256 bộ driver cùng lúc", m[1], RunnerTag)
	}
}

func TestEnsureInstallsOnceAndKeepsModes(t *testing.T) {
	body := buildZip(t, map[string]string{
		"drivers/android/devicelab-android-driver.apk": "apk",
		"drivers/android/tool.sh":                      "#!/bin/sh",
		"drivers/LICENSE-BINARIES.md":                  "licence",
		"LICENSE":                                      "apache",
	}, map[string]os.FileMode{"drivers/android/tool.sh": 0o755})
	hits := 0
	srv := serve(t, body, &hits)
	h := &Home{Dir: t.TempDir(), URL: func(string) string { return srv.URL }, SHA256: func(string) string { return shaHex(body) }}

	if h.Installed(PlatformAndroid) {
		t.Fatal("chưa cài mà báo đã cài")
	}
	var lastDone int64
	if err := h.Ensure(context.Background(), PlatformAndroid, func(done, _ int64) { lastDone = done }); err != nil {
		t.Fatal(err)
	}
	if !h.Installed(PlatformAndroid) || lastDone != int64(len(body)) {
		t.Fatalf("installed=%v progress=%d/%d", h.Installed(PlatformAndroid), lastDone, len(body))
	}
	if st, err := os.Stat(filepath.Join(h.DriversDir(PlatformAndroid), "tool.sh")); err != nil || st.Mode().Perm()&0o100 == 0 {
		t.Fatalf("mất quyền thực thi: %v %v", st.Mode(), err)
	}
	if _, err := os.Stat(filepath.Join(h.Dir, "drivers", "LICENSE-BINARIES.md")); err != nil {
		t.Fatal("giấy phép agent phải đi cùng bộ driver")
	}
	if err := h.Ensure(context.Background(), PlatformAndroid, nil); err != nil || hits != 1 {
		t.Fatalf("lần 2 không được tải lại: hits=%d err=%v", hits, err)
	}
	if entries, _ := filepath.Glob(filepath.Join(h.Dir, ".staging-*")); len(entries) != 0 {
		t.Fatalf("còn thư mục tạm: %v", entries)
	}
}

func TestEnsureRejectsWrongChecksum(t *testing.T) {
	body := buildZip(t, map[string]string{"drivers/android/a.apk": "x"}, nil)
	hits := 0
	srv := serve(t, body, &hits)
	h := &Home{Dir: t.TempDir(), URL: func(string) string { return srv.URL }, SHA256: func(string) string { return shaHex([]byte("khác")) }}
	err := h.Ensure(context.Background(), PlatformAndroid, nil)
	if apperr.CodeOf(err) != "bad_checksum" {
		t.Fatalf("err = %v, muốn bad_checksum", err)
	}
	if h.Installed(PlatformAndroid) {
		t.Fatal("bộ driver sai checksum không được cài")
	}
}

func TestEnsureRejectsPathOutsideHome(t *testing.T) {
	body := buildZip(t, map[string]string{"drivers/android/../../../evil": "x"}, nil)
	hits := 0
	srv := serve(t, body, &hits)
	dir := t.TempDir()
	h := &Home{Dir: filepath.Join(dir, "home"), URL: func(string) string { return srv.URL }, SHA256: func(string) string { return shaHex(body) }}
	if err := h.Ensure(context.Background(), PlatformAndroid, nil); err == nil {
		t.Fatal("zip có đường dẫn thoát ra ngoài phải bị từ chối")
	}
	if _, err := os.Stat(filepath.Join(dir, "evil")); err == nil {
		t.Fatal("đã ghi file ra ngoài thư mục")
	}
}

func TestEnsureOfflineWithoutBundle(t *testing.T) {
	h := &Home{Dir: t.TempDir(), URL: func(string) string { return "http://127.0.0.1:1/none.zip" }}
	if err := h.Ensure(context.Background(), PlatformIOS, nil); apperr.CodeOf(err) != CodeDriverBundleUnavailable {
		t.Fatalf("err = %v, muốn %s", err, CodeDriverBundleUnavailable)
	}
}

func TestSetupProcessDisablesTelemetry(t *testing.T) {
	t.Setenv("MAESTRO_RUNNER_NO_TELEMETRY", "")
	t.Setenv("MAESTRO_RUNNER_HOME", "")
	if err := SetupProcess("/tmp/cqs-home"); err != nil {
		t.Fatal(err)
	}
	if os.Getenv("MAESTRO_RUNNER_NO_TELEMETRY") != "1" || os.Getenv("MAESTRO_RUNNER_HOME") != "/tmp/cqs-home" {
		t.Fatal("môi trường tiến trình chưa đặt đúng")
	}
}

// Tải bộ driver thật từ release của fork và kiểm tra SHA-256 đã ghim. Cần mạng: CQS_LIVE_BUNDLE=1 go test -run Live ./internal/testengine
func TestLiveBundleMatchesPinnedChecksum(t *testing.T) {
	if os.Getenv("CQS_LIVE_BUNDLE") != "1" {
		t.Skip("đặt CQS_LIVE_BUNDLE=1 để tải bộ driver thật")
	}
	h := &Home{Dir: t.TempDir()}
	if err := h.Ensure(context.Background(), PlatformAndroid, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(h.DriversDir(PlatformAndroid), "devicelab-android-driver.apk")); err != nil {
		t.Fatal(err)
	}
}
