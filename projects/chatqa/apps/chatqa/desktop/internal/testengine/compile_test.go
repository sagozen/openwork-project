package testengine

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/devicelab-dev/maestro-runner/pkg/cli"
	"github.com/devicelab-dev/maestro-runner/pkg/core"
	"github.com/devicelab-dev/maestro-runner/pkg/executor"
	"github.com/devicelab-dev/maestro-runner/pkg/flow"
	"github.com/devicelab-dev/maestro-runner/pkg/report"

	"deskcore/apperr"
)

// fakeLLM trả lời theo thứ tự cho từng mục đích (split/compile/repair) và giữ mọi body đã gửi.
type fakeLLM struct {
	mu      sync.Mutex
	replies map[string][]string // purpose (theo effort + schema) -> các câu trả lời JSON lần lượt
	stop    string
	bodies  []llmRequest
}

func (f *fakeLLM) purpose(req llmRequest) string {
	props := req.OutputConfig.Format.Schema["properties"].(map[string]any)
	switch {
	case props["cases"] != nil:
		return "split"
	case props["replacement"] != nil:
		return "repair"
	}
	return "compile"
}

func (f *fakeLLM) call(_ context.Context, body, out any) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	req := body.(llmRequest)
	f.bodies = append(f.bodies, req)
	p := f.purpose(req)
	if len(f.replies[p]) == 0 {
		return apperr.New("ai_unavailable", "hết câu trả lời giả cho "+p)
	}
	text := f.replies[p][0]
	f.replies[p] = f.replies[p][1:]
	stop := f.stop
	if stop == "" {
		stop = "end_turn"
	}
	raw, _ := json.Marshal(map[string]any{
		"content":     []map[string]any{{"type": "text", "text": text}},
		"stop_reason": stop,
		"usage":       map[string]int{"input_tokens": 1000, "output_tokens": 500},
		"billing":     map[string]any{"model": "sonnet", "costVnd": 150.0, "budgetLeftVnd": 499000.0},
	})
	return json.Unmarshal(raw, out)
}

func (f *fakeLLM) count(purpose string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, b := range f.bodies {
		if f.purpose(b) == purpose {
			n++
		}
	}
	return n
}

const splitReply = `{"cases":[{"id":"login_home","title":"Đăng nhập và vào trang chủ","steps":["Mở app","Đăng nhập"],"expected":"Thấy Trang chủ"}]}`

func compileReply(yaml string, risks ...string) string {
	b, _ := json.Marshal(map[string]any{"yaml": yaml, "risks": append([]string{}, risks...)})
	return string(b)
}

const goodYAML = "appId: com.example\n---\n- runFlow:\n    file: common/login.yaml\n- assertVisible: \"Trang chủ\"\n"

func newCompileEngine(t *testing.T, llm *fakeLLM) *Engine {
	t.Helper()
	e, _ := newTestEngine(t)
	writeTree(t, filepath.Join(e.Flows.Root, "demo"), map[string]string{
		"common/login.yaml": "appId: com.example\n---\n- launchApp\n- inputText: ${PASSWORD}\n",
	})
	e.LLM = llm.call
	return e
}

var compileReq = CompileRequest{App: "demo", Source: "Người dùng đăng nhập bằng mật khẩu " + secretPassword + " rồi thấy Trang chủ.",
	AppID: "com.example", Device: Device{ID: "emu-1", Platform: PlatformAndroid, Driver: "devicelab"}, Secrets: []string{"PASSWORD"}}

