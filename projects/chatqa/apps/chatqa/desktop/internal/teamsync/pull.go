package teamsync

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"chatqa/internal/docs"
	"deskcore/apperr"
)

// PullResult: kết quả Pull.
type PullResult struct {
	Pulled    []string    `json:"pulled"`    // tải về và ghi vào kho
	Deleted   []string    `json:"deleted"`   // xoá cục bộ vì người khác đã xoá
	Merged    []string    `json:"merged"`    // manifest gộp tự động (cần Đẩy lên để chia sẻ bản gộp)
	Conflicts []string    `json:"conflicts"` // mọi khoá đang xung đột sau lần chạy
	Skipped   []Skip      `json:"skipped"`
	Errors    []FileError `json:"errors"`
	Warnings  []Warning   `json:"warnings"`
}

// Skip: tệp không xử lý ở lần này và lý do (thường là trạng thái của nó).
type Skip struct {
	Key    string `json:"key"`
	Reason string `json:"reason"`
}

// errLocalMoved: tệp làm việc đổi giữa lúc quét và lúc ghi ⇒ không ghi đè.
var errLocalMoved = errors.New("tệp làm việc vừa đổi, không ghi đè")

// Pull tải các thay đổi của người khác: remote_changed|remote_new mà cục bộ chưa đổi ⇒ ghi; remote_deleted mà cục bộ
// chưa đổi ⇒ xoá (trừ khi kho không còn khoá nào của app: bỏ qua với remote_empty); hai bên cùng đổi ⇒ manifest gộp
// tự động, còn lại giữ bản của họ ở vùng xung đột. Tệp làm việc đã đổi không bao giờ bị ghi đè; tài liệu bị thay hay xoá
// được chép vào lịch sử trước.
func (s *Syncer) Pull(ctx context.Context, apps []string) (PullResult, error) {
	done, err := s.begin()
	if err != nil {
		return PullResult{}, err
	}
	defer done()
	if err := s.resetIfMoved(); err != nil {
		return PullResult{}, err
	}
	snap, err := s.scan(ctx, apps)
	if err != nil {
		return PullResult{}, err
	}
	res := PullResult{Pulled: []string{}, Deleted: []string{}, Merged: []string{}, Conflicts: []string{}, Skipped: []Skip{}, Errors: []FileError{}, Warnings: snap.warnings}
	st := snap.st
	docApps := map[string]bool{}
	items := append([]*item(nil), snap.items...)
	sort.SliceStable(items, func(i, j int) bool { return writeOrder(items[i].ref) < writeOrder(items[j].ref) })
	for _, it := range items {
		if err := ctx.Err(); err != nil {
			res.Errors = append(res.Errors, FileError{Key: it.ref.Key, Error: err.Error()})
			break
		}
		if it.state == StateRemoteDeleted && snap.vanished[it.ref.App] {
			res.Skipped = append(res.Skipped, Skip{Key: it.ref.Key, Reason: SkipRemoteEmpty})
			continue
		}
		outcome, err := s.pullOne(ctx, st, it)
		switch {
		case errors.Is(err, errLocalMoved):
			res.Skipped = append(res.Skipped, Skip{Key: it.ref.Key, Reason: StateLocalChanged})
		case err != nil:
			res.Errors = append(res.Errors, FileError{Key: it.ref.Key, Error: err.Error()})
		case outcome == outPulled:
			res.Pulled = append(res.Pulled, it.ref.Key)
			if it.ref.Kind == KindDoc {
				docApps[it.ref.App] = true
			}
		case outcome == outDeleted:
			res.Deleted = append(res.Deleted, it.ref.Key)
		case outcome == outMerged:
			res.Merged = append(res.Merged, it.ref.Key)
		case outcome == outConflict:
			res.Conflicts = append(res.Conflicts, it.ref.Key)
		case outcome == outSkipped:
			res.Skipped = append(res.Skipped, Skip{Key: it.ref.Key, Reason: it.state})
		}
	}
	st.LastPull = s.now().UTC()
	if err := s.saveState(st); err != nil {
		return res, err
	}
	for app := range docApps {
		res.Warnings = append(res.Warnings, s.duplicateReqs(app)...)
	}
	return res, nil
}

