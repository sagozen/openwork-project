package testengine

import (
	"context"
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"chatqa/internal/pw"
	"deskcore/apperr"
)

const brokenSpec = `import { test, expect, step } from './chatqa';

test('đăng nhập', async ({ page }) => {
  await step('mở trang', async () => {
    await page.goto('/login');
  });
  await step('bấm Đăng nhập', async () => {
    await page.getByLabel('Mật khẩu').fill(process.env.PASSWORD);
    await page.getByRole('button', { name: 'Đăng nhập' }).click();
  });
  await step('thấy Trang chủ', async () => {
    await expect(page.getByText('Trang chủ')).toBeVisible();
  });
});
`

const fixedBlock = `await step('bấm Đăng nhập', async () => {
    await page.getByLabel('Mật khẩu').fill(process.env.PASSWORD);
    await page.getByRole('button', { name: 'Đăng nhập ngay' }).click();
  });`

// repairScript: spec có nút "Đăng nhập ngay" luôn đạt; spec khác hỏng ở bước "bấm Đăng nhập" với message (failN lần đầu,
// failN < 0 = luôn hỏng), kèm aria snapshot và URL lúc hỏng (cả hai chứa mật khẩu).
func repairScript(message string, failN int) func(t *testing.T, job pw.Job) ([]pw.Event, pw.Result) {
	var mu sync.Mutex
	calls := 0
	return func(t *testing.T, job pw.Job) ([]pw.Event, pw.Result) {
		mu.Lock()
		calls++
		n := calls
		mu.Unlock()
		if strings.Contains(string(job.Spec), "Đăng nhập ngay") || (failN >= 0 && n > failN) {
			return passScript(t, job)
		}
		return []pw.Event{
			{Type: pw.EventBegin, Total: 1},
			{Type: pw.EventStep, Test: "t1", Depth: 0, Title: "mở trang", Category: "test.step", DurationMs: 40},
			{Type: pw.EventStep, Test: "t1", Depth: 1, Title: "Click", Category: "pw:api", Error: &pw.TestError{Message: message}},
			{Type: pw.EventStep, Test: "t1", Depth: 0, Title: "bấm Đăng nhập", Category: "test.step", Error: &pw.TestError{Message: message}},
			{Type: pw.EventTest, Test: "t1", Title: "đăng nhập", Status: "failed", DurationMs: 900, Error: &pw.TestError{Message: message},
				Attachments: []pw.Attachment{
					{Name: "failure-aria", ContentType: "text/plain", Body: "- textbox \"Mật khẩu\" [ref=e2]: " + secretPassword + "\n- button \"Đăng nhập ngay\" [ref=e3]"},
					{Name: "failure-url", ContentType: "text/plain", Body: "http://app.test/login?pw=" + url.QueryEscape(secretPassword)},
				}},
			{Type: pw.EventEnd, Status: "failed"},
		}, pw.Result{Ended: true, Status: "failed"}
	}
}

func webRepairEngine(t *testing.T, llm *fakeLLM, script func(t *testing.T, job pw.Job) ([]pw.Event, pw.Result)) (*Engine, *replayRunner) {
	t.Helper()
	run := &replayRunner{script: script}
	e, _ := webAuthorEngine(t, run, llm)
	writeTree(t, filepath.Join(e.Flows.Root, "demo"), map[string]string{"04_dang_nhap.spec.ts": brokenSpec})
	return e, run
}

var webRepairReq = RepairRequest{App: "demo", Flow: "04_dang_nhap.spec.ts", Device: webDev("web-a"), Secrets: []string{"PASSWORD"}}

const clickTimeout = "locator.click: Timeout 10000ms exceeded waiting for getByRole('button', { name: 'Đăng nhập' })"

func TestWebRepairFlakyNeedsNoLLM(t *testing.T) {
	llm := &fakeLLM{}
	e, _ := webRepairEngine(t, llm, repairScript(clickTimeout, 1))
	res, err := e.Repair(context.Background(), webRepairReq)
	if err != nil || !res.Flaky || len(res.Attempts) != 2 || res.Diff != nil || len(llm.bodies) != 0 {
		t.Fatalf("res = %+v err = %v llm = %d", res, err, len(llm.bodies))
	}
}

