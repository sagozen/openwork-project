package testengine

import (
	"archive/zip"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"deskcore/apperr"
)

// Xuất dữ liệu cục bộ: gói một lượt chạy (zip có evidence.html tự chứa) và dữ liệu phân tích nhiều ngày (JSON).
// Mọi chữ trong gói đi qua lớp che bí mật lần cuối với giá trị hiện có trong kho; chỉ ghi ra máy, không gửi đi đâu.

// CodeRedactionFailed: lượt có dấu che bí mật hỏng giữa chừng, không được xuất.
const CodeRedactionFailed = "redaction_failed"

// RunExport: summary.json trong gói xuất một lượt.
type RunExport struct {
	Run   RunRecord `json:"run"`
	Flows []FlowRun `json:"flows"`
}

// Báo cáo cục bộ trong thư mục lượt (ghi khi lượt chạy xong, cùng nội dung với file cùng tên trong gói zip).
const (
	ReportHTMLFile    = "evidence.html"
	ReportSummaryFile = "summary.json"
)

// reportFiles: summary.json và evidence.html của một lượt, đã che bí mật. Dùng chung cho thư mục lượt và gói zip.
func reportFiles(run RunRecord, flows []FlowRun, secrets []string) (summary, page []byte, err error) {
	if flows == nil {
		flows = []FlowRun{}
	}
	raw, err := json.MarshalIndent(RunExport{Run: run, Flows: flows}, "", "  ")
	if err != nil {
		return nil, nil, err
	}
	return []byte(redact(string(raw), secrets)), []byte(redact(evidenceHTML(run, flows), secrets)), nil
}

// redactionFailed: lỗi redaction_failed khi thư mục lượt mang dấu che bí mật hỏng (tệp có thể còn giá trị bí mật);
// action là việc bị từ chối.
func redactionFailed(run RunRecord, action string) error {
	if _, err := os.Stat(filepath.Join(run.OutDir, RedactionFailedMark)); err == nil {
		return apperr.New(CodeRedactionFailed, "lượt "+run.ID+" che giá trị bí mật chưa xong, "+action)
	}
	return nil
}

// writeRunReport ghi summary.json và evidence.html vào run.OutDir. Lượt có dấu che bí mật hỏng thì từ chối.
func writeRunReport(run RunRecord, flows []FlowRun, secrets []string) error {
	if err := redactionFailed(run, "không ghi báo cáo"); err != nil {
		return err
	}
	summary, page, err := reportFiles(run, flows, secrets)
	if err != nil {
		return err
	}
	if err := writeAtomic(filepath.Join(run.OutDir, ReportSummaryFile), summary, 0o644); err != nil {
		return err
	}
	return writeAtomic(filepath.Join(run.OutDir, ReportHTMLFile), page, 0o644)
}

// RunDir: thư mục của lượt runID (đã kiểm nằm trong RunsDir, kể cả qua liên kết tượng trưng).
func (e *Engine) RunDir(runID string) (string, error) {
	if e.Metrics == nil {
		return "", apperr.New("test_engine_unavailable", "")
	}
	if !ValidRunID(runID) {
		return "", apperr.New(apperr.CodeInvalid, "mã lượt chạy")
	}
	run, err := e.Metrics.Run(runID)
	if err != nil {
		return "", err
	}
	dir, err := insideDir(e.RunsDir, run.OutDir)
	if err != nil {
		return "", err
	}
	if st, err := os.Stat(dir); err != nil || !st.IsDir() {
		return "", apperr.New(apperr.CodeNotFound, "thư mục lượt chạy "+runID)
	}
	return dir, nil
}

// RunReport: đường dẫn evidence.html của lượt; chưa có (lượt cũ, file bị xoá) thì sinh lại từ DB.
func (e *Engine) RunReport(runID string) (string, error) {
	dir, err := e.RunDir(runID)
	if err != nil {
		return "", err
	}
	p := filepath.Join(dir, ReportHTMLFile)
	if st, err := os.Lstat(p); err == nil && st.Mode().IsRegular() {
		return p, nil
	}
	run, err := e.Metrics.Run(runID)
	if err != nil {
		return "", err
	}
	flows, err := e.Metrics.FlowRuns(runID)
	if err != nil {
		return "", err
	}
	run.OutDir = dir
	e.AttachTraces(run, flows)
	if err := writeRunReport(run, flows, e.SecretValues()); err != nil {
		return "", err
	}
	return p, nil
}

