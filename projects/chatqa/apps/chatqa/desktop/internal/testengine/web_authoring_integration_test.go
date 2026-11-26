//go:build pwintegration

package testengine

import (
	"archive/zip"
	"context"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Biên dịch, lưu, tự sửa và xuất chạy độc lập flow web với Node + Playwright + Chromium thật (sidecar kiểm tra spec
// và lấy snapshot, pw.Runner chạy xác nhận); LLM là fakeLLM (prompt và cách đọc trả lời thật, câu trả lời dựng sẵn):
//
//	go test -tags pwintegration ./internal/testengine/ -run 'WebCompileReal|WebSaveVerified|WebRepairReal|WebExportStandalone' -count=1 -timeout 20m

const realLoginSpec = `import { test, expect, step } from './chatqa';

test('đăng nhập', async ({ page }) => {
  await step('mở trang', async () => {
    await page.goto('/login');
  });
  await step('điền và gửi', async () => {
    await page.getByLabel('Tên').fill('alice');
    await page.getByLabel('Mật khẩu').fill(process.env.PASSWORD);
    await page.getByRole('button', { name: 'Đăng nhập' }).click();
  });
  await step('kiểm tra', async () => {
    await expect(page.getByText('Xin chào alice')).toBeVisible();
  });
});
`

func TestWebCompileRealSidecarSavesVerifiedSpec(t *testing.T) {
	site := newWebSite(t)
	e, _, devs := realWebEngine(t, site, "web-c")
	llm := &fakeLLM{replies: map[string][]string{"split": {splitReply}, "compile": {specReply(realLoginSpec)}}}
	e.LLM = llm.call
	res, err := e.Compile(context.Background(), CompileRequest{App: "demo", Source: "Đăng nhập bằng alice / " + secretPassword + ", thấy lời chào.",
		Device: devs[0], Secrets: []string{"PASSWORD"}, StartPath: "/login"})
	if err != nil {
		t.Fatal(err)
	}
	cc := res.Cases[0]
	if cc.Status != CaseSaved || cc.Flow != "02_login_home.spec.ts" || cc.RunID == "" {
		t.Fatalf("case = %+v", cc)
	}
	if b, _ := os.ReadFile(filepath.Join(e.Flows.Root, "demo", cc.Flow)); string(b) != realLoginSpec {
		t.Fatal("spec chưa được lưu nguyên văn")
	}
	prompt := llm.bodies[1].Messages[0].Content
	if !strings.Contains(prompt, `textbox "Mật khẩu"`) || !strings.Contains(prompt, "[ref=e") || !strings.Contains(prompt, "/login") {
		t.Fatalf("prompt phải có aria snapshot thật của trang start_path:\n%s", prompt)
	}
	for _, b := range llm.bodies {
		raw, _ := json.Marshal(b)
		if strings.Contains(string(raw), secretPassword) {
			t.Fatal("mật khẩu bị gửi cho LLM")
		}
	}
}

func TestWebSaveVerifiedRealValidatorRunAndSave(t *testing.T) {
	site := newWebSite(t)
	e, _, devs := realWebEngine(t, site, "web-s")
	req := func(name, script string) SaveVerifiedRequest {
		return SaveVerifiedRequest{App: "demo", Name: name, Script: script, Device: devs[0], Secrets: []string{"PASSWORD"}}
	}
	for name, tc := range map[string]struct {
		spec string
		line string
	}{
		"03_import.spec.ts":   {strings.Replace(realLoginSpec, "import {", "import fs from 'node:fs';\nimport {", 1), ":1:"},
		"04_template.spec.ts": {strings.Replace(realLoginSpec, "page.goto('/login')", "page.goto(`/login?p=${process.env.PASSWORD}`)", 1), ":5:"},
		"05_locator.spec.ts":  {strings.Replace(realLoginSpec, "getByLabel('Tên')", "getByLabel(process.env.PASSWORD)", 1), ":8:"},
		"06_evaluate.spec.ts": {strings.Replace(realLoginSpec, "await page.goto('/login');", "await page.evaluate('1');", 1), ":5:"},
	} {
		res, err := e.SaveVerified(context.Background(), req(name, tc.spec))
		if err != nil || res.Cases[0].Status != CaseInvalid || !strings.Contains(res.Cases[0].Error, name+tc.line) || res.Cases[0].RunID != "" {
			t.Errorf("%s: phải invalid kèm file và dòng %s: %+v %v", name, tc.line, res, err)
		}
	}
	res, err := e.SaveVerified(context.Background(), req("07_hong.spec.ts", strings.Replace(realLoginSpec, "Xin chào alice')).toBeVisible()",
		"Xin chào bob')).toBeVisible({ timeout: 1500 })", 1)))
	if err != nil || res.Cases[0].Status != CaseUnverified || res.Cases[0].RunID == "" {
		t.Fatalf("spec chạy không đạt: %+v %v", res, err)
	}
	res, err = e.SaveVerified(context.Background(), req("08_dang_nhap.spec.ts", realLoginSpec))
	if err != nil || res.Cases[0].Status != CaseSaved || !fileExists(filepath.Join(e.Flows.Root, "demo", "08_dang_nhap.spec.ts")) {
		t.Fatalf("spec đạt phải được lưu: %+v %v", res, err)
	}
}

func TestWebRepairRealRetriesTwiceThenVerifiesFix(t *testing.T) {
	site := newWebSite(t)
	e, _, devs := realWebEngine(t, site, "web-r")
	broken := strings.Replace(realLoginSpec, "{ name: 'Đăng nhập' }).click()", "{ name: 'Đăng nhập ngay' }).click({ timeout: 1500 })", 1)
	writeSpecFile(t, e, "09_sua.spec.ts", broken)
	fixed := "await step('điền và gửi', async () => {\n    await page.getByLabel('Tên').fill('alice');\n" +
		"    await page.getByLabel('Mật khẩu').fill(process.env.PASSWORD);\n    await page.getByRole('button', { name: 'Đăng nhập' }).click();\n  });"
	llm := &fakeLLM{replies: map[string][]string{"repair": {repairReply(fixed)}}}
	e.LLM = llm.call
	res, err := e.Repair(context.Background(), RepairRequest{App: "demo", Flow: "09_sua.spec.ts", Device: devs[0], Secrets: []string{"PASSWORD"}})
	if err != nil {
		t.Fatal(err)
	}
	if res.Flaky || len(res.Attempts) != 2 || res.Attempts[1].FailureClass != FailAutomation || len(llm.bodies) != 1 {
		t.Fatalf("chạy lại 2 lần rồi gọi LLM một lần: %+v llm=%d", res.Attempts, len(llm.bodies))
	}
	prompt := llm.bodies[0].Messages[0].Content
	if !strings.Contains(prompt, `button "Đăng nhập"`) || !strings.Contains(prompt, "<url_at_failure>"+site.baseURL()+"/login</url_at_failure>") ||
		strings.Contains(prompt, secretPassword) {
		t.Fatalf("prompt sửa phải có aria snapshot và URL lúc hỏng, không có mật khẩu:\n%s", prompt)
	}
	d := res.Diff
	if d == nil || !d.Valid || !d.Verified || d.RunID == "" {
		t.Fatalf("diff = %+v", d)
	}
	if _, err := e.ApplyRepair(*d); err != nil {
		t.Fatal(err)
	}
	sum, err := e.Run(context.Background(), RunRequest{App: "demo", Flows: []string{"09_sua.spec.ts"}, Devices: devs, Secrets: []string{"PASSWORD"}})
	if err != nil || sum.Run.Passed != 1 {
		t.Fatalf("flow sau khi duyệt phải đạt: %+v %v", sum, err)
	}
}

func TestWebRepairRealEnvironmentFailureSkipsLLM(t *testing.T) {
	site := newWebSite(t)
	e, _, devs := realWebEngine(t, site, "web-env")
	writeSpecFile(t, e, "10_moi.spec.ts", realLoginSpec)
	site.allowed.Close() // trang không còn: net::ERR_CONNECTION_REFUSED
	llm := &fakeLLM{}
	e.LLM = llm.call
	res, err := e.Repair(context.Background(), RepairRequest{App: "demo", Flow: "10_moi.spec.ts", Device: devs[0], Secrets: []string{"PASSWORD"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Attempts) != 1 || res.Attempts[0].FailureClass != FailEnvironment || res.Diff != nil || len(llm.bodies) != 0 {
		t.Fatalf("lỗi môi trường phải dừng sau một lần, không gọi LLM: %+v llm=%d", res.Attempts, len(llm.bodies))
	}
}

// Gói xuất chạy bằng npx playwright test trong thư mục ngoài app, không có biến nào của ChatQA; chỉ node_modules (đúng
// bản Playwright ghim) và trình duyệt của Playwright trên máy, như sau npm install và npx playwright install.
func TestWebExportStandaloneRunsWithNpxOutsideApp(t *testing.T) {
	npx, err := exec.LookPath("npx")
	if err != nil {
		t.Skip("không có npx trong PATH")
	}
	site := newWebSite(t)
	e, _, devs := realWebEngine(t, site, "web-x")
	res, err := e.SaveVerified(context.Background(), SaveVerifiedRequest{App: "demo", Name: "11_xuat.spec.ts", Script: realLoginSpec,
		Device: devs[0], Secrets: []string{"PASSWORD"}})
	if err != nil || res.Cases[0].Status != CaseSaved {
		t.Fatalf("lưu spec: %+v %v", res, err)
	}
	p, err := e.Web.Profile(devs[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	path, err := e.ExportSpec("demo", "11_xuat.spec.ts", &p)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	zr, err := zip.OpenReader(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range zr.File {
		if strings.Contains(f.Name, "trace") || strings.HasSuffix(f.Name, ".zip") {
			t.Errorf("zip có trace: %s", f.Name)
		}
		r, _ := f.Open()
		b, _ := io.ReadAll(r)
		r.Close()
		if strings.Contains(string(b), secretPassword) {
			t.Errorf("%s chứa giá trị bí mật", f.Name)
		}
		dst := filepath.Join(dir, filepath.FromSlash(f.Name))
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(dst, b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	zr.Close()
	if err := os.Symlink(rootModules(t), filepath.Join(dir, "node_modules")); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, npx, "--no-install", "playwright", "test")
	cmd.Dir = dir
	cmd.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=" + os.Getenv("HOME"), "PASSWORD=" + secretPassword}
	if b := os.Getenv("PLAYWRIGHT_BROWSERS_PATH"); b != "" {
		cmd.Env = append(cmd.Env, "PLAYWRIGHT_BROWSERS_PATH="+b)
	}
	out, err := cmd.CombinedOutput()
	if err != nil || !strings.Contains(string(out), "1 passed") {
		t.Fatalf("npx playwright test ngoài app phải đạt: %v\n%s", err, out)
	}
	t.Logf("%s", out)
}