func TestCompileSavesVerifiedFlowThenRunsWithZeroTokens(t *testing.T) {
	llm := &fakeLLM{replies: map[string][]string{"split": {splitReply, splitReply}, "compile": {compileReply(goodYAML)}}}
	e := newCompileEngine(t, llm)
	res, err := e.Compile(context.Background(), compileReq)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Cases) != 1 || res.Cases[0].Status != CaseSaved {
		t.Fatalf("cases = %+v", res.Cases)
	}
	name := res.Cases[0].Flow
	infos, _ := e.Flows.List("demo")
	var saved *FlowInfo
	for i := range infos {
		if infos[i].Name == name {
			saved = &infos[i]
		}
	}
	if saved == nil || saved.SourceHash != res.SourceHash || saved.Stale {
		t.Fatalf("flow %s chưa lưu với hash nguồn: %+v", name, infos)
	}
	if entries, _ := filepath.Glob(filepath.Join(e.Flows.Root, "demo", candidatePrefix+"*")); len(entries) != 0 {
		t.Fatalf("ứng viên đạt phải được xoá: %v", entries)
	}

	// Request đúng hình: Sonnet qua Worker, effort theo bước, JSON schema, dự phòng khi bị từ chối, không lộ bí mật.
	for _, b := range llm.bodies {
		if b.Product != "chatqa" || b.Fallbacks != "default" || len(b.Betas) != 1 || b.OutputConfig.Format.Type != "json_schema" {
			t.Fatalf("request = %+v", b)
		}
		raw, _ := json.Marshal(b)
		if strings.Contains(string(raw), secretPassword) {
			t.Fatal("mật khẩu bị gửi cho LLM")
		}
	}
	if llm.bodies[0].OutputConfig.Effort != "low" || llm.bodies[1].OutputConfig.Effort != "medium" {
		t.Fatalf("effort = %s / %s", llm.bodies[0].OutputConfig.Effort, llm.bodies[1].OutputConfig.Effort)
	}
	if !strings.Contains(llm.bodies[1].Messages[0].Content, "common/login.yaml") || !strings.Contains(llm.bodies[1].Messages[0].Content, "PASSWORD") {
		t.Fatal("prompt viết YAML phải có flow con common/ và tên biến")
	}

	// Biên dịch lại cùng tài liệu: chỉ tách ca, ca không đổi thì không viết lại.
	res2, err := e.Compile(context.Background(), compileReq)
	if err != nil || res2.Cases[0].Status != CaseUnchanged || llm.count("compile") != 1 {
		t.Fatalf("lần 2: %+v err=%v compile calls=%d", res2.Cases, err, llm.count("compile"))
	}

	// Chạy flow đã biên dịch: sổ LLM không thêm dòng nào.
	before, _ := e.Metrics.Ledger(time.Time{}, 100)
	if _, err := e.Run(context.Background(), RunRequest{App: "demo", Flows: []string{name}, Devices: twoDevices, Secrets: []string{"PASSWORD"}, Repeat: 2}); err != nil {
		t.Fatal(err)
	}
	after, _ := e.Metrics.Ledger(time.Time{}, 100)
	if len(before) != 3 || len(after) != len(before) {
		t.Fatalf("sổ LLM: trước %d, sau %d; lượt chạy YAML phải không tốn token", len(before), len(after))
	}
}

func TestCompileRetriesInvalidYAMLOnceWithErrors(t *testing.T) {
	llm := &fakeLLM{replies: map[string][]string{"split": {splitReply}, "compile": {
		compileReply("appId: a\n---\n- notACommand: 1\n"), compileReply(goodYAML)}}}
	e := newCompileEngine(t, llm)
	res, err := e.Compile(context.Background(), compileReq)
	if err != nil || res.Cases[0].Status != CaseSaved {
		t.Fatalf("res = %+v err = %v", res, err)
	}
	if !strings.Contains(llm.bodies[2].Messages[0].Content, "previous_attempt_errors") {
		t.Fatal("lần thử lại phải gửi kèm lỗi")
	}
}

func TestCompileRejectsSecretLiteralAndFlagsRisks(t *testing.T) {
	leak := "appId: a\n---\n- launchApp\n- inputText: \"" + secretPassword + "\"\n"
	llm := &fakeLLM{replies: map[string][]string{"split": {splitReply, splitReply}, "compile": {compileReply(leak), compileReply(leak),
		compileReply("appId: a\n---\n- launchApp\n- tapOn:\n    point: \"50%,24%\"\n- assertVisible: \"Mã NV:  192754 - GLOBAL0\"\n")}}}
	e := newCompileEngine(t, llm)
	res, err := e.Compile(context.Background(), compileReq)
	if err != nil || res.Cases[0].Status != CaseInvalid || strings.Contains(res.Cases[0].Error, secretPassword) {
		t.Fatalf("res = %+v err = %v", res.Cases, err)
	}
	if fileExists(filepath.Join(e.Flows.Root, "demo", "02_login_home.yaml")) {
		t.Fatal("YAML lộ bí mật không được lưu")
	}
	res, err = e.Compile(context.Background(), compileReq)
	if err != nil || res.Cases[0].Status != CaseSaved {
		t.Fatalf("res = %+v err = %v", res.Cases, err)
	}
	risks := strings.Join(res.Cases[0].Risks, "\n")
	if !strings.Contains(risks, "toạ độ") || !strings.Contains(risks, "192754") {
		t.Fatalf("risks = %v", res.Cases[0].Risks)
	}
}