// ExportedFile: đường dẫn tuyệt đối của file p nằm trong ExportsDir (file thường); khác thì từ chối.
func (e *Engine) ExportedFile(p string) (string, error) {
	if strings.TrimSpace(p) == "" || strings.ContainsRune(p, 0) || !filepath.IsAbs(p) {
		return "", apperr.New(apperr.CodeInvalid, "đường dẫn file xuất")
	}
	full, err := insideDir(e.ExportsDir, p)
	if err != nil {
		return "", err
	}
	if st, err := os.Stat(full); err != nil || !st.Mode().IsRegular() {
		return "", apperr.New(apperr.CodeNotFound, "file xuất "+filepath.Base(p))
	}
	return full, nil
}

// insideDir: p (sau khi giải liên kết tượng trưng) nằm hẳn bên trong root (không phải chính root).
func insideDir(root, p string) (string, error) {
	bad := apperr.New(apperr.CodeInvalid, "đường dẫn nằm ngoài thư mục cho phép")
	if root == "" || p == "" {
		return "", bad
	}
	r, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", apperr.New(apperr.CodeNotFound, "thư mục "+filepath.Base(root))
	}
	full, err := filepath.EvalSymlinks(p)
	if err != nil {
		return "", apperr.New(apperr.CodeNotFound, filepath.Base(p))
	}
	rel, err := filepath.Rel(r, full)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return "", bad
	}
	return full, nil
}

// HistoryExport: dữ liệu phân tích days ngày gần nhất.
type HistoryExport struct {
	ExportedAt  time.Time     `json:"exportedAt"`
	Since       time.Time     `json:"since"`
	Runs        []RunRecord   `json:"runs"`
	FlowRuns    []FlowRun     `json:"flowRuns"` // kèm bước (steps)
	LLMCalls    []LedgerEntry `json:"llmCalls"` // kèm request/response đã che
	ToolCalls   []ToolCall    `json:"toolCalls"`
	UsageEvents []UsageEvent  `json:"usageEvents"`
}

// ExportRun ghi gói zip của một lượt vào destZip: summary.json, run.jsonl, evidence.html (ảnh nhúng base64),
// report.html và assets của từng flow (runBundle, không video), llm_calls.json và tool_calls.json trong khung giờ của
// lượt.
func (e *Engine) ExportRun(runID, destZip string) error {
	if e.Metrics == nil {
		return apperr.New("test_engine_unavailable", "")
	}
	run, err := e.Metrics.Run(runID)
	if err != nil {
		return err
	}
	if err := redactionFailed(run, "không xuất"); err != nil {
		return err
	}
	flows, err := e.Metrics.FlowRuns(runID)
	if err != nil {
		return err
	}
	llm, err := e.Metrics.llmCallsBetween(run.StartedAt, run.FinishedAt)
	if err != nil {
		return err
	}
	toolCalls, err := e.Metrics.toolCallsBetween(run.StartedAt, run.FinishedAt)
	if err != nil {
		return err
	}
	secrets := e.SecretValues()

	if err := os.MkdirAll(filepath.Dir(destZip), 0o755); err != nil {
		return err
	}
	tmp := destZip + ".part"
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	zw := zip.NewWriter(f)
	werr := func() error {
		add := func(name string, body io.Reader) error {
			w, err := zw.Create(name)
			if err != nil {
				return err
			}
			_, err = io.Copy(w, body)
			return err
		}
		addJSON := func(name string, v any) error {
			raw, err := json.MarshalIndent(v, "", "  ")
			if err != nil {
				return err
			}
			return add(name, strings.NewReader(redact(string(raw), secrets)))
		}
		return runBundle(run, flows, secrets, false, func(name string, body io.Reader, _ int64, _ bool) error {
			if err := add(name, body); err != nil {
				return err
			}
			if name != ReportHTMLFile {
				return nil
			}
			// Sổ LLM/tool chỉ có trong gói zip, đứng ngay sau evidence.html như trước.
			if err := addJSON("llm_calls.json", llm); err != nil {
				return err
			}
			return addJSON("tool_calls.json", toolCalls)
		})
	}()
	cerr := zw.Close()
	ferr := f.Close()
	if err := errors.Join(werr, cerr, ferr); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, destZip)
}

