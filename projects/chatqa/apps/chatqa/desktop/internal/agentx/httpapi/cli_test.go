package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

var srvApp = absPath("srv/app")

func TestParseCLI(t *testing.T) {
	c, err := ParseCLI([]string{"--pipeline", "--repo", srvApp, "--from", "v1.2", "--to", "HEAD", "--wait", "--poll", "1s"}, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	if c.Repo != srvApp || c.From != "v1.2" || c.To != "HEAD" || !c.Wait || c.Poll != time.Second || c.Timeout != 2*time.Hour {
		t.Fatalf("parsed %+v", c)
	}
	c, err = ParseCLI([]string{"--pipeline", "--from", "abc"}, io.Discard)
	if err != nil || !filepath.IsAbs(c.Repo) {
		t.Fatalf("default repo must be the absolute current folder: %+v %v", c, err)
	}
	for _, bad := range [][]string{
		{"--pipeline"},                         // no --from
		{"--pipeline", "--from", "a", "extra"}, // stray argument
		{"--pipeline", "--from", "a", "--poll", "0s"},
		{"--pipeline", "--from", "a", "--bogus"},
	} {
		if _, err := ParseCLI(bad, io.Discard); err == nil {
			t.Errorf("%v accepted", bad)
		}
	}
}

// fakeApp is the running app's API as the CLI sees it.
type fakeApp struct {
	mu       sync.Mutex
	statuses []string // returned by successive GETs; the last one repeats
	failed   bool
	gets     int
	started  map[string]any
	auth     string
	refuse   int // status code for POST /agent/pipeline; 0 = accept
}

func (f *fakeApp) handler(t *testing.T) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.auth = r.Header.Get("Authorization")
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/agent/pipeline":
			if f.refuse != 0 {
				writeError(w, f.refuse, "từ chối")
				return
			}
			_ = json.NewDecoder(r.Body).Decode(&f.started)
			writeJSON(w, http.StatusAccepted, startResponse{SessionID: "sess-1", StatusURL: "/agent/pipeline/sess-1"})
		case r.Method == http.MethodGet && r.URL.Path == "/agent/pipeline/sess-1":
			st := f.statuses[min(f.gets, len(f.statuses)-1)]
			f.gets++
			out := map[string]any{"sessionId": "sess-1", "status": st, "pending": []any{}}
			if st == "done" {
				out["failed"] = f.failed
				out["report"] = "Báo cáo"
			}
			if st == "waiting_approval" {
				out["pending"] = []any{map[string]any{"kind": "request_input", "text": "Duyệt flow\n02_order"}}
			}
			writeJSON(w, http.StatusOK, out)
		default:
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	})
}

func runCLI(t *testing.T, f *fakeApp, cli CLI) (int, string, string) {
	t.Helper()
	srv := httptest.NewServer(f.handler(t))
	defer srv.Close()
	var out, errOut bytes.Buffer
	code := RunCLI(context.Background(), Client{Base: srv.URL, Token: "cqs_tok"}, cli, &out, &errOut)
	return code, out.String(), errOut.String()
}

func TestRunCLIForwardsToTheApp(t *testing.T) {
	cli := CLI{Repo: "/srv/app", From: "a", To: "b", Poll: time.Millisecond, Timeout: 5 * time.Second}

	f := &fakeApp{statuses: []string{"running"}}
	code, out, _ := runCLI(t, f, cli)
	if code != ExitOK || !strings.Contains(out, "session: sess-1") || f.gets != 0 {
		t.Fatalf("no wait: %d %q gets=%d", code, out, f.gets)
	}
	if f.auth != "Bearer cqs_tok" || f.started["repo"] != "/srv/app" || f.started["from"] != "a" || f.started["to"] != "b" || f.started["trigger"] != "cli" {
		t.Fatalf("forwarded auth=%q body=%v", f.auth, f.started)
	}

	cli.Wait = true
	cases := []struct {
		name     string
		statuses []string
		failed   bool
		want     int
		says     string
	}{
		{"all pass", []string{"running", "running", "done"}, false, ExitOK, "report:\nBáo cáo"},
		{"a flow failed", []string{"done"}, true, ExitFlowsFailed, "failed: true"},
		{"needs approval", []string{"running", "waiting_approval"}, false, ExitWaitingApproval, "pending: Duyệt flow 02_order"},
		{"run failed", []string{"failed"}, false, ExitError, "status: failed"},
	}
	for _, c := range cases {
		code, out, _ := runCLI(t, &fakeApp{statuses: c.statuses, failed: c.failed}, cli)
		if code != c.want || !strings.Contains(out, c.says) {
			t.Errorf("%s: exit %d, want %d; out %q", c.name, code, c.want, out)
		}
	}

	slow := cli
	slow.Timeout = 30 * time.Millisecond
	if code, _, errOut := runCLI(t, &fakeApp{statuses: []string{"running"}}, slow); code != ExitTimeout || !strings.Contains(errOut, "vẫn chạy") {
		t.Fatalf("timeout: %d %q", code, errOut)
	}
	if code, _, errOut := runCLI(t, &fakeApp{refuse: http.StatusUnauthorized}, cli); code != ExitError || !strings.Contains(errOut, "401") {
		t.Fatalf("refused: %d %q", code, errOut)
	}
	var stdout, stderr bytes.Buffer
	if code := RunCLI(context.Background(), Client{Base: "http://127.0.0.1:1", Token: "x"}, cli, &stdout, &stderr); code != ExitError || !strings.Contains(stderr.String(), "đang mở") {
		t.Fatalf("app not running: %d %q", code, stderr.String())
	}
}
