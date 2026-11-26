package testengine

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"testing"

	"deskcore/apperr"
)

// specCheckStub: bộ kiểm tra giả của stubSpecs cộng vùng byte các khối step() và vài luật của bộ thật (bộ thật chạy
// trong sidecar, kiểm tra bằng node --test và test pwintegration): goto với template, import ngoài './chatqa',
// process.env trong locator.
type specCheckStub struct{ stubSpecs }

func (s *specCheckStub) ValidateSpec(ctx context.Context, src []byte, envNames, hosts []string) (SpecCheck, error) {
	chk, err := s.stubSpecs.ValidateSpec(ctx, src, envNames, hosts)
	for i, l := range strings.Split(string(src), "\n") {
		t := strings.TrimSpace(l)
		switch {
		case strings.Contains(l, "goto(`"):
			chk.Errors = append(chk.Errors, SpecIssue{Line: i + 1, Col: 1, Message: "URL phải là một chuỗi viết thẳng (không template, không ghép, không biến)"})
		case strings.HasPrefix(t, "import ") && !strings.HasSuffix(t, "from './chatqa';"):
			chk.Errors = append(chk.Errors, SpecIssue{Line: i + 1, Col: 1, Message: "chỉ được import từ './chatqa'"})
		case regexp.MustCompile(`getBy\w+\(process\.env`).MatchString(l):
			chk.Errors = append(chk.Errors, SpecIssue{Line: i + 1, Col: 1, Message: "process.env chỉ dùng làm giá trị của fill, pressSequentially, keyboard.type"})
		}
	}
	chk.Steps = stubSteps(src)
	return chk, err
}

// stubSteps: vùng byte của mỗi câu "await step('tên', ...);" (từ chữ await tới hết "});" cùng thụt lề), như bộ thật.
func stubSteps(src []byte) []SpecStep {
	lines := strings.Split(string(src), "\n")
	offs := make([]int, len(lines))
	for i, off := 0, 0; i < len(lines); i++ {
		offs[i] = off
		off += len(lines[i]) + 1
	}
	var out []SpecStep
	for i, l := range lines {
		at := strings.Index(l, "await step('")
		if at < 0 {
			continue
		}
		title := l[at+len("await step('"):]
		title = title[:strings.Index(title, "'")]
		indent := l[:at]
		for j := i; j < len(lines); j++ {
			if lines[j] == indent+"});" {
				out = append(out, SpecStep{Title: title, StartByte: offs[i] + at, EndByte: offs[j] + len(indent) + 3, Line: i + 1})
				break
			}
		}
	}
	return out
}

// pageStub: phiên trình duyệt giả cho lấy snapshot khi biên dịch.
type pageStub struct {
	mu   sync.Mutex
	urls []string
	tree string
}

func (p *pageStub) Screenshot() ([]byte, error)                                          { return onePixelPNG(), nil }
func (p *pageStub) Hierarchy() ([]byte, error)                                           { return []byte(p.tree), nil }
func (p *pageStub) Tap(context.Context, float64, float64) error                          { return nil }
func (p *pageStub) Swipe(context.Context, float64, float64, float64, float64, int) error { return nil }
func (p *pageStub) Act(_ context.Context, a WebAction) (WebResult, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.urls = append(p.urls, a.Kind+" "+a.URL)
	return WebResult{URL: "http://app.test" + a.URL}, nil
}

// webAuthorEngine: engine web thử (app demo, hồ sơ web-a/web-b/web-ff) với bộ kiểm tra specCheckStub, phiên trình duyệt
// pageStub và bộ chạy spec run.
func webAuthorEngine(t *testing.T, run *replayRunner, llm *fakeLLM) (*Engine, *pageStub) {
	t.Helper()
	e, _ := webEngine(t, run)
	e.Flows.Specs = &specCheckStub{}
	page := &pageStub{tree: "# url: http://app.test/login | title: \"Đăng nhập\" | viewport: 1280x800 | snapshotId: 1-1\n" +
		"- textbox \"Mật khẩu\" [ref=e2] [box=0.1,0.2,0.3,0.04]: " + secretPassword + "\n- button \"Đăng nhập\" [ref=e3]"}
	e.Pool.OpenWeb = func(context.Context, Device) (DeviceDriver, func(), error) { return page, func() {}, nil }
	if llm != nil {
		e.LLM = llm.call
	}
	return e, page
}