// BundleYield nhận lần lượt từng tệp của gói lượt: name là đường dẫn "/" trong gói, body đọc được đúng size byte (chỉ
// dùng trong lần gọi), media = ảnh/video giữ nguyên byte (chữ đã qua lớp che).
type BundleYield func(name string, body io.Reader, size int64, media bool) error

// videoExt: video của flow (web: <thư mục flow>/video.<đuôi>; mobile: .mp4 trong thư mục flow), không nằm dưới assets/.
var videoExt = map[string]bool{".mp4": true, ".mov": true, ".webm": true}

// runBundle: bộ chọn tệp chung của gói một lượt (zip xuất và chia sẻ nhóm): summary.json, run.jsonl (nếu có),
// evidence.html, rồi reports/<đường dẫn> gồm report.html và mọi tệp dưới assets của từng flow; withVideo thêm video của
// flow. Chữ đi qua lớp che, ảnh/video giữ byte. File nhị phân (trace.zip của flow web) không bao giờ vào gói.
func runBundle(run RunRecord, flows []FlowRun, secrets []string, withVideo bool, yield BundleYield) error {
	text := func(name string, b []byte) error { return yield(name, bytes.NewReader(b), int64(len(b)), false) }
	summary, page, err := reportFiles(run, flows, secrets)
	if err != nil {
		return err
	}
	if err := text(ReportSummaryFile, summary); err != nil {
		return err
	}
	if raw, err := os.ReadFile(filepath.Join(run.OutDir, RunJournalFile)); err == nil {
		if err := text(RunJournalFile, []byte(redact(string(raw), secrets))); err != nil {
			return err
		}
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	if err := text(ReportHTMLFile, page); err != nil {
		return err
	}
	return filepath.WalkDir(run.OutDir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		ext := strings.ToLower(filepath.Ext(p))
		if d.IsDir() || d.Type()&fs.ModeSymlink != 0 || binaryExt[ext] {
			return nil
		}
		rel, err := filepath.Rel(run.OutDir, p)
		if err != nil {
			return err
		}
		slash := filepath.ToSlash(rel)
		inAssets := strings.HasPrefix(slash, "assets/") || strings.Contains(slash, "/assets/")
		if d.Name() != "report.html" && !inAssets && !(withVideo && videoExt[ext]) {
			return nil
		}
		name := "reports/" + slash
		if !mediaExt[ext] {
			raw, err := os.ReadFile(p)
			if err != nil {
				return err
			}
			return text(name, []byte(redact(string(raw), secrets)))
		}
		f, err := os.Open(p)
		if err != nil {
			return err
		}
		defer f.Close()
		st, err := f.Stat()
		if err != nil {
			return err
		}
		return yield(name, io.LimitReader(f, st.Size()), st.Size(), true)
	})
}

// SharedMark: tệp trong thư mục lượt khi evidence của lượt đã được chia sẻ cho nhóm (nội dung: giờ chia sẻ RFC 3339).
const SharedMark = ".shared"

