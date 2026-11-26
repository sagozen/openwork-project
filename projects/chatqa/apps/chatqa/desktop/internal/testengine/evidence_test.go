package testengine

import (
	"bufio"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/devicelab-dev/maestro-runner/pkg/report"

	"deskcore/apperr"
)

// flowFixture: flows/<id>.json như runner ghi: bước 1 có selector, phần tử, ảnh; bước 2 là runFlow có bước lồng
// (một bước con và một repeat chứa một bước cháu); bước 3 lỗi với gợi ý chứa bí mật.
func flowFixture(t *testing.T, flowDir string) {
	t.Helper()
	at := time.Date(2026, 11, 18, 9, 0, 0, 0, time.UTC)
	cmds := []report.Command{
		{ID: "cmd-0", Index: 0, Type: "launchApp", YAML: "launchApp", Status: report.StatusPassed, StartTime: &at},
		{ID: "cmd-1", Index: 1, Type: "tapOn", Label: "Bấm đăng nhập", YAML: `tapOn: "Đăng nhập"`, Status: report.StatusPassed,
			Params:    &report.CommandParams{Selector: &report.Selector{Type: "text", Value: "Đăng nhập"}},
			Element:   &report.Element{Found: true, ID: "btn_login", Text: "Đăng nhập", Bounds: &report.Bounds{X: 10, Y: 20, Width: 300, Height: 48}},
			Artifacts: report.CommandArtifacts{ScreenshotBefore: "assets/f1/cmd-001-before.png", ScreenshotAfter: "assets/f1/cmd-001-after.png"}},
		{ID: "cmd-2", Index: 2, Type: "runFlow", YAML: "runFlow: sub.yaml", Status: report.StatusPassed,
			SubCommands: []report.Command{
				{ID: "sub-0", Type: "tapOn", YAML: "tapOn: A", Status: report.StatusPassed},
				{ID: "sub-1", Type: "repeat", YAML: "repeat", Status: report.StatusPassed, SubCommands: []report.Command{
					{ID: "sub-0", Type: "inputText", YAML: "inputText: " + secretPassword, Status: report.StatusPassed},
				}},
			}},
		{ID: "cmd-3", Index: 3, Type: "assertVisible", YAML: `assertVisible: "Trang chủ"`, Status: report.StatusFailed,
			Error:     &report.Error{Type: "element_not_found", Message: "không thấy", Suggestion: "kiểm tra mật khẩu " + secretPassword},
			Artifacts: report.CommandArtifacts{ScreenshotAfter: "assets/f1/cmd-003-after.png", ViewHierarchy: "assets/f1/cmd-003-hierarchy.xml"}},
	}
	raw, err := json.Marshal(report.FlowDetail{ID: "f1", Name: "login", Commands: cmds})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(flowDir, "flows"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(flowDir, "flows", "f1.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}
}

// callbackSteps: thứ tự callback của runner: bước lồng (con trước cha) rồi mới tới bước cấp đầu chứa chúng.
func callbackSteps() []StepRun {
	return []StepRun{
		{Index: 0, Desc: "launchApp", Passed: true},
		{Index: 1, Desc: `tapOn: "Đăng nhập"`, Passed: true},
		{Index: -1, Depth: 1, Desc: "tapOn: A", Passed: true},
		{Index: -1, Depth: 2, Desc: "inputText: ***", Passed: true},
		{Index: -1, Depth: 1, Desc: "repeat", Passed: true},
		{Index: 2, Desc: "runFlow", Passed: true},
		{Index: 3, Desc: "assertVisible", Error: "không thấy"},
	}
}

func TestEnrichStepsFromRunnerReport(t *testing.T) {
	outDir := t.TempDir()
	flowDir := filepath.Join(outDir, "emu-1", "r01", "01_login")
	flowFixture(t, flowDir)
	fd, err := loadFlowDetail(flowDir)
	if err != nil || fd == nil {
		t.Fatalf("loadFlowDetail: %v %v", fd, err)
	}
	steps := callbackSteps()
	enrichSteps(steps, fd, flowDir, outDir, []string{secretPassword})

	s1 := steps[1]
	if s1.Selector != "text=Đăng nhập" || s1.Label != "Bấm đăng nhập" || s1.Yaml != `tapOn: "Đăng nhập"` {
		t.Fatalf("bước 1 = %+v", s1)
	}
	if s1.Element != `text="Đăng nhập" id=btn_login [10,20 300x48]` {
		t.Fatalf("element = %q", s1.Element)
	}
	if s1.ShotBefore != "emu-1/r01/01_login/assets/f1/cmd-001-before.png" || s1.ShotAfter != "emu-1/r01/01_login/assets/f1/cmd-001-after.png" {
		t.Fatalf("ảnh = %q %q", s1.ShotBefore, s1.ShotAfter)
	}
	if !steps[0].StartedAt.Equal(time.Date(2026, 11, 18, 9, 0, 0, 0, time.UTC)) {
		t.Fatalf("startedAt = %v", steps[0].StartedAt)
	}
	s3 := steps[6]
	if s3.ErrorType != "element_not_found" || s3.Hierarchy != "emu-1/r01/01_login/assets/f1/cmd-003-hierarchy.xml" {
		t.Fatalf("bước lỗi = %+v", s3)
	}
	if strings.Contains(s3.Suggestion, secretPassword) || !strings.Contains(s3.Suggestion, "***") {
		t.Fatalf("gợi ý chưa che: %q", s3.Suggestion)
	}
	// Bước lồng ghép theo thứ tự duyệt sâu (con trước cha).
	if steps[2].Yaml != "tapOn: A" || steps[4].Yaml != "repeat" || steps[3].Yaml != "inputText: ***" {
		t.Fatalf("bước lồng = %q %q %q", steps[2].Yaml, steps[3].Yaml, steps[4].Yaml)
	}
}

func TestEnrichStepsKeepsNestedStepsOnMismatch(t *testing.T) {
	outDir := t.TempDir()
	flowFixture(t, outDir)
	fd, _ := loadFlowDetail(outDir)
	steps := callbackSteps()
	steps = append(steps[:3], steps[4:]...) // thiếu một bước lồng: số lượng lệch
	enrichSteps(steps, fd, outDir, outDir, nil)
	for _, s := range steps {
		if s.Index < 0 && s.Yaml != "" {
			t.Fatalf("bước lồng lệch vẫn bị ghép: %+v", s)
		}
	}
	if steps[1].Selector == "" {
		t.Fatal("bước cấp đầu vẫn phải ghép theo index")
	}

	steps = callbackSteps()
	steps[2].Depth = 2 // độ sâu lệch
	enrichSteps(steps, fd, outDir, outDir, nil)
	if steps[2].Yaml != "" || steps[4].Yaml != "" {
		t.Fatal("độ sâu lệch vẫn bị ghép")
	}
}

func TestArtifactsValidation(t *testing.T) {
	for _, ok := range []string{"", "always", "on-failure", "never"} {
		if err := ValidateArtifacts(ok); err != nil {
			t.Errorf("%q: %v", ok, err)
		}
	}
	if err := ValidateArtifacts("sometimes"); apperr.CodeOf(err) != apperr.CodeInvalid {
		t.Fatalf("sometimes: %v", err)
	}
	if mode, _ := artifactMode(""); mode != ArtifactsOnFailure {
		t.Fatalf("mặc định = %q", mode)
	}
	e, f := newTestEngine(t)
	req := RunRequest{App: "demo", Devices: twoDevices[:1], Artifacts: "sometimes"}
	if _, err := e.Run(context.Background(), req); apperr.CodeOf(err) != apperr.CodeInvalid {
		t.Fatalf("Run: %v", err)
	}
	if err := e.CheckRun(req); apperr.CodeOf(err) != apperr.CodeInvalid {
		t.Fatalf("CheckRun: %v", err)
	}
	if c, _ := f.counts("emu-1"); c != 0 {
		t.Fatal("artifacts sai vẫn chạm thiết bị")
	}
}

func readJournal(t *testing.T, outDir string) []Event {
	t.Helper()
	fh, err := os.Open(filepath.Join(outDir, RunJournalFile))
	if err != nil {
		t.Fatal(err)
	}
	defer fh.Close()
	var out []Event
	sc := bufio.NewScanner(fh)
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	for sc.Scan() {
		if strings.Contains(sc.Text(), secretPassword) {
			t.Fatalf("run.jsonl lộ mật khẩu: %s", sc.Text())
		}
		var ev Event
		if err := json.Unmarshal(sc.Bytes(), &ev); err != nil {
			t.Fatalf("dòng hỏng %q: %v", sc.Text(), err)
		}
		out = append(out, ev)
	}
	return out
}

func TestRunAlwaysRecordsStepShotsAndJournal(t *testing.T) {
	e, _ := newTestEngine(t)
	sum, err := e.Run(context.Background(), RunRequest{App: "demo", Devices: twoDevices[:1], Secrets: []string{"PASSWORD"},
		Artifacts: ArtifactsAlways})
	if err != nil {
		t.Fatal(err)
	}
	if sum.Run.Artifacts != ArtifactsAlways || len(sum.Flows) != 1 {
		t.Fatalf("run = %+v", sum.Run)
	}
	flows, err := e.Metrics.FlowRuns(sum.Run.ID)
	if err != nil || len(flows) != 1 {
		t.Fatalf("FlowRuns: %v %v", flows, err)
	}
	top := 0
	for _, s := range flows[0].Steps {
		if s.Depth != 0 {
			continue
		}
		top++
		for _, rel := range []string{s.ShotBefore, s.ShotAfter} {
			if rel == "" {
				t.Fatalf("bước %d thiếu ảnh: %+v", s.Index, s)
			}
			if _, err := os.Stat(filepath.Join(sum.Run.OutDir, filepath.FromSlash(rel))); err != nil {
				t.Fatalf("ảnh %s: %v", rel, err)
			}
		}
		if s.Yaml == "" || s.StartedAt.IsZero() {
			t.Fatalf("bước %d thiếu YAML/giờ: %+v", s.Index, s)
		}
		if strings.Contains(s.Yaml, secretPassword) {
			t.Fatalf("YAML lộ mật khẩu: %q", s.Yaml)
		}
	}
	if top == 0 {
		t.Fatal("không có bước cấp đầu")
	}
	if run, _ := e.Metrics.Run(sum.Run.ID); run.Artifacts != ArtifactsAlways {
		t.Fatalf("artifacts đọc lại = %q", run.Artifacts)
	}

	evs := readJournal(t, sum.Run.OutDir)
	var kinds []string
	for i, ev := range evs {
		if ev.At.IsZero() || ev.RunID != sum.Run.ID {
			t.Fatalf("dòng %d thiếu at/runId: %+v", i, ev)
		}
		if i > 0 && ev.At.Before(evs[i-1].At) {
			t.Fatalf("dòng %d lùi giờ", i)
		}
		if len(kinds) == 0 || kinds[len(kinds)-1] != ev.Kind {
			kinds = append(kinds, ev.Kind)
		}
	}
	if got := strings.Join(kinds, ","); got != "run_start,flow_start,step,flow_end,run_end" {
		t.Fatalf("thứ tự sự kiện = %s", got)
	}
}

func TestRunNeverRecordsNoShots(t *testing.T) {
	e, _ := newTestEngine(t)
	sum, err := e.Run(context.Background(), RunRequest{App: "demo", Devices: twoDevices[:1], Artifacts: ArtifactsNever})
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range sum.Flows[0].Steps {
		if s.ShotBefore != "" || s.ShotAfter != "" {
			t.Fatalf("never vẫn có ảnh: %+v", s)
		}
	}
}