type outcome int

const (
	outNone outcome = iota
	outSkipped
	outPulled
	outPushed
	outDeleted
	outMerged
	outConflict
	outSame // hai bên cùng nội dung: chỉ ghi nhận gốc
)

// writeOrder: ảnh và flow con trước, flow gốc sau, manifest cuối, để Validator giải được runFlow.
func writeOrder(r fileRef) int {
	switch {
	case r.Kind == KindAsset:
		return 0
	case r.Kind == KindFlow && strings.Contains(r.Rel, "/"):
		return 1
	case r.Kind == KindFlow:
		return 2
	case r.Kind == KindManifest:
		return 3
	}
	return 4
}

func (s *Syncer) pullOne(ctx context.Context, st *syncState, it *item) (outcome, error) {
	switch it.state {
	case "":
		return outNone, s.dropBase(st, it.ref)
	case StateSynced:
		return outNone, nil
	case StateRemoteNew, StateRemoteChanged:
		data, obj, err := s.fetch(ctx, it.ref)
		if errors.Is(err, ErrNotFound) {
			return outSkipped, nil // vừa bị xoá trên kho; lần sau sẽ thấy
		}
		if err != nil {
			return outNone, err
		}
		if reason, detail := s.check(it.ref, data); reason != "" {
			return outConflict, s.saveConflict(it.ref, data, s.theirsMeta(obj, reason, detail))
		}
		if err := s.writeLocal(it, data); err != nil {
			return outNone, err
		}
		return outPulled, s.setBase(st, it.ref, obj.ETag, data)
	case StateRemoteDeleted:
		if err := s.removeLocal(it); err != nil {
			return outNone, err
		}
		return outDeleted, s.dropBase(st, it.ref)
	case StateBothChanged:
		out, _, err := s.reconcile(ctx, st, it)
		return out, err
	case StateConflict:
		return outConflict, s.refreshConflict(ctx, it)
	}
	return outSkipped, nil
}

// fetch tải một đối tượng, giới hạn kích thước, kiểm cqs-sha256 khi có.
func (s *Syncer) fetch(ctx context.Context, r fileRef) ([]byte, Object, error) {
	body, obj, err := s.store.Get(ctx, s.remoteKey(r.Key))
	if err != nil {
		return nil, Object{}, err
	}
	defer body.Close()
	data, err := io.ReadAll(io.LimitReader(body, r.maxBytes()+1))
	if err != nil {
		return nil, Object{}, fmt.Errorf("tải %s: %w", r.Key, err)
	}
	if int64(len(data)) > r.maxBytes() {
		return nil, Object{}, apperr.New(apperr.CodeInvalid, fmt.Sprintf("%s lớn quá %d MB", r.Key, r.maxBytes()>>20))
	}
	if want := obj.Meta[MetaSHA256]; want != "" && want != sha256Hex(data) {
		return nil, Object{}, fmt.Errorf("%s: nội dung tải về không khớp cqs-sha256", r.Key)
	}
	return data, obj, nil
}