func TestCompileKeepsCandidateWhenVerificationFails(t *testing.T) {
	llm := &fakeLLM{replies: map[string][]string{"split": {splitReply}, "compile": {compileReply(goodYAML)}}}
	e := newCompileEngine(t, llm)
	e.Execute = func(_ context.Context, drv core.Driver, cfg *cli.RunConfig, flows []flow.Flow, opts ...func(*executor.RunnerConfig)) (*executor.RunResult, error) {
		if strings.Contains(flows[0].SourcePath, candidatePrefix) {
			return &executor.RunResult{Status: report.StatusFailed, FlowResults: []executor.FlowResult{{Status: report.StatusFailed, Error: "element not found"}}}, nil
		}
		return cli.ExecuteFlowsWithDriverContext(context.Background(), drv, cfg, flows, opts...)
	}
	res, err := e.Compile(context.Background(), compileReq)
	if err != nil || res.Cases[0].Status != CaseUnverified || res.Cases[0].Candidate == "" {
		t.Fatalf("res = %+v err = %v", res.Cases, err)
	}
	if _, err := os.Stat(filepath.Join(e.Flows.Root, "demo", res.Cases[0].Candidate)); err != nil {
		t.Fatal("ứng viên không đạt phải được giữ để xem")
	}
	if fileExists(filepath.Join(e.Flows.Root, "demo", res.Cases[0].Flow)) {
		t.Fatal("flow chưa xác nhận không được lưu")
	}
}

func TestLLMTokenCapAndRefusal(t *testing.T) {
	llm := &fakeLLM{replies: map[string][]string{"split": {splitReply}, "compile": {compileReply(goodYAML)}}}
	e := newCompileEngine(t, llm)
	e.TokenCap = 1000 // tách ca dùng 1500 token
	c := e.llm()
	var out map[string]any
	schema := obj(map[string]any{"cases": arr(str())})
	if err := c.structured(context.Background(), "demo", "f", "split", "low", "", "x", schema, 100, &out); err != nil {
		t.Fatal(err)
	}
	if err := c.structured(context.Background(), "demo", "f", "split", "low", "", "x", schema, 100, &out); apperr.CodeOf(err) != CodeLLMTokenCap {
		t.Fatalf("err = %v, muốn %s", err, CodeLLMTokenCap)
	}
	refuse := &fakeLLM{replies: map[string][]string{"split": {splitReply}}, stop: "refusal"}
	e.LLM = refuse.call
	if _, err := e.Compile(context.Background(), compileReq); apperr.CodeOf(err) != CodeLLMRefused {
		t.Fatalf("err = %v", err)
	}
}

func TestSaveVerifiedSavesOnlyAfterPassingRun(t *testing.T) {
	e, _ := newTestEngine(t)
	dev := Device{ID: "emu-1", Platform: PlatformAndroid, Driver: "devicelab"}
	yaml := "appId: com.example\n---\n- launchApp\n- tapOn: \"Mật khẩu\"\n- inputText: ${PASSWORD}\n"
	req := SaveVerifiedRequest{App: "demo", Name: "03_tu_viet.yaml", YAML: yaml, Device: dev, Secrets: []string{"PASSWORD"}}
	res, err := e.SaveVerified(context.Background(), req)
	if err != nil || res.Cases[0].Status != CaseSaved || res.Cases[0].RunID == "" {
		t.Fatalf("res = %+v err = %v", res, err)
	}
	if b, err := os.ReadFile(filepath.Join(e.Flows.Root, "demo", "03_tu_viet.yaml")); err != nil || string(b) != yaml {
		t.Fatalf("flow chưa được lưu đúng: %v", err)
	}
	// Đã có cùng tên: chỉ ghi đè khi replace.
	if _, err := e.SaveVerified(context.Background(), req); apperr.CodeOf(err) != apperr.CodeInvalid {
		t.Fatalf("trùng tên không replace: %v", err)
	}
	req.Replace = true
	if res, err := e.SaveVerified(context.Background(), req); err != nil || res.Cases[0].Status != CaseSaved {
		t.Fatalf("replace: %+v %v", res, err)
	}
}

