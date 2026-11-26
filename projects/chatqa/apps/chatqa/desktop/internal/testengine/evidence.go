package testengine

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/devicelab-dev/maestro-runner/pkg/executor"
	"github.com/devicelab-dev/maestro-runner/pkg/report"

	"deskcore/apperr"
)

// Evidence theo bước: sau mỗi flow, đọc flows/<id>.json runner ghi trong thư mục flow để bổ sung YAML, selector,
// phần tử, loại lỗi, gợi ý, ảnh trước/sau và cây UI vào bước đã nhận qua callback. Cùng lượt chạy, mọi Event được ghi
// thành một dòng JSON trong <OutDir>/run.jsonl.

// Mức ảnh theo bước của một lượt.
const (
	ArtifactsAlways    = "always"
	ArtifactsOnFailure = "on-failure"
	ArtifactsNever     = "never"
)

// RunJournalFile: nhật ký sự kiện của lượt chạy trong OutDir.
const RunJournalFile = "run.jsonl"

// ValidateArtifacts: "" (= on-failure) | always | on-failure | never.
func ValidateArtifacts(mode string) error {
	switch mode {
	case "", ArtifactsAlways, ArtifactsOnFailure, ArtifactsNever:
		return nil
	}
	return apperr.New(apperr.CodeInvalid, "artifacts chỉ nhận always, on-failure hoặc never")
}

// artifactMode: mức ảnh đã chuẩn hoá ("" = on-failure, như trước đây) và giá trị tương ứng của runner.
func artifactMode(mode string) (string, executor.ArtifactMode) {
	switch mode {
	case ArtifactsAlways:
		return mode, executor.ArtifactAlways
	case ArtifactsNever:
		return mode, executor.ArtifactNever
	}
	return ArtifactsOnFailure, executor.ArtifactOnFailure
}

// Độ dài tối đa của mô tả phần tử và YAML một bước trong DB.
const (
	elementMax = 240
	yamlMax    = 8 << 10
)

// loadFlowDetail đọc flows/*.json trong thư mục flow (một flow mỗi lần chạy; nhiều file thì lấy file mới nhất).
func loadFlowDetail(flowDir string) (*report.FlowDetail, error) {
	files, err := filepath.Glob(filepath.Join(flowDir, "flows", "*.json"))
	if err != nil || len(files) == 0 {
		return nil, err
	}
	pick, newest := "", int64(-1)
	for _, f := range files {
		if st, err := os.Stat(f); err == nil && st.ModTime().UnixNano() > newest {
			pick, newest = f, st.ModTime().UnixNano()
		}
	}
	if pick == "" {
		return nil, nil
	}
	raw, err := os.ReadFile(pick)
	if err != nil {
		return nil, err
	}
	var fd report.FlowDetail
	if err := json.Unmarshal(raw, &fd); err != nil {
		return nil, err
	}
	return &fd, nil
}

// enrichSteps bổ sung evidence vào steps từ báo cáo của runner. Bước cấp đầu ghép theo Index; bước lồng (Index -1)
// ghép theo thứ tự callback của runner (duyệt sâu, con trước cha) và phải khớp cả số lượng lẫn độ sâu, lệch thì giữ
// nguyên bước gốc. Đường dẫn ảnh đổi sang tương đối với outDir của lượt. Chữ được che bằng secrets.
func enrichSteps(steps []StepRun, fd *report.FlowDetail, flowDir, outDir string, secrets []string) {
	if fd == nil {
		return
	}
	rel := func(p string) string {
		if p == "" {
			return ""
		}
		abs := p
		if !filepath.IsAbs(p) {
			abs = filepath.Join(flowDir, p)
		}
		r, err := filepath.Rel(outDir, abs)
		if err != nil || r == ".." || strings.HasPrefix(r, ".."+string(filepath.Separator)) {
			return ""
		}
		return filepath.ToSlash(r)
	}
	apply := func(s *StepRun, c *report.Command) {
		s.Label = redact(c.Label, secrets)
		s.Yaml = capText(redact(c.YAML, secrets), yamlMax)
		if c.Params != nil && c.Params.Selector != nil && c.Params.Selector.Value != "" {
			s.Selector = redact(c.Params.Selector.Type+"="+c.Params.Selector.Value, secrets)
		}
		if c.Element != nil && c.Element.Found {
			s.Element = capText(redact(describeElement(c.Element), secrets), elementMax)
		}
		if c.Error != nil {
			s.ErrorType = c.Error.Type
			s.Suggestion = redact(c.Error.Suggestion, secrets)
		}
		s.ShotBefore = rel(c.Artifacts.ScreenshotBefore)
		s.ShotAfter = rel(c.Artifacts.ScreenshotAfter)
		s.Hierarchy = rel(c.Artifacts.ViewHierarchy)
		if c.StartTime != nil {
			s.StartedAt = *c.StartTime
		}
	}

	byIndex := map[int]*report.Command{}
	for i := range fd.Commands {
		byIndex[fd.Commands[i].Index] = &fd.Commands[i]
	}
	type nestedCmd struct {
		cmd   *report.Command
		depth int
	}
	var nested []nestedCmd
	var walk func(cmds []report.Command, depth int)
	walk = func(cmds []report.Command, depth int) {
		for i := range cmds {
			walk(cmds[i].SubCommands, depth+1)
			nested = append(nested, nestedCmd{&cmds[i], depth})
		}
	}
	for i := range fd.Commands {
		walk(fd.Commands[i].SubCommands, 1)
	}

	var nestedSteps []*StepRun
	for i := range steps {
		s := &steps[i]
		if s.Depth == 0 && s.Index >= 0 {
			if c, ok := byIndex[s.Index]; ok {
				apply(s, c)
			}
			continue
		}
		nestedSteps = append(nestedSteps, s)
	}
	if len(nestedSteps) != len(nested) {
		return
	}
	for i, s := range nestedSteps {
		if s.Depth != nested[i].depth {
			return
		}
	}
	for i, s := range nestedSteps {
		apply(s, nested[i].cmd)
	}
}

// describeElement: chữ/id rút gọn và khung của phần tử, vd `text="Đăng nhập" id=btn_login [10,20 300x48]`.
func describeElement(e *report.Element) string {
	var parts []string
	if e.Text != "" {
		parts = append(parts, fmt.Sprintf("text=%q", capText(e.Text, 80)))
	}
	if e.ID != "" {
		parts = append(parts, "id="+capText(e.ID, 80))
	}
	if len(parts) == 0 && e.Class != "" {
		parts = append(parts, "class="+e.Class)
	}
	if b := e.Bounds; b != nil {
		parts = append(parts, fmt.Sprintf("[%d,%d %dx%d]", b.X, b.Y, b.Width, b.Height))
	}
	return strings.Join(parts, " ")
}

// runJournal: run.jsonl của một lượt, ghi được từ nhiều goroutine (mỗi thiết bị một goroutine).
type runJournal struct {
	mu      sync.Mutex
	f       *os.File
	secrets []string
}

func openRunJournal(outDir string, secrets []string) (*runJournal, error) {
	f, err := os.OpenFile(filepath.Join(outDir, RunJournalFile), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return nil, err
	}
	return &runJournal{f: f, secrets: secrets}, nil
}

func (j *runJournal) write(ev Event) {
	raw, err := json.Marshal(ev)
	if err != nil {
		return
	}
	line := redact(string(raw), j.secrets) + "\n"
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.f != nil {
		_, _ = j.f.WriteString(line)
	}
}

func (j *runJournal) close() error {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.f == nil {
		return nil
	}
	err := j.f.Close()
	j.f = nil
	return err
}