func (s *Syncer) theirsMeta(obj Object, reason, detail string) ConflictMeta {
	return ConflictMeta{
		TheirsETag: obj.ETag, Author: metaValue(obj.Meta, MetaAuthor), Device: metaValue(obj.Meta, MetaDevice),
		Reason: reason, Detail: truncate(detail, 2000),
	}
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// check kiểm nội dung trước khi vào kho; trả lý do (và chi tiết) khi không qua.
func (s *Syncer) check(r fileRef, data []byte) (reason, detail string) {
	switch r.Kind {
	case KindFlow:
		if err := s.validator.ValidateFlow(r.App, r.Rel, data); err != nil {
			return ReasonInvalidFlow, err.Error()
		}
	case KindDoc:
		if _, err := docs.Parse(string(data)); err != nil {
			return ReasonInvalidDoc, err.Error()
		}
	case KindNote:
		if !jsonObject(data) {
			return ReasonInvalidNote, "ghi chú không phải đối tượng JSON"
		}
	case KindManifest:
		if !jsonObject(data) {
			return ReasonInvalidManifest, "manifest không phải đối tượng JSON"
		}
	}
	return "", ""
}

func jsonObject(b []byte) bool {
	var m map[string]json.RawMessage
	return json.Unmarshal(b, &m) == nil && m != nil
}

// localSHA: sha256 tệp làm việc lúc này; "" khi không có.
func localSHA(path string) (string, error) {
	b, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return sha256Hex(b), nil
}

// unchanged: tệp làm việc còn đúng như lúc quét (trong Locker).
func unchanged(it *item) error {
	cur, err := localSHA(it.path)
	if err != nil {
		return err
	}
	want := ""
	if it.local {
		want = it.localSHA
	}
	if cur != want {
		return errLocalMoved
	}
	return nil
}

// writeLocal ghi tệp làm việc dưới Locker, chỉ khi nó còn đúng như lúc quét.
func (s *Syncer) writeLocal(it *item, data []byte) error {
	return s.locker.WithLock(it.ref.App, func() error {
		if err := unchanged(it); err != nil {
			return err
		}
		if _, err := s.localPath(it.ref); err != nil { // kiểm lại: thư mục có thể vừa bị thay bằng symlink
			return err
		}
		if err := s.archiveDoc(it.ref); err != nil {
			return err
		}
		return writeAtomic(it.path, data)
	})
}

// removeLocal xoá tệp làm việc dưới Locker, chỉ khi nó còn đúng như lúc quét.
func (s *Syncer) removeLocal(it *item) error {
	return s.locker.WithLock(it.ref.App, func() error {
		if err := unchanged(it); err != nil {
			return err
		}
		if err := s.archiveDoc(it.ref); err != nil {
			return err
		}
		return removeIfExists(it.path)
	})
}

// archiveDoc (trong Locker): tài liệu sắp bị ghi đè hay xoá ⇒ chép bản đang có vào docs/<app>/.history như kho tài liệu.
func (s *Syncer) archiveDoc(r fileRef) error {
	if r.Kind != KindDoc {
		return nil
	}
	if err := docs.ArchiveCurrent(filepath.Join(s.dataDir, docsDir), r.App, strings.TrimSuffix(r.Rel, ".md")); err != nil {
		return fmt.Errorf("lưu lịch sử %s: %w", r.Key, err)
	}
	return nil
}

// duplicateReqs: cảnh báo mã yêu cầu trùng giữa các tài liệu của app sau khi kéo về (không chặn).
func (s *Syncer) duplicateReqs(app string) []Warning {
	dir := filepath.Join(s.dataDir, docsDir, app)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	owner := map[string]string{}
	dups := map[string]bool{}
	for _, e := range entries {
		id, ok := strings.CutSuffix(e.Name(), ".md")
		if !ok || !e.Type().IsRegular() || !docIDRe.MatchString(id) {
			continue
		}
		b, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil || len(b) > MaxTextBytes {
			continue
		}
		d, err := docs.Parse(string(bytes.ReplaceAll(b, []byte("\r\n"), []byte("\n"))))
		if err != nil {
			continue
		}
		for _, r := range d.Requirements {
			if o, ok := owner[r.ID]; ok && o != id {
				dups[r.ID] = true
			} else if !ok {
				owner[r.ID] = id
			}
		}
	}
	if len(dups) == 0 {
		return nil
	}
	ids := make([]string, 0, len(dups))
	for id := range dups {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return []Warning{{Key: "apps/" + app + "/docs", Message: "mã yêu cầu trùng giữa các tài liệu sau khi kéo về: " + strings.Join(ids, ", ") + "; đổi mã ở một bên"}}
}
