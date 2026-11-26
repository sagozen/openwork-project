package testengine

import (
	"archive/zip"
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"deskcore/apperr"
)

func runAlways(t *testing.T, e *Engine) *RunSummary {
	t.Helper()
	sum, err := e.Run(context.Background(), RunRequest{App: "demo", Devices: twoDevices[:1], Secrets: []string{"PASSWORD"},
		Artifacts: ArtifactsAlways})
	if err != nil {
		t.Fatal(err)
	}
	return sum
}

func firstShot(t *testing.T, sum *RunSummary) string {
	t.Helper()
	for _, s := range sum.Flows[0].Steps {
		if s.ShotAfter != "" {
			return s.ShotAfter
		}
	}
	t.Fatal("không có ảnh bước")
	return ""
}

func TestStepShotRejectsTraversal(t *testing.T) {
	e, _ := newTestEngine(t)
	sum := runAlways(t, e)
	rel := firstShot(t, sum)
	url, err := e.StepShot(sum.Run.ID, rel)
	if err != nil || !strings.HasPrefix(url, "data:image/png;base64,") {
		t.Fatalf("ảnh hợp lệ: %.40q %v", url, err)
	}
	outside := filepath.Join(t.TempDir(), "secret.png")
	if err := os.WriteFile(outside, []byte("png"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(sum.Run.OutDir, "link.png")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sum.Run.OutDir, "note.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"", "../x.png", "a/../../x.png", outside, "/etc/passwd.png", `C:\x.png`, `a\..\..\x.png`,
		"note.txt", "link.png", RunJournalFile} {
		if _, err := e.StepShot(sum.Run.ID, bad); err == nil {
			t.Errorf("%q phải bị từ chối", bad)
		}
	}
	if _, err := e.StepShot("261118-000000", rel); apperr.CodeOf(err) != apperr.CodeNotFound {
		t.Fatalf("lượt không có: %v", err)
	}
}

func TestStepTextReadsOnlyTxtInsideRun(t *testing.T) {
	e, _ := newTestEngine(t)
	sum := runAlways(t, e)
	if err := os.MkdirAll(filepath.Join(sum.Run.OutDir, "assets"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sum.Run.OutDir, "assets", "failure-aria-1.txt"), []byte("- button \"Lưu\""), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := e.StepText(sum.Run.ID, "assets/failure-aria-1.txt")
	if err != nil || got != "- button \"Lưu\"" {
		t.Fatalf("StepText = %q %v", got, err)
	}
	outside := filepath.Join(t.TempDir(), "secret.txt")
	if err := os.WriteFile(outside, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(sum.Run.OutDir, "link.txt")); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"", "../x.txt", outside, `a\b.txt`, "assets/failure-aria-1.png", "link.txt", RunJournalFile} {
		if _, err := e.StepText(sum.Run.ID, bad); err == nil {
			t.Errorf("%q phải bị từ chối", bad)
		}
	}
}

// Cây aria có thể chứa giá trị đã điền: StepText che với mọi bí mật trong kho và từ chối lượt có dấu che hỏng.
func TestStepTextRedactsAndRefusesUnredactedRun(t *testing.T) {
	e, _ := newTestEngine(t)
	sum := runAlways(t, e)
	p := filepath.Join(sum.Run.OutDir, "assets", "failure-aria-1.txt")
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(`- textbox "Mật khẩu": `+secretPassword), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := e.StepText(sum.Run.ID, "assets/failure-aria-1.txt")
	if err != nil || strings.Contains(got, secretPassword) || !strings.Contains(got, "Mật khẩu") {
		t.Fatalf("StepText = %q %v; muốn đã che bí mật", got, err)
	}
	if err := os.WriteFile(filepath.Join(sum.Run.OutDir, RedactionFailedMark), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got, err := e.StepText(sum.Run.ID, "assets/failure-aria-1.txt"); apperr.CodeOf(err) != CodeRedactionFailed || got != "" {
		t.Fatalf("lượt có dấu che hỏng: %q %v; muốn redaction_failed", got, err)
	}
}

func readZip(t *testing.T, path string) map[string]string {
	t.Helper()
	zr, err := zip.OpenReader(path)
	if err != nil {
		t.Fatal(err)
	}
	defer zr.Close()
	out := map[string]string{}
	for _, f := range zr.File {
		rc, err := f.Open()
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(rc)
		rc.Close()
		out[f.Name] = string(b)
	}
	return out
}

func TestExportRunZipHasEvidenceAndNoSecrets(t *testing.T) {
	e, _ := newTestEngine(t)
	sum := runAlways(t, e)
	// Một hàng sổ lỡ chứa bí mật thô (vd bản cũ chưa che) vẫn bị che khi xuất.
	if err := e.Metrics.RecordLLM(LedgerEntry{At: sum.Run.StartedAt, Purpose: "repair", BudgetLeftVnd: -1,
		Request: "mật khẩu " + secretPassword}); err != nil {
		t.Fatal(err)
	}
	if err := e.Metrics.RecordToolCall(ToolCall{At: sum.Run.StartedAt, Source: "ui", Tool: "test_run", Args: `{"x":1}`}); err != nil {
		t.Fatal(err)
	}
	dest := filepath.Join(t.TempDir(), "out", "run.zip")
	if err := e.ExportRun(sum.Run.ID, dest); err != nil {
		t.Fatal(err)
	}
	files := readZip(t, dest)
	for _, name := range []string{"summary.json", RunJournalFile, "evidence.html", "llm_calls.json", "tool_calls.json"} {
		if _, ok := files[name]; !ok {
			t.Errorf("thiếu %s", name)
		}
	}
	var report, asset bool
	for name, body := range files {
		if strings.Contains(body, secretPassword) {
			t.Errorf("%s lộ mật khẩu", name)
		}
		report = report || (strings.HasPrefix(name, "reports/") && strings.HasSuffix(name, "/report.html"))
		asset = asset || (strings.HasPrefix(name, "reports/") && strings.Contains(name, "/assets/") && strings.HasSuffix(name, ".png"))
	}
	if !report || !asset {
		t.Fatalf("thiếu report.html/ảnh của flow: %v", keys(files))
	}
	if !strings.Contains(files["evidence.html"], "data:image/png;base64,") || !strings.Contains(files["evidence.html"], "01_login.yaml") {
		t.Fatal("evidence.html không nhúng ảnh hoặc thiếu flow")
	}
	var summary RunExport
	if err := json.Unmarshal([]byte(files["summary.json"]), &summary); err != nil || summary.Run.ID != sum.Run.ID || len(summary.Flows) != 1 {
		t.Fatalf("summary = %+v %v", summary, err)
	}
	if !strings.Contains(files["llm_calls.json"], "mật khẩu ***") || !strings.Contains(files["tool_calls.json"], "test_run") {
		t.Fatal("thiếu sổ LLM/tool trong khung giờ lượt")
	}

	// Dấu che hỏng: không xuất.
	if err := os.WriteFile(filepath.Join(sum.Run.OutDir, RedactionFailedMark), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := e.ExportRun(sum.Run.ID, dest+"2"); apperr.CodeOf(err) != CodeRedactionFailed {
		t.Fatalf("muốn redaction_failed: %v", err)
	}
}

// Gói chia sẻ nhóm: cùng bộ chọn tệp với zip, thêm video của flow; trace.zip không bao giờ vào gói, chữ đã che.
func TestRunBundleAddsVideoNeverTrace(t *testing.T) {
	e, _ := newTestEngine(t)
	sum := runAlways(t, e)
	f := sum.Flows[0]
	flowDir := flowOutDir(sum.Run.OutDir, f.DeviceID, f.Iteration, f.Flow)
	if err := os.MkdirAll(flowDir, 0o755); err != nil {
		t.Fatal(err)
	}
	for name, body := range map[string]string{"video.webm": "webm-bytes", traceFile: "trace " + secretPassword, "notes.txt": secretPassword} {
		if err := os.WriteFile(filepath.Join(flowDir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	collect := func(withVideo bool) map[string]string {
		out := map[string]string{}
		err := e.RunBundle(sum.Run.ID, withVideo, func(name string, body io.Reader, size int64, media bool) error {
			b, err := io.ReadAll(body)
			if err != nil {
				return err
			}
			if int64(len(b)) != size {
				t.Errorf("%s: size %d, đọc được %d", name, size, len(b))
			}
			if media != (strings.HasSuffix(name, ".png") || strings.HasSuffix(name, ".webm")) {
				t.Errorf("%s: media = %v", name, media)
			}
			out[name] = string(b)
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
		return out
	}
	files := collect(true)
	rel, _ := filepath.Rel(sum.Run.OutDir, flowDir)
	video := "reports/" + filepath.ToSlash(rel) + "/video.webm"
	if files[video] != "webm-bytes" {
		t.Fatalf("thiếu video %s: %v", video, keys(files))
	}
	for name, body := range files {
		if strings.HasSuffix(name, ".zip") || strings.HasSuffix(name, "notes.txt") || strings.Contains(body, secretPassword) {
			t.Errorf("%s không được vào gói", name)
		}
		if name == "llm_calls.json" || name == "tool_calls.json" {
			t.Errorf("%s chỉ có trong zip", name)
		}
	}
	for _, name := range []string{ReportSummaryFile, RunJournalFile, ReportHTMLFile} {
		if _, ok := files[name]; !ok {
			t.Errorf("thiếu %s", name)
		}
	}
	if _, ok := collect(false)[video]; ok {
		t.Fatal("withVideo = false vẫn có video")
	}
	dest := filepath.Join(t.TempDir(), "run.zip")
	if err := e.ExportRun(sum.Run.ID, dest); err != nil {
		t.Fatal(err)
	}
	if _, ok := readZip(t, dest)[video]; ok {
		t.Fatal("zip xuất không được đổi: không có video")
	}

	if e.RunShared(sum.Run.ID) {
		t.Fatal("chưa chia sẻ")
	}
	if err := e.MarkRunShared(sum.Run.ID); err != nil || !e.RunShared(sum.Run.ID) {
		t.Fatalf("MarkRunShared: %v", err)
	}
	if err := os.WriteFile(filepath.Join(sum.Run.OutDir, RedactionFailedMark), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	err := e.RunBundle(sum.Run.ID, true, func(string, io.Reader, int64, bool) error { return nil })
	if apperr.CodeOf(err) != CodeRedactionFailed {
		t.Fatalf("muốn redaction_failed: %v", err)
	}
	if err := e.RunBundle("bad", true, nil); apperr.CodeOf(err) != apperr.CodeInvalid {
		t.Fatalf("mã lượt sai: %v", err)
	}
}

func keys(m map[string]string) []string {
	var out []string
	for k := range m {
		out = append(out, k)
	}
	return out
}

func TestEvidenceHTMLEscapesText(t *testing.T) {
	h := evidenceHTML(RunRecord{ID: "r<1>", App: "<script>"}, []FlowRun{{Flow: `a"b.yaml`, Steps: []StepRun{
		{Desc: "<img src=x onerror=alert(1)>", Yaml: "tapOn: <b>", Error: "&", ShotAfter: "../../etc/x.png"}}}})
	if strings.Contains(h, "<script>") || strings.Contains(h, "<img src=x") || strings.Contains(h, "tapOn: <b>") {
		t.Fatalf("chưa thoát HTML: %s", h)
	}
	if strings.Contains(h, "data:image") {
		t.Fatal("đường dẫn ảnh ra ngoài lượt vẫn được nhúng")
	}
}

func TestExportHistoryAndInsights(t *testing.T) {
	e, _ := newTestEngine(t)
	now := time.Now()
	mk := func(id string, passed bool) {
		st := StepRun{Index: 1, Command: "tapOn", Desc: `tapOn: "Đăng nhập"`, Selector: "text=Đăng nhập", Passed: passed, DurationMs: 100}
		if !passed {
			st.ErrorType, st.Suggestion, st.Error = "element_not_found", "đổi selector", "không thấy"
		}
		r := RunRecord{ID: id, App: "demo", StartedAt: now, FinishedAt: now, OutDir: filepath.Join(e.RunsDir, id)}
		if err := e.Metrics.Save(r, []FlowRun{{DeviceID: "emu-1", Flow: "01.yaml", Passed: passed, Steps: []StepRun{st,
			{Index: 2, Command: "assertVisible", Desc: "assertVisible: Trang chủ", Passed: true, DurationMs: 900}}}}); err != nil {
			t.Fatal(err)
		}
	}
	mk("261118-100000", true)
	mk("261118-100001", false)
	mk("261118-100002", false)
	_ = e.Metrics.RecordLLM(LedgerEntry{At: now, App: "demo", Flow: "01.yaml", Purpose: "repair", CostVnd: 10, BudgetLeftVnd: -1})
	_ = e.Metrics.RecordUsage(now, "app_start", map[string]any{"version": "1"}, nil)

	ins, err := e.Metrics.Insights(MetricsQuery{App: "demo"})
	if err != nil {
		t.Fatal(err)
	}
	if len(ins.FailingSteps) != 1 || ins.FailingSteps[0].Step != "tapOn text=Đăng nhập" || ins.FailingSteps[0].Failed != 2 ||
		ins.FailingSteps[0].TopErrorType != "element_not_found" || ins.FailingSteps[0].LastSuggestion != "đổi selector" {
		t.Fatalf("failing = %+v", ins.FailingSteps)
	}
	if len(ins.FlakySteps) != 1 || ins.FlakySteps[0].Runs != 3 || ins.FlakySteps[0].FailedRuns != 2 {
		t.Fatalf("flaky = %+v", ins.FlakySteps)
	}
	if len(ins.SlowSteps) != 2 || ins.SlowSteps[0].P95Ms != 900 {
		t.Fatalf("slow = %+v", ins.SlowSteps)
	}
	if len(ins.RepairFlows) != 1 || ins.RepairFlows[0].Calls != 1 || ins.RepairFlows[0].Flow != "01.yaml" {
		t.Fatalf("repair = %+v", ins.RepairFlows)
	}

	dest := filepath.Join(t.TempDir(), "h.json")
	if err := e.ExportHistory(0, dest); apperr.CodeOf(err) != apperr.CodeInvalid {
		t.Fatalf("days 0: %v", err)
	}
	if err := e.ExportHistory(7, dest); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(dest)
	var h HistoryExport
	if err := json.Unmarshal(raw, &h); err != nil {
		t.Fatal(err)
	}
	if len(h.Runs) != 3 || len(h.FlowRuns) != 3 || len(h.FlowRuns[0].Steps) != 2 || len(h.LLMCalls) != 1 || len(h.UsageEvents) != 1 {
		t.Fatalf("history = runs %d flows %d llm %d usage %d", len(h.Runs), len(h.FlowRuns), len(h.LLMCalls), len(h.UsageEvents))
	}
}

func TestRunEndWritesLocalReport(t *testing.T) {
	e, _ := newTestEngine(t)
	sum := runAlways(t, e)
	page, err := os.ReadFile(filepath.Join(sum.Run.OutDir, ReportHTMLFile))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(page), "data:image/png;base64,") || !strings.Contains(string(page), sum.Run.ID) {
		t.Fatal("evidence.html trong thư mục lượt thiếu ảnh hoặc mã lượt")
	}
	raw, err := os.ReadFile(filepath.Join(sum.Run.OutDir, ReportSummaryFile))
	if err != nil {
		t.Fatal(err)
	}
	var got RunExport
	if err := json.Unmarshal(raw, &got); err != nil || got.Run.ID != sum.Run.ID || len(got.Flows) != 1 || got.Run.Passed+got.Run.Failed != 1 {
		t.Fatalf("summary.json = %+v %v", got.Run, err)
	}
	for name, body := range map[string][]byte{ReportHTMLFile: page, ReportSummaryFile: raw} {
		if strings.Contains(string(body), secretPassword) {
			t.Fatalf("%s lộ mật khẩu", name)
		}
	}
	// Mở báo cáo dùng lại file đã ghi lúc chạy xong, không sinh lại.
	p, err := e.RunReport(sum.Run.ID)
	if err != nil || filepath.Base(p) != ReportHTMLFile {
		t.Fatalf("RunReport = %q %v", p, err)
	}
}

func TestLocalReportRefusedAfterRedactionFailure(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, RedactionFailedMark), []byte("x"), 0o644)
	err := writeRunReport(RunRecord{ID: "261118-090000", OutDir: dir}, nil, nil)
	if apperr.CodeOf(err) != CodeRedactionFailed {
		t.Fatalf("lỗi = %v", err)
	}
	for _, f := range []string{ReportHTMLFile, ReportSummaryFile} {
		if _, err := os.Stat(filepath.Join(dir, f)); !os.IsNotExist(err) {
			t.Fatalf("%s vẫn được ghi", f)
		}
	}
}

// Tệp ẩn dưới assets (vd .DS_Store của Finder) không vào gói chia sẻ nhóm, vì khoá evidence không nhận đoạn bắt đầu bằng
// dấu chấm; ảnh thường vẫn vào.
func TestRunBundleSkipsHiddenFiles(t *testing.T) {
	e, _ := newTestEngine(t)
	sum := runAlways(t, e)
	f := sum.Flows[0]
	assets := filepath.Join(flowOutDir(sum.Run.OutDir, f.DeviceID, f.Iteration, f.Flow), "assets")
	for rel, body := range map[string]string{".DS_Store": "finder", ".cache/a.png": "png", "shot.png": "png"} {
		p := filepath.Join(assets, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	var names []string
	err := e.RunBundle(sum.Run.ID, false, func(name string, _ io.Reader, _ int64, _ bool) error {
		names = append(names, name)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	sawShot := false
	for _, n := range names {
		if hiddenPath(n) {
			t.Errorf("tệp ẩn %s không được vào gói", n)
		}
		sawShot = sawShot || strings.HasSuffix(n, "/assets/shot.png")
	}
	if !sawShot {
		t.Fatalf("thiếu ảnh assets/shot.png: %v", names)
	}
}