func specReply(spec string, risks ...string) string {
	b, _ := json.Marshal(map[string]any{"spec": spec, "risks": append([]string{}, risks...)})
	return string(b)
}

const webLoginSpec = `import { test, expect, step } from './chatqa';

test('Đăng nhập và vào trang chủ', async ({ page }) => {
  await step('mở trang đăng nhập', async () => {
    await page.goto('/login');
  });
  await step('đăng nhập', async () => {
    await page.getByLabel('Mật khẩu').fill(process.env.PASSWORD);
    await page.getByRole('button', { name: 'Đăng nhập' }).click();
  });
  await step('thấy trang chủ', async () => {
    await expect(page.getByText('Trang chủ')).toBeVisible();
  });
});
`

var webCompileReq = CompileRequest{App: "demo", Source: "Người dùng đăng nhập bằng mật khẩu " + secretPassword + " rồi thấy Trang chủ.",
	Device: webDev("web-a"), Secrets: []string{"PASSWORD"}, StartPath: "/login"}

func TestWebCompileSavesVerifiedSpecWithoutAppID(t *testing.T) {
	llm := &fakeLLM{replies: map[string][]string{"split": {splitReply, splitReply}, "compile": {specReply(webLoginSpec)}}}
	run := &replayRunner{script: passScript}
	e, page := webAuthorEngine(t, run, llm)
	res, err := e.Compile(context.Background(), webCompileReq)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Cases) != 1 || res.Cases[0].Status != CaseSaved || res.Cases[0].Flow != "02_login_home.spec.ts" {
		t.Fatalf("cases = %+v", res.Cases)
	}
	name := res.Cases[0].Flow
	if b, err := os.ReadFile(filepath.Join(e.Flows.Root, "demo", name)); err != nil || string(b) != webLoginSpec {
		t.Fatalf("spec chưa được lưu nguyên văn: %v", err)
	}
	infos, _ := e.Flows.List("demo")
	var saved *FlowInfo
	for i := range infos {
		if infos[i].Name == name {
			saved = &infos[i]
		}
	}
	if saved == nil || saved.Stale || saved.SourceHash != res.SourceHash {
		t.Fatalf("spec chưa lưu với hash nguồn: %+v", infos)
	}
	if entries, _ := filepath.Glob(filepath.Join(e.Flows.Root, "demo", candidatePrefix+"*")); len(entries) != 0 {
		t.Fatalf("ứng viên đạt phải được xoá: %v", entries)
	}
	if len(page.urls) != 1 || page.urls[0] != "navigate /login" {
		t.Fatalf("phải mở start_path trước khi đọc snapshot: %v", page.urls)
	}
	if len(run.jobs) != 1 || !strings.Contains(string(run.jobs[0].Spec), "Đăng nhập và vào trang chủ") {
		t.Fatalf("spec phải chạy xác nhận đúng một lần: %d", len(run.jobs))
	}
	for _, b := range llm.bodies {
		raw, _ := json.Marshal(b)
		if strings.Contains(string(raw), secretPassword) {
			t.Fatal("mật khẩu (trong tài liệu hay snapshot) bị gửi cho LLM")
		}
	}
	if llm.bodies[0].System != splitWebSystem || llm.bodies[1].System != compileWebSystem {
		t.Fatal("biên dịch cho web phải dùng prompt web")
	}
	prompt := llm.bodies[1].Messages[0].Content
	for _, want := range []string{"<start_path>/login</start_path>", "PASSWORD", `button "Đăng nhập" [ref=e3]`} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("prompt viết spec thiếu %q:\n%s", want, prompt)
		}
	}

	// Biên dịch lại: ca không đổi, không viết lại.
	res2, err := e.Compile(context.Background(), webCompileReq)
	if err != nil || res2.Cases[0].Status != CaseUnchanged || res2.Cases[0].Flow != name || llm.count("compile") != 1 {
		t.Fatalf("lần 2: %+v err=%v compile=%d", res2.Cases, err, llm.count("compile"))
	}
	// Cùng tài liệu cho điện thoại: ca web không được coi là đã có flow YAML.
	llm.replies["split"] = append(llm.replies["split"], splitReply)
	llm.replies["compile"] = append(llm.replies["compile"], compileReply(goodYAML))
	writeTree(t, filepath.Join(e.Flows.Root, "demo"), map[string]string{"common/login.yaml": "appId: com.example\n---\n- launchApp\n"})
	mob := compileReq
	mob.Device = twoDevices[0]
	res3, err := e.Compile(context.Background(), mob)
	if err != nil || res3.Cases[0].Status != CaseSaved || !strings.HasSuffix(res3.Cases[0].Flow, ".yaml") {
		t.Fatalf("mobile sau web: %+v err=%v", res3.Cases, err)
	}
	man := readCases(filepath.Join(e.Flows.Root, "demo"))
	if man.Cases["login_home"].Flow != res3.Cases[0].Flow || man.Cases[webCaseID("login_home")].Flow != name {
		t.Fatalf("manifest ca phải tách mobile/web: %+v", man.Cases)
	}
}