func TestWebRepairEnvironmentFailureStopsWithoutLLM(t *testing.T) {
	for _, msg := range []string{"page.goto: net::ERR_CONNECTION_REFUSED at http://app.test/login", "web_host_blocked: navigation http://evil.test/"} {
		llm := &fakeLLM{}
		e, _ := webRepairEngine(t, llm, repairScript(msg, -1))
		res, err := e.Repair(context.Background(), webRepairReq)
		if err != nil || res.Flaky || len(res.Attempts) != 1 || res.Attempts[0].FailureClass != FailEnvironment || res.Diff != nil {
			t.Fatalf("%s: res = %+v err = %v", msg, res, err)
		}
		if len(llm.bodies) != 0 {
			t.Fatalf("%s: lỗi môi trường không được gọi LLM", msg)
		}
	}
}

func repairReply(replacement string) string {
	b, _ := json.Marshal(map[string]string{"replacement": replacement, "explanation": "Nút đã đổi tên thành Đăng nhập ngay."})
	return string(b)
}

func TestWebRepairSplicesOneStepVerifiesAndApplies(t *testing.T) {
	llm := &fakeLLM{replies: map[string][]string{"repair": {repairReply("\n  " + fixedBlock + "\n")}}}
	e, run := webRepairEngine(t, llm, repairScript(clickTimeout, -1))
	res, err := e.Repair(context.Background(), webRepairReq)
	if err != nil {
		t.Fatal(err)
	}
	if res.Flaky || len(res.Attempts) != 2 || len(llm.bodies) != 1 || len(run.jobs) != 3 {
		t.Fatalf("flaky=%v attempts=%d llm=%d runs=%d: chạy lại 2 lần, gọi LLM một lần rồi chạy thử", res.Flaky, len(res.Attempts), len(llm.bodies), len(run.jobs))
	}
	if llm.bodies[0].System != repairWebSystem {
		t.Fatal("sửa spec phải dùng prompt web")
	}
	prompt := llm.bodies[0].Messages[0].Content
	for _, want := range []string{`<failing_step title="bấm Đăng nhập" line="7">`, "name: 'Đăng nhập' }).click();\n  });\n</failing_step>",
		`button "Đăng nhập ngay" [ref=e3]`, "<url_at_failure>http://app.test/login?pw=***</url_at_failure>", "Timeout 10000ms"} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("prompt sửa thiếu %q:\n%s", want, prompt)
		}
	}
	raw, _ := json.Marshal(llm.bodies[0])
	for _, f := range secretForms([]string{secretPassword}) {
		if strings.Contains(string(raw), f) {
			t.Fatal("prompt sửa lộ mật khẩu")
		}
	}
	d := res.Diff
	start := strings.Index(brokenSpec, "await step('bấm Đăng nhập'")
	end := strings.Index(brokenSpec, "  await step('thấy Trang chủ'") - 1
	want := brokenSpec[:start] + fixedBlock + brokenSpec[end:]
	if d == nil || !d.Valid || !d.Verified || d.RunID == "" || d.After != want || d.Before != brokenSpec {
		t.Fatalf("diff = %+v\nafter:\n%s", d, d.After)
	}
	if !strings.Contains(d.Diff, "+     await page.getByRole('button', { name: 'Đăng nhập ngay' }).click();") {
		t.Fatalf("diff dòng:\n%s", d.Diff)
	}
	if b, _ := os.ReadFile(filepath.Join(e.Flows.Root, "demo", webRepairReq.Flow)); string(b) != brokenSpec {
		t.Fatal("bản sửa chưa duyệt không được ghi vào flow")
	}

	info, err := e.ApplyRepair(*d)
	if err != nil || info.Stale || info.Name != webRepairReq.Flow {
		t.Fatalf("ApplyRepair: %+v %v", info, err)
	}
	infos, _ := e.Flows.List("demo")
	for _, fi := range infos {
		if fi.Name == webRepairReq.Flow && (fi.Stale || fi.Hash == "") {
			t.Fatalf("spec sau khi duyệt phải có hash mới, không cũ: %+v", fi)
		}
	}
	if b, _ := os.ReadFile(filepath.Join(e.Flows.Root, "demo", webRepairReq.Flow)); string(b) != want {
		t.Fatalf("flow sau khi duyệt:\n%s", b)
	}
	if _, err := e.ApplyRepair(*d); apperr.CodeOf(err) != apperr.CodeInvalid {
		t.Fatalf("áp lại bản sửa cũ lên flow đã đổi phải bị từ chối: %v", err)
	}
}