// App chưa có thư mục (tạo mới qua test_save_flow): chạy xác nhận vẫn ghi được file ứng viên rồi lưu flow.
func TestSaveVerifiedCreatesNewApp(t *testing.T) {
	e, _ := newTestEngine(t)
	dev := Device{ID: "emu-1", Platform: PlatformAndroid, Driver: "devicelab"}
	res, err := e.SaveVerified(context.Background(), SaveVerifiedRequest{App: "app-moi", Name: "01_dau.yaml",
		YAML: "appId: com.example\n---\n- launchApp\n", Device: dev})
	if err != nil || res.Cases[0].Status != CaseSaved {
		t.Fatalf("app mới: %+v %v", res, err)
	}
	if _, err := os.Stat(filepath.Join(e.Flows.Root, "app-moi", "01_dau.yaml")); err != nil {
		t.Fatalf("flow chưa được lưu: %v", err)
	}
}

func TestSaveVerifiedRejectsUnsafeOrBadYAMLWithoutRunning(t *testing.T) {
	e, f := newTestEngine(t)
	dev := Device{ID: "emu-1", Platform: PlatformAndroid, Driver: "devicelab"}
	for name, yaml := range map[string]string{
		"04_script.yaml": "appId: com.example\n---\n- evalScript: ${http.get('https://x.example')}\n",
		"05_secret.yaml": "appId: com.example\n---\n- inputText: \"" + secretPassword + "\"\n",
		"06_syntax.yaml": "appId: com.example\n---\n- tapOn: [\n",
	} {
		res, err := e.SaveVerified(context.Background(), SaveVerifiedRequest{App: "demo", Name: name, YAML: yaml, Device: dev, Secrets: []string{"PASSWORD"}})
		if err != nil || res.Cases[0].Status != CaseInvalid || res.Cases[0].Error == "" {
			t.Errorf("%s: res = %+v err = %v", name, res, err)
		}
		if strings.Contains(res.Cases[0].Error, secretPassword) {
			t.Errorf("%s: lỗi lộ giá trị bí mật", name)
		}
		if fileExists(filepath.Join(e.Flows.Root, "demo", name)) {
			t.Errorf("%s: YAML không hợp lệ đã được lưu", name)
		}
	}
	if c, _ := f.counts("emu-1"); c != 0 {
		t.Errorf("YAML không hợp lệ không được chạy trên thiết bị (driver tạo %d lần)", c)
	}
	for _, bad := range []string{"common/x.yaml", ".hidden.yaml", "config.yaml", "x.txt"} {
		if _, err := e.SaveVerified(context.Background(), SaveVerifiedRequest{App: "demo", Name: bad, YAML: "appId: a.b\n---\n- launchApp\n", Device: dev}); apperr.CodeOf(err) != apperr.CodeInvalid {
			t.Errorf("tên %q phải bị từ chối: %v", bad, err)
		}
	}
}

func TestSaveVerifiedKeepsCandidateWhenRunFails(t *testing.T) {
	e, _ := newTestEngine(t)
	e.Execute = func(context.Context, core.Driver, *cli.RunConfig, []flow.Flow, ...func(*executor.RunnerConfig)) (*executor.RunResult, error) {
		return &executor.RunResult{Status: report.StatusFailed, FlowResults: []executor.FlowResult{{Status: report.StatusFailed, Error: "element not found"}}}, nil
	}
	res, err := e.SaveVerified(context.Background(), SaveVerifiedRequest{App: "demo", Name: "07_hong.yaml",
		YAML: "appId: com.example\n---\n- tapOn: \"Không có\"\n", Device: Device{ID: "emu-1", Platform: PlatformAndroid, Driver: "devicelab"}})
	if err != nil || res.Cases[0].Status != CaseUnverified || res.Cases[0].Candidate != ".candidate-07_hong.yaml" || res.Cases[0].RunID == "" {
		t.Fatalf("res = %+v err = %v", res, err)
	}
	if fileExists(filepath.Join(e.Flows.Root, "demo", "07_hong.yaml")) {
		t.Fatal("flow chạy không đạt không được lưu")
	}
	if !fileExists(filepath.Join(e.Flows.Root, "demo", res.Cases[0].Candidate)) {
		t.Fatal("ứng viên không đạt phải được giữ để xem")
	}
}