func TestWebCompileInvalidTwiceGivesInvalidWithLine(t *testing.T) {
	bad := strings.Replace(webLoginSpec, "await page.goto('/login');", "await page.evaluate('fetch(1)');", 1)
	llm := &fakeLLM{replies: map[string][]string{"split": {splitReply}, "compile": {specReply(bad), specReply(bad)}}}
	run := &replayRunner{script: passScript}
	e, _ := webAuthorEngine(t, run, llm)
	res, err := e.Compile(context.Background(), webCompileReq)
	if err != nil || res.Cases[0].Status != CaseInvalid {
		t.Fatalf("res = %+v err = %v", res, err)
	}
	if !strings.Contains(res.Cases[0].Error, "02_login_home.spec.ts:5:") || !strings.Contains(res.Cases[0].Error, "evaluate") {
		t.Fatalf("lỗi phải có file và dòng: %s", res.Cases[0].Error)
	}
	if !strings.Contains(llm.bodies[2].Messages[0].Content, "previous_attempt_errors") {
		t.Fatal("lần viết lại phải gửi kèm lỗi")
	}
	if len(run.jobs) != 0 || fileExists(filepath.Join(e.Flows.Root, "demo", "02_login_home.spec.ts")) {
		t.Fatal("spec không qua kiểm tra không được chạy hay lưu")
	}
}

func TestWebCompileFailedVerificationKeepsCandidate(t *testing.T) {
	llm := &fakeLLM{replies: map[string][]string{"split": {splitReply}, "compile": {specReply(webLoginSpec)}}}
	run := &replayRunner{script: failScript("expect(locator).toBeVisible() failed", "expect", "failed", "http://app.test/home")}
	e, _ := webAuthorEngine(t, run, llm)
	res, err := e.Compile(context.Background(), webCompileReq)
	if err != nil {
		t.Fatal(err)
	}
	cc := res.Cases[0]
	if cc.Status != CaseUnverified || cc.Candidate != ".candidate-02_login_home.spec.ts" || cc.RunID == "" {
		t.Fatalf("case = %+v", cc)
	}
	if !fileExists(filepath.Join(e.Flows.Root, "demo", cc.Candidate)) || fileExists(filepath.Join(e.Flows.Root, "demo", cc.Flow)) {
		t.Fatal("ứng viên không đạt phải được giữ, flow không được lưu")
	}
}

func TestCompileAppIDRequiredForMobileOnly(t *testing.T) {
	e, _ := webAuthorEngine(t, nil, &fakeLLM{})
	mob := compileReq
	mob.AppID = ""
	if _, err := e.Compile(context.Background(), mob); apperr.CodeOf(err) != apperr.CodeInvalid || !strings.Contains(err.Error(), "appId") {
		t.Fatalf("mobile thiếu appId: %v", err)
	}
	web := webCompileReq
	web.StartPath = "https://evil.example/x"
	if _, err := e.Compile(context.Background(), web); apperr.CodeOf(err) != apperr.CodeInvalid || !strings.Contains(err.Error(), "startPath") {
		t.Fatalf("web không cần appId nhưng startPath phải là đường dẫn tương đối: %v", err)
	}
}

func scriptReq(name, script string) SaveVerifiedRequest {
	return SaveVerifiedRequest{App: "demo", Name: name, Script: script, Device: webDev("web-a"), Secrets: []string{"PASSWORD"}}
}

