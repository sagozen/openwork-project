package teamsync

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"

	"deskcore/apperr"
)

// Evidence của lượt chạy trên kho nhóm (khoá tương đối, sau <prefix>/):
//   evidence/<deviceId>/<runId>/<tên trong gói>   đối tượng bất biến (If-None-Match *), đã có thì bỏ qua
//   runs-index/<deviceId>/<runId>.json            chỉ mục lượt, ghi SAU CÙNG nên lượt dở dang không hiện cho nhóm
// Mã lượt chỉ là giờ máy nên hai máy có thể trùng: mọi khoá nằm dưới DeviceID của máy đẩy. Tải về ở
// <dataDir>/team-runs/<deviceId>/<runId>/ (dọn theo số ngày giữ lượt chạy). Trace không bao giờ có trong gói.

const (
	// EvidenceConfirmBytes: gói evidence một lượt lớn hơn ⇒ hỏi xác nhận trước khi đẩy (không chặn).
	EvidenceConfirmBytes = 200 << 20
	// CodeConfirmRequired: gói lớn hơn EvidenceConfirmBytes mà chưa xác nhận (mã riêng, khác confirm_required của chi phí AI).
	CodeConfirmRequired = "evidence_confirm_required"
	// MaxTeamRunDays: số ngày lọc tối đa của TeamRuns (như hạn giữ dữ liệu).
	MaxTeamRunDays = 3650

	evidenceDir   = "evidence"
	runsIndexDir  = "runs-index"
	teamRunsDir   = "team-runs" // trùng testengine.TeamRunsDirName để dọn theo hạn giữ
	maxIndexBytes = 64 << 10
	// runIDSlack: mã lượt là giờ máy đẩy (múi giờ có thể khác) nên lọc sơ theo mã nới thêm chừng này trước khi tải chỉ mục.
	runIDSlack = 48 * time.Hour
)