// RunBundle phát gói evidence của lượt runID qua yield (như ExportRun nhưng không có sổ LLM/tool; withVideo thêm video
// của flow), dùng để chia sẻ evidence cho nhóm. Từ chối lượt đang chạy (busy) và lượt có dấu che bí mật hỏng
// (redaction_failed). Trace không bao giờ có trong gói.
func (e *Engine) RunBundle(runID string, withVideo bool, yield BundleYield) error {
	if _, err := e.RunDir(runID); err != nil {
		return err
	}
	e.mu.Lock()
	_, running := e.active[runID]
	e.mu.Unlock()
	if running {
		return apperr.New("busy", "lượt "+runID+" đang chạy")
	}
	run, err := e.Metrics.Run(runID)
	if err != nil {
		return err
	}
	if err := redactionFailed(run, "không chia sẻ"); err != nil {
		return err
	}
	flows, err := e.Metrics.FlowRuns(runID)
	if err != nil {
		return err
	}
	// Tệp/thư mục ẩn (vd .DS_Store dưới assets) không lên kho nhóm: khoá evidence không nhận đoạn bắt đầu bằng dấu chấm.
	return runBundle(run, flows, e.SecretValues(), withVideo, func(name string, body io.Reader, size int64, media bool) error {
		if hiddenPath(name) {
			return nil
		}
		return yield(name, body, size, media)
	})
}

// hiddenPath: đường dẫn "/" có đoạn bắt đầu bằng dấu chấm.
func hiddenPath(name string) bool {
	for seg := range strings.SplitSeq(name, "/") {
		if strings.HasPrefix(seg, ".") {
			return true
		}
	}
	return false
}

// MarkRunShared ghi dấu SharedMark vào thư mục lượt sau khi evidence đã lên kho nhóm.
func (e *Engine) MarkRunShared(runID string) error {
	dir, err := e.RunDir(runID)
	if err != nil {
		return err
	}
	return writeAtomic(filepath.Join(dir, SharedMark), []byte(e.clock().UTC().Format(time.RFC3339)), 0o644)
}

// RunShared: lượt đã được chia sẻ cho nhóm (có dấu SharedMark).
func (e *Engine) RunShared(runID string) bool {
	dir, err := e.RunDir(runID)
	if err != nil {
		return false
	}
	st, err := os.Lstat(filepath.Join(dir, SharedMark))
	return err == nil && st.Mode().IsRegular()
}

// evidenceHTML: trang tự chứa (mở offline), mỗi thiết bị / lần lặp / flow một bảng bước với YAML, selector, lỗi,
// gợi ý và ảnh trước/sau nhúng base64. Mọi chữ đều được thoát HTML.
func evidenceHTML(run RunRecord, flows []FlowRun) string {
	esc := html.EscapeString
	var b strings.Builder
	b.WriteString(`<!doctype html><html lang="vi"><head><meta charset="utf-8"><title>Evidence ` + esc(run.ID) + `</title>
<style>body{font:14px system-ui,sans-serif;margin:24px;color:#0f172a}table{border-collapse:collapse;width:100%;margin:8px 0 24px}
th,td{border:1px solid #cbd5e1;padding:6px;vertical-align:top;text-align:left}th{background:#f1f5f9}
.fail{background:#fef2f2}.ok{color:#15803d}.ko{color:#b91c1c}pre{white-space:pre-wrap;margin:0;font-size:12px}
img{max-width:220px;border:1px solid #e2e8f0}small{color:#64748b}</style></head><body>`)
	fmt.Fprintf(&b, "<h1>Lượt %s</h1><p>App <b>%s</b>%s · %s → %s · đạt %d, lỗi %d · ảnh: %s</p>",
		esc(run.ID), esc(run.App), labelPart(run.Label), esc(run.StartedAt.Format(time.DateTime)),
		esc(run.FinishedAt.Format(time.DateTime)), run.Passed, run.Failed, esc(orDash(run.Artifacts)))
	b.WriteString("<p><small>Ảnh chụp màn hình có thể chứa dữ liệu hiển thị trên máy (không che được); chỉ chia sẻ với người được phép xem.</small></p>")
	for _, f := range flows {
		status := `<span class="ok">ĐẠT</span>`
		if !f.Passed {
			status = `<span class="ko">LỖI</span>`
		}
		fmt.Fprintf(&b, "<h2>%s · %s · lần %d · %s</h2><p>%s · %d ms", esc(f.DeviceID), esc(f.Flow), f.Iteration,
			status, esc(f.Platform), f.DurationMs)
		if f.Error != "" {
			fmt.Fprintf(&b, " · <b>%s</b>: %s", esc(orDash(f.FailureClass)), esc(f.Error))
		}
		if f.Trace != "" {
			b.WriteString(" · trace: mở thư mục lượt chạy")
		}
		b.WriteString("</p><table><tr><th>#</th><th>Bước</th><th>YAML</th><th>Selector / phần tử</th><th>Lỗi</th><th>Ảnh trước</th><th>Ảnh sau</th></tr>")
		for _, s := range f.Steps {
			cls := ""
			if !s.Passed {
				cls = ` class="fail"`
			}
			idx := fmt.Sprint(s.Index)
			if s.Depth > 0 {
				idx = strings.Repeat("↳", s.Depth)
			}
			fmt.Fprintf(&b, "<tr%s><td>%s</td><td>%s<br><small>%d ms</small></td><td><pre>%s</pre></td><td>%s<br><small>%s</small></td><td>",
				cls, esc(idx), esc(firstNonEmpty(s.Label, s.Desc)), s.DurationMs, esc(s.Yaml), esc(s.Selector), esc(s.Element))
			if s.ErrorType != "" {
				fmt.Fprintf(&b, "<b>%s</b> ", esc(s.ErrorType))
			}
			b.WriteString(esc(s.Error))
			if s.Suggestion != "" {
				fmt.Fprintf(&b, "<br><small>Gợi ý: %s</small>", esc(s.Suggestion))
			}
			fmt.Fprintf(&b, "</td><td>%s</td><td>%s</td></tr>", inlineShot(run.OutDir, s.ShotBefore), inlineShot(run.OutDir, s.ShotAfter))
		}
		b.WriteString("</table>")
	}
	b.WriteString("</body></html>")
	return b.String()
}