func TestSaveVerifiedScriptSavesOnlyAfterPassingRun(t *testing.T) {
	run := &replayRunner{script: passScript}
	e, _ := webAuthorEngine(t, run, nil)
	res, err := e.SaveVerified(context.Background(), scriptReq("05_dang_nhap.spec.ts", webLoginSpec))
	if err != nil || res.Cases[0].Status != CaseSaved || res.Cases[0].RunID == "" || res.Cases[0].Case.ID != "05_dang_nhap" {
		t.Fatalf("res = %+v err = %v", res, err)
	}
	if b, _ := os.ReadFile(filepath.Join(e.Flows.Root, "demo", "05_dang_nhap.spec.ts")); string(b) != webLoginSpec {
		t.Fatal("spec chưa được lưu nguyên văn")
	}
	if len(run.jobs) != 1 || run.jobs[0].Vars["PASSWORD"] != secretPassword {
		t.Fatalf("chạy xác nhận phải nhận biến spec dùng: %d", len(run.jobs))
	}
	// Tên trống: số tiếp theo, đuôi .spec.ts.
	res, err = e.SaveVerified(context.Background(), scriptReq("", webLoginSpec))
	if err != nil || res.Cases[0].Status != CaseSaved || res.Cases[0].Flow != "06_flow.spec.ts" {
		t.Fatalf("tên trống: %+v %v", res, err)
	}
}

func TestSaveVerifiedScriptRejectsUnsafeSpecWithFileAndLine(t *testing.T) {
	run := &replayRunner{script: passScript}
	e, _ := webAuthorEngine(t, run, nil)
	for name, tc := range map[string]struct {
		spec string
		line string
	}{
		"07_import.spec.ts":   {"import fs from 'node:fs';\n" + webLoginSpec, ":1:"},
		"08_template.spec.ts": {strings.Replace(webLoginSpec, "page.goto('/login')", "page.goto(`/login?u=${process.env.PASSWORD}`)", 1), ":5:"},
		"09_locator.spec.ts":  {strings.Replace(webLoginSpec, "getByLabel('Mật khẩu')", "getByLabel(process.env.PASSWORD)", 1), ":8:"},
		"10_secret.spec.ts":   {strings.Replace(webLoginSpec, "fill(process.env.PASSWORD)", "fill('"+secretPassword+"')", 1), ":8:"},
	} {
		res, err := e.SaveVerified(context.Background(), scriptReq(name, tc.spec))
		if err != nil || res.Cases[0].Status != CaseInvalid {
			t.Errorf("%s: res = %+v err = %v", name, res, err)
			continue
		}
		if msg := res.Cases[0].Error; !strings.Contains(msg, name+tc.line) || strings.Contains(msg, secretPassword) {
			t.Errorf("%s: lỗi phải có file và dòng %s, không lộ bí mật: %s", name, tc.line, msg)
		}
		if fileExists(filepath.Join(e.Flows.Root, "demo", name)) {
			t.Errorf("%s: spec không hợp lệ đã được lưu", name)
		}
	}
	if len(run.jobs) != 0 {
		t.Fatalf("spec không hợp lệ không được chạy (%d lượt)", len(run.jobs))
	}
}

func TestSaveVerifiedScriptRequestShape(t *testing.T) {
	e, _ := webAuthorEngine(t, &replayRunner{script: passScript}, nil)
	both := scriptReq("11_x.spec.ts", webLoginSpec)
	both.YAML = "appId: com.example\n---\n- launchApp\n"
	android := scriptReq("12_x.spec.ts", webLoginSpec)
	android.Device = twoDevices[0]
	yamlOnWeb := SaveVerifiedRequest{App: "demo", Name: "13_x.yaml", YAML: "appId: com.example\n---\n- launchApp\n", Device: webDev("web-a")}
	firefox := scriptReq("14_x.spec.ts", webLoginSpec)
	firefox.Device = webDev("web-ff")
	for label, req := range map[string]SaveVerifiedRequest{
		"yaml và script":               both,
		"không yaml cũng không script": {App: "demo", Name: "15_x.spec.ts", Device: webDev("web-a")},
		"tên .yaml với script":         scriptReq("16_x.yaml", webLoginSpec),
		"tên .ts không phải spec":      scriptReq("chatqa.ts", webLoginSpec),
		"script trên android":          android,
		"yaml trên hồ sơ web":          yamlOnWeb,
		"bí mật trên firefox":          firefox,
	} {
		if _, err := e.SaveVerified(context.Background(), req); apperr.CodeOf(err) != apperr.CodeInvalid {
			t.Errorf("%s: err = %v, muốn invalid", label, err)
		}
	}
}