// Manifest ca cũ (chỉ hash, flow) đọc được như trước; biên dịch từ tài liệu tự do vẫn chạy và ca là "chưa truy vết".
func TestCompileReadsOldCaseManifest(t *testing.T) {
	llm := &fakeLLM{replies: map[string][]string{"split": {splitReply}}}
	e := newCompileEngine(t, llm)
	dir := filepath.Join(e.Flows.Root, "demo")
	old := TestCase{Title: "Đăng nhập và vào trang chủ", Steps: []string{"Mở app", "Đăng nhập"}, Expected: "Thấy Trang chủ"}
	writeTree(t, dir, map[string]string{
		"02_login_home.yaml": goodYAML,
		casesFile:            `{"sourceHash":"abc","cases":{"login_home":{"hash":"` + old.hash() + `","flow":"02_login_home.yaml"}}}`,
	})
	man := readCases(dir)
	if m := man.Cases["login_home"]; man.SourceHash != "abc" || m.Hash != old.hash() || m.Flow != "02_login_home.yaml" ||
		m.Case != nil || m.Reqs != nil || m.ReqHash != nil || m.Status != "" || !m.UpdatedAt.IsZero() {
		t.Fatalf("manifest cũ = %+v", man)
	}
	res, err := e.Compile(context.Background(), compileReq)
	if err != nil || len(res.Cases) != 1 || res.Cases[0].Status != CaseUnchanged || llm.count("compile") != 0 {
		t.Fatalf("res = %+v err = %v compile = %d", res, err, llm.count("compile"))
	}
	m := readCases(dir).Cases["login_home"]
	if m.Hash != old.hash() || m.Flow != "02_login_home.yaml" || m.Case == nil || m.Case.Title != old.Title ||
		m.Status != CaseUnchanged || len(m.Reqs) != 0 || m.UpdatedAt.IsZero() {
		t.Fatalf("sau biên dịch = %+v", m)
	}
	cov, err := e.Coverage("demo")
	if err != nil || len(cov.Reqs) != 0 || len(cov.Untraced) != 1 || cov.Untraced[0].ID != "login_home" {
		t.Fatalf("coverage = %+v err = %v", cov, err)
	}
}

// Ca không đạt vẫn là bản ghi trong manifest (chưa có flow), để hiện trong danh sách ca.
func TestCompileRecordsFailedCases(t *testing.T) {
	leak := "appId: a\n---\n- launchApp\n- inputText: \"" + secretPassword + "\"\n"
	llm := &fakeLLM{replies: map[string][]string{"split": {splitReply}, "compile": {compileReply(leak), compileReply(leak)}}}
	e := newCompileEngine(t, llm)
	res, err := e.Compile(context.Background(), compileReq)
	if err != nil || res.Cases[0].Status != CaseInvalid {
		t.Fatalf("res = %+v err = %v", res, err)
	}
	m, ok := readCases(filepath.Join(e.Flows.Root, "demo")).Cases["login_home"]
	if !ok || m.Status != CaseInvalid || m.Flow != "" || m.Hash != "" || m.Case == nil || m.Case.Title != "Đăng nhập và vào trang chủ" {
		t.Fatalf("ca không đạt = %+v (có %v)", m, ok)
	}
}

func TestScanRisksLongDigitsStayInsideOneQuotedString(t *testing.T) {
	yaml := "appId: com.apple.Preferences\n---\n- launchApp:\n    appId: com.apple.Preferences\n- extendedWaitUntil:\n    visible: \"General\"\n    timeout: 15000\n- assertVisible: \"General\"\n"
	if r := scanRisks(yaml); len(r) != 0 {
		t.Fatalf("số của khoá YAML giữa hai chuỗi bị báo nhầm: %v", r)
	}
	r := scanRisks("- tapOn: \"NV123456\"\n- inputText: \"${PHONE}\"\n")
	if len(r) != 1 || !strings.Contains(r[0], "NV123456") {
		t.Fatalf("chuỗi có số dài phải được báo: %v", r)
	}
}
