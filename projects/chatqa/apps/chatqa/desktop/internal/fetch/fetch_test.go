package fetch

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"deskcore/apperr"
)

func shaHex(b []byte) string { s := sha256.Sum256(b); return hex.EncodeToString(s[:]) }

func serveBody(t *testing.T, body []byte, hits *atomic.Int32) *httptest.Server {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.Header().Set("Content-Length", strconv.Itoa(len(body)))
		w.Write(body)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestDownloadVerifiesAndReportsProgress(t *testing.T) {
	body := make([]byte, 600<<10)
	for i := range body {
		body[i] = byte(i)
	}
	var hits atomic.Int32
	srv := serveBody(t, body, &hits)
	dest := filepath.Join(t.TempDir(), "a.zip")
	var calls int
	var last int64
	err := Download(context.Background(), Request{URL: srv.URL, SHA256: shaHex(body), Max: 1 << 20, Progress: func(done, _ int64) {
		calls++
		last = done
	}}, dest)
	if err != nil {
		t.Fatal(err)
	}
	if last != int64(len(body)) || calls < 2 {
		t.Fatalf("progress %d/%d sau %d lần báo", last, len(body), calls)
	}
	if b, _ := os.ReadFile(dest); len(b) != len(body) {
		t.Fatal("file đích sai kích thước")
	}
	if _, err := os.Stat(dest + ".part"); err == nil {
		t.Fatal("còn file .part")
	}
}

func TestDownloadRejectsWrongChecksum(t *testing.T) {
	var hits atomic.Int32
	srv := serveBody(t, []byte("thật"), &hits)
	dest := filepath.Join(t.TempDir(), "a.zip")
	err := Download(context.Background(), Request{URL: srv.URL, SHA256: shaHex([]byte("khác")), Max: 1 << 20}, dest)
	if apperr.CodeOf(err) != CodeBadChecksum {
		t.Fatalf("err = %v, muốn %s", err, CodeBadChecksum)
	}
	for _, p := range []string{dest, dest + ".part"} {
		if _, err := os.Stat(p); err == nil {
			t.Fatalf("file sai checksum không được để lại: %s", p)
		}
	}
}

func TestDownloadFailuresAreUnavailable(t *testing.T) {
	notFound := httptest.NewServer(http.NotFoundHandler())
	t.Cleanup(notFound.Close)
	var hits atomic.Int32
	big := serveBody(t, make([]byte, 2048), &hits)
	dir := t.TempDir()
	cases := map[string]Request{
		"http 404":  {URL: notFound.URL, SHA256: shaHex(nil), Max: 1 << 20},
		"offline":   {URL: "http://127.0.0.1:1/none.zip", SHA256: shaHex(nil), Max: 1 << 20},
		"quá lớn":   {URL: big.URL, SHA256: shaHex(make([]byte, 2048)), Max: 1024},
		"thiếu pin": {URL: big.URL, Max: 1 << 20},
	}
	for name, r := range cases {
		dest := filepath.Join(dir, name)
		if err := Download(context.Background(), r, dest); apperr.CodeOf(err) != CodeUnavailable {
			t.Errorf("%s: err = %v, muốn %s", name, err, CodeUnavailable)
		}
		if _, err := os.Stat(dest + ".part"); err == nil {
			t.Errorf("%s: còn file .part", name)
		}
	}
	if hits.Load() != 1 {
		t.Fatalf("thiếu pin thì không được gửi request: hits=%d", hits.Load())
	}
}

func TestKeyLockSerializesSameKeyOnly(t *testing.T) {
	var k KeyLock
	var inA atomic.Int32
	var maxA int32
	var mu sync.Mutex
	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			unlock := k.Lock("a")
			defer unlock()
			n := inA.Add(1)
			mu.Lock()
			maxA = max(maxA, n)
			mu.Unlock()
			time.Sleep(2 * time.Millisecond)
			inA.Add(-1)
		}()
	}
	unlockA := k.Lock("b") // khoá khác không chờ khoá "a"
	unlockA()
	wg.Wait()
	if maxA != 1 {
		t.Fatalf("cùng khoá chạy song song %d lượt", maxA)
	}
}