func TestSaveVerifiedScriptFailedVerificationReturnsRunID(t *testing.T) {
	run := &replayRunner{script: failScript("locator.click: Timeout 10000ms exceeded", "pw:api", "failed", "http://app.test/login")}
	e, _ := webAuthorEngine(t, run, nil)
	res, err := e.SaveVerified(context.Background(), scriptReq("17_hong.spec.ts", webLoginSpec))
	if err != nil || res.Cases[0].Status != CaseUnverified || res.Cases[0].RunID == "" || res.Cases[0].Candidate != ".candidate-17_hong.spec.ts" {
		t.Fatalf("res = %+v err = %v", res, err)
	}
	if fileExists(filepath.Join(e.Flows.Root, "demo", "17_hong.spec.ts")) {
		t.Fatal("spec chạy không đạt không được lưu")
	}
	flows, err := e.Metrics.FlowRuns(res.Cases[0].RunID)
	if err != nil || len(flows) != 1 || flows[0].Platform != PlatformWeb || flows[0].Passed {
		t.Fatalf("lượt xác nhận phải có trong sổ: %+v %v", flows, err)
	}
}

// Biên dịch web theo yêu cầu: ca mang mã TC-…, khoá manifest có tiền tố web: và không lẫn với ca điện thoại.
func TestWebCompileFromRequirements(t *testing.T) {
	llm := &fakeLLM{replies: map[string][]string{"split": {tracedSplit(loginCase)}, "compile": {specReply(webLoginSpec)}}}
	run := &replayRunner{script: passScript}
	e, _ := webAuthorEngine(t, run, llm)
	if _, err := e.Docs.Save("demo", "prd-checkout", checkoutDoc); err != nil {
		t.Fatal(err)
	}
	req := webCompileReq
	req.Source, req.Reqs = "", []string{"REQ-012"}
	res, err := e.Compile(context.Background(), req)
	if err != nil || len(res.Cases) != 1 || res.Cases[0].Status != CaseSaved || !tcIDRe.MatchString(res.Cases[0].Case.ID) ||
		!strings.HasSuffix(res.Cases[0].Flow, specExt) {
		t.Fatalf("res = %+v err = %v", res, err)
	}
	if llm.bodies[0].System != splitWebSystem+splitReqRules || !strings.Contains(llm.bodies[0].Messages[0].Content, `<requirement id="REQ-012"`) {
		t.Fatal("tách ca web theo yêu cầu phải dùng prompt web kèm luật reqs")
	}
	id := res.Cases[0].Case.ID
	m, ok := readCases(filepath.Join(e.Flows.Root, "demo")).Cases[webCaseID(id)]
	if !ok || m.Flow != res.Cases[0].Flow || !slices.Equal(m.Reqs, []string{"REQ-012"}) {
		t.Fatalf("manifest ca web = %+v (có %v)", m, ok)
	}

	// Biên dịch lại: ca web cũ được gửi trong existing_cases; LLM giữ mã ⇒ không viết lại.
	again := loginCase
	again.ID = id
	llm.replies["split"] = append(llm.replies["split"], tracedSplit(again))
	res, err = e.Compile(context.Background(), req)
	if err != nil || res.Cases[0].Status != CaseUnchanged || res.Cases[0].Case.ID != id || llm.count("compile") != 1 {
		t.Fatalf("lần 2: %+v err = %v compile = %d", res, err, llm.count("compile"))
	}
	if !strings.Contains(llm.bodies[2].Messages[0].Content, `"id": "`+id+`"`) {
		t.Fatal("existing_cases của ca web phải dùng mã không tiền tố")
	}
	editDoc(t, e, "rồi thấy Trang chủ.", "rồi thấy Trang chủ và tên mình.")
	if ids := affectedIDs(t, e); !slices.Equal(ids, []string{webCaseID(id)}) {
		t.Fatalf("affected = %v", ids)
	}
}