var (
	// runIDRe: mã lượt chạy yymmdd-hhmmss[-n] (như testengine).
	runIDRe    = regexp.MustCompile(`^(\d{6}-\d{6})(?:-\d{1,2})?$`)
	deviceIDRe = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$`)
)

// RunSource: nguồn gói evidence của lượt chạy ở máy (testengine.Engine thoả). RunBundle phát từng tệp đã che bí mật
// qua yield, từ chối lượt có dấu che hỏng bằng lỗi redaction_failed; MarkRunShared ghi dấu đã chia sẻ vào thư mục lượt.
type RunSource interface {
	RunBundle(runID string, withVideo bool, yield func(name string, body io.Reader, size int64, media bool) error) error
	MarkRunShared(runID string) error
}

// Evidence: chia sẻ evidence lượt chạy với nhóm qua kho của Syncer.
type Evidence struct {
	s    *Syncer
	runs RunSource
	mu   sync.Mutex // một lần đẩy evidence tại một thời điểm (tách khỏi khoá đồng bộ tài liệu vì video đẩy lâu)
}

// NewEvidence dựng phần evidence trên Syncer đã cấu hình. PushRun cần DeviceID của máy dùng được làm đoạn khoá S3.
func NewEvidence(s *Syncer, runs RunSource) (*Evidence, error) {
	if s == nil || runs == nil {
		return nil, apperr.New(apperr.CodeInvalid, "evidence thiếu bộ đồng bộ hoặc nguồn lượt chạy")
	}
	return &Evidence{s: s, runs: runs}, nil
}

// RunIndex: chỉ mục một lượt đã chia sẻ (runs-index/<deviceId>/<runId>.json), lấy từ summary.json của gói.
type RunIndex struct {
	RunID      string    `json:"runId"`
	DeviceID   string    `json:"deviceId"`
	Author     string    `json:"author"`
	App        string    `json:"app"`
	Label      string    `json:"label,omitempty"`
	Flows      int       `json:"flows"` // số lượt flow (thiết bị × lần lặp × flow)
	Passed     int       `json:"passed"`
	Failed     int       `json:"failed"`
	StartedAt  time.Time `json:"startedAt"`
	FinishedAt time.Time `json:"finishedAt"`
	SizeBytes  int64     `json:"sizeBytes"`
	SharedAt   time.Time `json:"sharedAt"`
}

// TeamRun: một dòng của danh sách lượt nhóm; Mine = lượt do máy này đẩy.
type TeamRun struct {
	RunIndex
	Mine bool `json:"mine"`
}

// PushRunOptions: Confirm = người dùng đã đồng ý đẩy gói lớn hơn EvidenceConfirmBytes.
type PushRunOptions struct {
	Confirm bool
}

// PushRunResult: kết quả PushRun. ConfirmRequired đi kèm lỗi evidence_confirm_required, chưa tải gì lên.
type PushRunResult struct {
	RunID           string `json:"runId"`
	DeviceID        string `json:"deviceId"`
	Files           int    `json:"files"`
	Uploaded        int    `json:"uploaded"`
	Skipped         int    `json:"skipped"` // đã có trên kho (lần đẩy trước)
	SizeBytes       int64  `json:"sizeBytes"`
	ConfirmRequired bool   `json:"confirmRequired,omitempty"`
	LimitBytes      int64  `json:"limitBytes,omitempty"` // ngưỡng hỏi xác nhận, khi ConfirmRequired
}

// runSummary: phần summary.json (testengine.RunExport) cần cho chỉ mục.
type runSummary struct {
	Run struct {
		ID         string    `json:"id"`
		App        string    `json:"app"`
		Label      string    `json:"label"`
		Passed     int       `json:"passed"`
		Failed     int       `json:"failed"`
		StartedAt  time.Time `json:"startedAt"`
		FinishedAt time.Time `json:"finishedAt"`
	} `json:"run"`
	Flows []json.RawMessage `json:"flows"`
}

const summaryName = "summary.json"

func validRunID(id string) error {
	if !runIDRe.MatchString(id) {
		return apperr.New(apperr.CodeInvalid, "mã lượt chạy")
	}
	return nil
}

func validDeviceID(id string) error {
	if !deviceIDRe.MatchString(id) {
		return apperr.New(apperr.CodeInvalid, "mã máy không dùng được trong khoá S3")
	}
	return nil
}

// evidenceName kiểm một tên tệp trong gói (đường dẫn "/"): không rỗng, không tuyệt đối, không "\", NUL hay ký tự điều
// khiển, không đoạn rỗng/ẩn/".."; không bao giờ là .zip (trace).
func evidenceName(name string) error {
	bad := apperr.New(apperr.CodeInvalid, fmt.Sprintf("tên tệp evidence %q không an toàn", name))
	if name == "" || len(name) > maxKeyLen || strings.HasPrefix(name, "/") || strings.ContainsRune(name, '\\') ||
		strings.EqualFold(path.Ext(name), ".zip") {
		return bad
	}
	for _, r := range name {
		if unicode.IsControl(r) {
			return bad
		}
	}
	for _, seg := range strings.Split(name, "/") {
		if seg == "" || strings.HasPrefix(seg, ".") {
			return bad
		}
	}
	return nil
}

func evidencePrefix(deviceID, runID string) string {
	return evidenceDir + "/" + deviceID + "/" + runID + "/"
}

func indexKey(deviceID, runID string) string {
	return runsIndexDir + "/" + deviceID + "/" + runID + ".json"
}

// PushRun đẩy evidence của lượt runID: mọi tệp gói (ảnh, video, báo cáo đã che; không trace) lên
// evidence/<deviceId>/<runId>/, rồi chỉ mục runs-index/<deviceId>/<runId>.json sau cùng, rồi đánh dấu lượt đã chia sẻ.
// Lỗi redaction_failed của nguồn được trả nguyên. Gói lớn hơn EvidenceConfirmBytes mà opts.Confirm = false ⇒ kết quả
// ConfirmRequired kèm lỗi evidence_confirm_required, không tải gì. Đối tượng đã có (lần đẩy trước dừng giữa chừng) thì bỏ qua;
// huỷ ctx dừng ở tệp kế tiếp.
func (e *Evidence) PushRun(ctx context.Context, runID string, opts PushRunOptions) (PushRunResult, error) {
	dev := e.s.actor.DeviceID
	res := PushRunResult{RunID: runID, DeviceID: dev}
	if err := validRunID(runID); err != nil {
		return res, err
	}
	if err := validDeviceID(dev); err != nil {
		return res, err
	}
	if !e.mu.TryLock() {
		return res, apperr.New("busy", "đang đẩy evidence của lượt khác")
	}
	defer e.mu.Unlock()

	// Lượt một: kích thước, tên tệp và summary.json.
	var summary []byte
	names := map[string]bool{}
	err := e.runs.RunBundle(runID, true, func(name string, body io.Reader, size int64, _ bool) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := evidenceName(name); err != nil {
			return err
		}
		if names[name] {
			return apperr.New(apperr.CodeInvalid, "tệp evidence trùng tên "+name)
		}
		names[name] = true
		res.Files++
		res.SizeBytes += size
		if name == summaryName {
			b, err := io.ReadAll(io.LimitReader(body, MaxTextBytes+1))
			if err != nil {
				return err
			}
			summary = b
		}
		return nil
	})
	if err != nil {
		return res, err
	}
	idx, err := e.indexFrom(runID, summary, res.SizeBytes)
	if err != nil {
		return res, err
	}
	if res.SizeBytes > EvidenceConfirmBytes && !opts.Confirm {
		res.ConfirmRequired, res.LimitBytes = true, EvidenceConfirmBytes
		return res, apperr.New(CodeConfirmRequired, fmt.Sprintf("evidence lượt %s nặng %.1f MB (ngưỡng %d MB), cần xác nhận trước khi đẩy",
			runID, float64(res.SizeBytes)/(1<<20), EvidenceConfirmBytes>>20))
	}

	// Lượt hai: tải từng tệp, bất biến.
	meta := map[string]string{MetaAuthor: url.QueryEscape(e.s.actor.Name), MetaDevice: url.QueryEscape(dev)}
	prefix := evidencePrefix(dev, runID)
	err = e.runs.RunBundle(runID, true, func(name string, body io.Reader, size int64, _ bool) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if !names[name] {
			return apperr.New(apperr.CodeInvalid, "gói evidence đổi giữa hai lần đọc: "+name)
		}
		created, err := e.putOnce(ctx, prefix+name, body, size, meta)
		if err != nil {
			return fmt.Errorf("đẩy %s: %w", name, err)
		}
		if created {
			res.Uploaded++
		} else {
			res.Skipped++
		}
		return nil
	})
	if err != nil {
		return res, err
	}

	raw, err := json.MarshalIndent(idx, "", "  ")
	if err != nil {
		return res, err
	}
	if _, err := e.putOnce(ctx, indexKey(dev, runID), bytes.NewReader(raw), int64(len(raw)), meta); err != nil {
		return res, fmt.Errorf("ghi chỉ mục lượt: %w", err)
	}
	if err := e.runs.MarkRunShared(runID); err != nil {
		return res, err
	}
	return res, nil
}

// indexFrom dựng chỉ mục từ summary.json của gói.
func (e *Evidence) indexFrom(runID string, summary []byte, size int64) (RunIndex, error) {
	var sm runSummary
	if len(summary) == 0 || len(summary) > MaxTextBytes || json.Unmarshal(summary, &sm) != nil || sm.Run.ID != runID {
		return RunIndex{}, apperr.New(apperr.CodeInvalid, "gói evidence thiếu summary.json hợp lệ")
	}
	return RunIndex{
		RunID: runID, DeviceID: e.s.actor.DeviceID, Author: e.s.actor.Name, App: sm.Run.App, Label: sm.Run.Label,
		Flows: len(sm.Flows), Passed: sm.Run.Passed, Failed: sm.Run.Failed, StartedAt: sm.Run.StartedAt,
		FinishedAt: sm.Run.FinishedAt, SizeBytes: size, SharedAt: e.s.now().UTC(),
	}, nil
}

// putOnce ghi đối tượng bất biến: HEAD trước (đã có thì không gửi lại nội dung, video lớn), rồi PUT If-None-Match *
// (kho không hỗ trợ điều kiện ⇒ PUT thường sau HEAD). created = false khi đối tượng đã có.
func (e *Evidence) putOnce(ctx context.Context, rel string, body io.Reader, size int64, meta map[string]string) (bool, error) {
	key := e.s.remoteKey(rel)
	_, err := e.s.store.Head(ctx, key)
	switch {
	case err == nil:
		return false, nil
	case !errors.Is(err, ErrNotFound):
		return false, err
	}
	cond := PutCond{IfNoneMatch: "*"}
	if e.s.noCond {
		cond = PutCond{}
	}
	_, err = e.s.store.Put(ctx, key, body, size, cond, meta)
	if errors.Is(err, ErrPrecondition) {
		return false, nil // máy này vừa đẩy cùng tệp ở phiên khác
	}
	return err == nil, err
}

// TeamRuns liệt kê các lượt nhóm đã chia sẻ (gồm của máy này) bắt đầu trong days ngày gần nhất, mới nhất trước. Khoá
// chỉ mục sai bố cục, chỉ mục hỏng hay không khớp khoá đều bị bỏ qua.
func (e *Evidence) TeamRuns(ctx context.Context, days int) ([]TeamRun, error) {
	if days <= 0 || days > MaxTeamRunDays {
		return nil, apperr.New(apperr.CodeInvalid, fmt.Sprintf("số ngày từ 1 đến %d", MaxTeamRunDays))
	}
	cutoff := e.s.now().AddDate(0, 0, -days)
	objs, err := e.s.store.List(ctx, e.s.remoteKey(runsIndexDir+"/"), MaxKeys)
	if err != nil {
		return nil, wrapList(err)
	}
	out := []TeamRun{}
	for _, o := range objs {
		rel := strings.TrimPrefix(o.Key, e.s.prefix+"/"+runsIndexDir+"/")
		dev, file, ok := strings.Cut(rel, "/")
		runID, isJSON := strings.CutSuffix(file, ".json")
		if !ok || !isJSON || validDeviceID(dev) != nil || validRunID(runID) != nil || o.Size > maxIndexBytes {
			continue
		}
		if at, err := time.ParseInLocation("060102-150405", runIDRe.FindStringSubmatch(runID)[1], time.UTC); err != nil ||
			at.Before(cutoff.Add(-runIDSlack)) {
			continue
		}
		idx, err := e.readIndex(ctx, o.Key)
		if errors.Is(err, ErrNotFound) {
			continue // vừa bị xoá
		}
		if err != nil {
			return nil, err
		}
		if idx == nil || idx.RunID != runID || idx.DeviceID != dev || idx.StartedAt.Before(cutoff) {
			continue
		}
		out = append(out, TeamRun{RunIndex: *idx, Mine: dev == e.s.actor.DeviceID})
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].StartedAt.Equal(out[j].StartedAt) {
			return out[i].StartedAt.After(out[j].StartedAt)
		}
		return out[i].DeviceID < out[j].DeviceID
	})
	return out, nil
}

// readIndex đọc một chỉ mục; nil khi nội dung hỏng hoặc quá lớn.
func (e *Evidence) readIndex(ctx context.Context, key string) (*RunIndex, error) {
	rc, _, err := e.s.store.Get(ctx, key)
	if err != nil {
		return nil, err
	}
	defer rc.Close()
	b, err := io.ReadAll(io.LimitReader(rc, maxIndexBytes+1))
	if err != nil {
		return nil, err
	}
	var idx RunIndex
	if len(b) > maxIndexBytes || json.Unmarshal(b, &idx) != nil {
		return nil, nil
	}
	return &idx, nil
}

// OpenTeamRun tải lười evidence của lượt (deviceID, runID) về <dataDir>/team-runs/<deviceID>/<runID>/ rồi trả đường
// dẫn evidence.html. Đã tải thì chỉ làm mới mtime (giữ lâu hơn khi dọn). Chỉ lượt đã có chỉ mục (đẩy xong) mới mở được;
// khoá trên kho được kiểm như đồng bộ tài liệu (không thoát thư mục, không tệp ẩn, không .zip) và tải vào thư mục tạm
// rồi đổi tên nên không bao giờ thấy bản dở.
func (e *Evidence) OpenTeamRun(ctx context.Context, deviceID, runID string) (string, error) {
	if err := validDeviceID(deviceID); err != nil {
		return "", err
	}
	if err := validRunID(runID); err != nil {
		return "", err
	}
	devDir, err := safeJoin(e.s.dataDir, filepath.Join(teamRunsDir, deviceID))
	if err != nil {
		return "", err
	}
	final, err := safeJoin(e.s.dataDir, filepath.Join(teamRunsDir, deviceID, runID))
	if err != nil {
		return "", err
	}
	page := filepath.Join(final, "evidence.html")
	if ok, err := regularFile(page); err != nil {
		return "", err
	} else if ok {
		now := e.s.now()
		_ = os.Chtimes(final, now, now)
		return page, nil
	}
	if _, err := e.s.store.Head(ctx, e.s.remoteKey(indexKey(deviceID, runID))); errors.Is(err, ErrNotFound) {
		return "", apperr.New(apperr.CodeNotFound, "lượt nhóm "+deviceID+"/"+runID)
	} else if err != nil {
		return "", err
	}
	remotePrefix := e.s.remoteKey(evidencePrefix(deviceID, runID))
	objs, err := e.s.store.List(ctx, remotePrefix, MaxKeys)
	if err != nil {
		return "", wrapList(err)
	}
	if err := os.MkdirAll(devDir, 0o755); err != nil {
		return "", err
	}
	tmp, err := os.MkdirTemp(devDir, "."+runID+".part-*")
	if err != nil {
		return "", err
	}
	if err := e.download(ctx, tmp, remotePrefix, objs); err != nil {
		_ = os.RemoveAll(tmp)
		return "", err
	}
	if ok, _ := regularFile(filepath.Join(tmp, "evidence.html")); !ok {
		_ = os.RemoveAll(tmp)
		return "", apperr.New(apperr.CodeNotFound, "evidence.html của lượt nhóm "+deviceID+"/"+runID)
	}
	if err := os.Rename(tmp, final); err != nil {
		_ = os.RemoveAll(tmp)
		if ok, _ := regularFile(page); ok {
			return page, nil // phiên khác vừa tải xong cùng lượt
		}
		return "", err
	}
	return page, nil
}

// download chép các đối tượng dưới remotePrefix vào dir, kiểm từng khoá và cỡ.
func (e *Evidence) download(ctx context.Context, dir, remotePrefix string, objs []Object) error {
	for _, o := range objs {
		if err := ctx.Err(); err != nil {
			return err
		}
		name := strings.TrimPrefix(o.Key, remotePrefix)
		if evidenceName(name) != nil {
			continue // khoá lạ trên kho: không bao giờ ghi ra ngoài thư mục lượt
		}
		dst, err := safeJoin(dir, filepath.FromSlash(name))
		if err != nil {
			continue
		}
		if err := e.fetch(ctx, o, dst); err != nil {
			return fmt.Errorf("tải %s: %w", name, err)
		}
	}
	return nil
}

func (e *Evidence) fetch(ctx context.Context, o Object, dst string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	rc, _, err := e.s.store.Get(ctx, o.Key)
	if err != nil {
		return err
	}
	defer rc.Close()
	f, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return err
	}
	// Không đọc quá cỡ đã liệt kê lúc List.
	_, err = io.Copy(f, io.LimitReader(rc, o.Size))
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	return err
}

func regularFile(p string) (bool, error) {
	st, err := os.Lstat(p)
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return st.Mode().IsRegular(), nil
}