func labelPart(label string) string {
	if label == "" {
		return ""
	}
	return " (bản " + html.EscapeString(label) + ")"
}

func orDash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// inlineShot: thẻ <img> với ảnh nhúng data URI; trống nếu không có ảnh hoặc đường dẫn không hợp lệ.
func inlineShot(outDir, rel string) string {
	if rel == "" {
		return ""
	}
	p, err := shotPath(outDir, rel)
	if err != nil {
		return ""
	}
	raw, err := os.ReadFile(p)
	if err != nil {
		return ""
	}
	return `<img alt="" src="data:image/png;base64,` + base64.StdEncoding.EncodeToString(raw) + `">`
}

// shotPath: đường dẫn tuyệt đối của ảnh PNG rel nằm trong outDir. Từ chối đường dẫn tuyệt đối, có "..", không phải
// .png, hoặc trỏ ra ngoài outDir (kể cả qua liên kết tượng trưng).
func shotPath(outDir, rel string) (string, error) { return runFilePath(outDir, rel, ".png") }

// runFilePath: như shotPath nhưng cho tệp có đuôi ext (không phân biệt hoa thường).
func runFilePath(outDir, rel, ext string) (string, error) {
	bad := apperr.New(apperr.CodeInvalid, "đường dẫn ảnh không hợp lệ")
	if outDir == "" || rel == "" || strings.ContainsRune(rel, 0) || strings.Contains(rel, `\`) ||
		path.IsAbs(rel) || filepath.IsAbs(rel) || filepath.VolumeName(rel) != "" {
		return "", bad
	}
	for _, part := range strings.Split(rel, "/") {
		if part == ".." {
			return "", bad
		}
	}
	if !strings.EqualFold(path.Ext(rel), ext) {
		return "", bad
	}
	root, err := filepath.EvalSymlinks(outDir)
	if err != nil {
		return "", apperr.New(apperr.CodeNotFound, "thư mục lượt chạy")
	}
	full, err := filepath.EvalSymlinks(filepath.Join(root, filepath.FromSlash(rel)))
	if err != nil {
		return "", apperr.New(apperr.CodeNotFound, "ảnh "+rel)
	}
	inside, err := filepath.Rel(root, full)
	if err != nil || inside == ".." || strings.HasPrefix(inside, ".."+string(filepath.Separator)) || filepath.IsAbs(inside) {
		return "", bad
	}
	return full, nil
}

// maxShotBytes: trần cỡ một ảnh bước trả cho UI.
const maxShotBytes = 20 << 20

// StepShot: ảnh PNG của một bước (đường dẫn tương đối với OutDir của lượt, như StepRun.ShotBefore) thành data URL.
func (e *Engine) StepShot(runID, rel string) (string, error) {
	if e.Metrics == nil {
		return "", apperr.New("test_engine_unavailable", "")
	}
	run, err := e.Metrics.Run(runID)
	if err != nil {
		return "", err
	}
	p, err := shotPath(run.OutDir, rel)
	if err != nil {
		return "", err
	}
	st, err := os.Stat(p)
	if err != nil {
		return "", err
	}
	if !st.Mode().IsRegular() || st.Size() > maxShotBytes {
		return "", apperr.New(apperr.CodeInvalid, "ảnh không hợp lệ hoặc quá lớn")
	}
	raw, err := os.ReadFile(p)
	if err != nil {
		return "", err
	}
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(raw), nil
}

// maxStepTextBytes: trần cỡ tệp văn bản của một bước (cây aria lúc lỗi) trả cho UI.
const maxStepTextBytes = 1 << 20

// StepText: nội dung tệp .txt của một bước (cây aria lúc lỗi của flow web; đường dẫn tương đối với OutDir của lượt,
// như StepRun.Hierarchy). Cùng quy tắc đường dẫn như StepShot. Lượt có dấu che bí mật hỏng thì từ chối; nội dung
// trả về còn được che lại với mọi giá trị bí mật đang có trong kho (tệp chỉ được che với bí mật của lượt).
func (e *Engine) StepText(runID, rel string) (string, error) {
	if e.Metrics == nil {
		return "", apperr.New("test_engine_unavailable", "")
	}
	run, err := e.Metrics.Run(runID)
	if err != nil {
		return "", err
	}
	if err := redactionFailed(run, "không đọc tệp của bước"); err != nil {
		return "", err
	}
	p, err := runFilePath(run.OutDir, rel, ".txt")
	if err != nil {
		return "", err
	}
	st, err := os.Stat(p)
	if err != nil {
		return "", err
	}
	if !st.Mode().IsRegular() || st.Size() > maxStepTextBytes {
		return "", apperr.New(apperr.CodeInvalid, "tệp không hợp lệ hoặc quá lớn")
	}
	raw, err := os.ReadFile(p)
	if err != nil {
		return "", err
	}
	return redact(string(raw), e.SecretValues()), nil
}

// ExportHistory ghi dữ liệu phân tích days ngày gần nhất (1..3650) vào destJSON.
func (e *Engine) ExportHistory(days int, destJSON string) error {
	if e.Metrics == nil {
		return apperr.New("test_engine_unavailable", "")
	}
	if days <= 0 || days > MaxRetentionDays {
		return apperr.New(apperr.CodeInvalid, fmt.Sprintf("số ngày xuất từ 1 đến %d", MaxRetentionDays))
	}
	now := e.clock()
	since := now.AddDate(0, 0, -days)
	h := HistoryExport{ExportedAt: now, Since: since, FlowRuns: []FlowRun{}}
	var err error
	if h.Runs, err = e.Metrics.queryRuns(`SELECT `+runCols+` FROM runs WHERE started_at >= ? ORDER BY started_at`, since.UnixMilli()); err != nil {
		return err
	}
	for _, r := range h.Runs {
		fr, err := e.Metrics.FlowRuns(r.ID)
		if err != nil {
			return err
		}
		h.FlowRuns = append(h.FlowRuns, fr...)
	}
	if h.LLMCalls, err = e.Metrics.llmCallsBetween(since, now); err != nil {
		return err
	}
	if h.ToolCalls, err = e.Metrics.toolCallsBetween(since, now); err != nil {
		return err
	}
	if h.UsageEvents, err = e.Metrics.UsageEvents(since, 1_000_000); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(h, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(destJSON), 0o755); err != nil {
		return err
	}
	return writeAtomic(destJSON, []byte(redact(string(raw), e.SecretValues())), 0o644)
}