func TestWebRepairUnsafeReplacementIsNotValid(t *testing.T) {
	unsafe := strings.Replace(fixedBlock, "await page.getByLabel('Mật khẩu')", "await page.evaluate('fetch(1)');\n    await page.getByLabel('Mật khẩu')", 1)
	twoSteps := fixedBlock + "\n  await step('thêm', async () => {\n    await page.reload();\n  });"
	for label, repl := range map[string]string{"evaluate": unsafe, "hai khối step": twoSteps} {
		llm := &fakeLLM{replies: map[string][]string{"repair": {repairReply(repl)}}}
		e, run := webRepairEngine(t, llm, repairScript(clickTimeout, -1))
		res, err := e.Repair(context.Background(), webRepairReq)
		if err != nil {
			t.Fatal(err)
		}
		d := res.Diff
		if d == nil || d.Valid || d.Verified || !strings.Contains(d.Error, webRepairReq.Flow+":") {
			t.Fatalf("%s: diff = %+v", label, d)
		}
		if len(run.jobs) != 2 {
			t.Fatalf("%s: bản sửa không hợp lệ không được chạy thử (%d lượt)", label, len(run.jobs))
		}
	}
}

func TestWebRepairRefusesSpecOnPhone(t *testing.T) {
	e, run := webRepairEngine(t, &fakeLLM{}, repairScript(clickTimeout, -1))
	req := webRepairReq
	req.Device = twoDevices[0]
	if _, err := e.Repair(context.Background(), req); apperr.CodeOf(err) != apperr.CodeInvalid || len(run.jobs) != 0 {
		t.Fatalf("err = %v runs = %d", err, len(run.jobs))
	}
}

func TestApplyRepairOnSpecRefusesChangedFile(t *testing.T) {
	e, _ := webRepairEngine(t, &fakeLLM{}, nil)
	path := filepath.Join(e.Flows.Root, "demo", webRepairReq.Flow)
	d := YamlDiff{App: "demo", Flow: webRepairReq.Flow, Before: brokenSpec, After: strings.Replace(brokenSpec, "'Đăng nhập' }", "'Đăng nhập ngay' }", 1)}
	if err := os.WriteFile(path, []byte(brokenSpec+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := e.ApplyRepair(d); apperr.CodeOf(err) != apperr.CodeInvalid {
		t.Fatalf("flow đã đổi: %v", err)
	}
	if b, _ := os.ReadFile(path); string(b) != brokenSpec+"\n" {
		t.Fatal("flow đã đổi không được bị ghi đè")
	}
}

func TestFailingSpecStepMatchesTitleThenIndex(t *testing.T) {
	steps := []SpecStep{{Title: "a", StartByte: 0}, {Title: "b", StartByte: 10}, {Title: "a", StartByte: 20}}
	if st, ok := failingSpecStep(steps, StepRun{Desc: "a", Index: 2}); !ok || st.StartByte != 20 {
		t.Fatalf("trùng tiêu đề phải chọn theo thứ tự bước: %+v", st)
	}
	if st, ok := failingSpecStep(steps, StepRun{Desc: "b", Index: 0}); !ok || st.StartByte != 10 {
		t.Fatalf("tiêu đề duy nhất: %+v", st)
	}
	if _, ok := failingSpecStep(steps, StepRun{Desc: "c"}); ok {
		t.Fatal("không có tiêu đề")
	}
	if got := failureURL("hỏng (trang: http://a.test/x?y=(1))"); got != "http://a.test/x?y=(1)" {
		t.Fatalf("failureURL = %q", got)
	}
}
