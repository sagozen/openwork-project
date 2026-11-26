package teamsync

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"sort"
	"strings"

	"chatqa/internal/textdiff"
	"deskcore/apperr"
)

// reconcile xử lý khoá hai bên cùng đổi: cùng nội dung ⇒ chỉ ghi nhận gốc; manifest ⇒ gộp theo khoá JSON và ghi tệp làm
// việc (gốc = bản của họ, lần đẩy sau PUT If-Match bản của họ); còn lại ⇒ bản của họ vào vùng xung đột. Trả thêm ETag
// bản của họ khi gộp được (cho Push đẩy ngay).
func (s *Syncer) reconcile(ctx context.Context, st *syncState, it *item) (outcome, string, error) {
	var theirs []byte
	var obj Object
	theirsDeleted := it.remote == nil
	if !theirsDeleted {
		var err error
		theirs, obj, err = s.fetch(ctx, it.ref)
		switch {
		case errors.Is(err, ErrNotFound):
			theirsDeleted = true
		case err != nil:
			return outNone, "", err
		}
	}
	var mine []byte
	if it.local {
		b, err := os.ReadFile(it.path)
		switch {
		case errors.Is(err, fs.ErrNotExist):
			return outNone, "", errLocalMoved
		case err != nil:
			return outNone, "", err
		case sha256Hex(b) != it.localSHA:
			return outNone, "", errLocalMoved
		}
		mine = b
	}
	if theirsDeleted {
		if !it.local {
			return outSame, "", s.dropBase(st, it.ref) // hai bên cùng xoá
		}
		return outConflict, "", s.saveConflict(it.ref, nil, ConflictMeta{TheirsDeleted: true})
	}
	if it.local && sha256Hex(mine) == sha256Hex(theirs) {
		return outSame, "", s.setBase(st, it.ref, obj.ETag, theirs)
	}
	if reason, detail := s.check(it.ref, theirs); reason != "" {
		return outConflict, "", s.saveConflict(it.ref, theirs, s.theirsMeta(obj, reason, detail))
	}
	if it.ref.Kind == KindManifest && it.local {
		base, err := s.baseText(it.ref)
		if err != nil {
			return outNone, "", err
		}
		merged, ok, err := mergeJSON(base, mine, theirs)
		if err != nil {
			return outNone, "", err
		}
		if ok {
			if err := s.writeLocal(it, merged); err != nil {
				return outNone, "", err
			}
			if err := s.setBase(st, it.ref, obj.ETag, theirs); err != nil {
				return outNone, "", err
			}
			return outMerged, obj.ETag, nil
		}
	}
	return outConflict, "", s.saveConflict(it.ref, theirs, s.theirsMeta(obj, "", ""))
}

// refreshConflict: phía xa đổi tiếp sau khi xung đột được ghi ⇒ cập nhật bản của họ ở vùng xung đột.
func (s *Syncer) refreshConflict(ctx context.Context, it *item) error {
	m := it.conflict
	moved := (it.remote == nil) != m.TheirsDeleted || (it.remote != nil && it.remote.ETag != m.TheirsETag)
	if !moved {
		return nil
	}
	if it.remote == nil {
		return s.saveConflict(it.ref, nil, ConflictMeta{TheirsDeleted: true})
	}
	data, obj, err := s.fetch(ctx, it.ref)
	if errors.Is(err, ErrNotFound) {
		return s.saveConflict(it.ref, nil, ConflictMeta{TheirsDeleted: true})
	}
	if err != nil {
		return err
	}
	reason, detail := s.check(it.ref, data)
	return s.saveConflict(it.ref, data, s.theirsMeta(obj, reason, detail))
}

// ConflictInfo: một dòng trong danh sách xung đột.
type ConflictInfo struct {
	Key           string `json:"key"`
	App           string `json:"app"`
	Kind          string `json:"kind"`
	Author        string `json:"author"`
	Device        string `json:"device"`
	Reason        string `json:"reason,omitempty"`
	TheirsDeleted bool   `json:"theirsDeleted"`
}

// CodeConflictChanged: bản của họ ở vùng xung đột đã đổi (một lần Kéo về làm mới) sau khi người dùng mở màn gộp.
const CodeConflictChanged = "sync_conflict_changed"

// Conflicts liệt kê các xung đột đang mở.
func (s *Syncer) Conflicts() ([]ConflictInfo, error) {
	if moved, err := s.stateMoved(); err != nil || moved {
		return []ConflictInfo{}, err // xung đột của kho cũ không còn hiệu lực
	}
	metas, err := s.conflictMetas()
	if err != nil {
		return nil, err
	}
	out := make([]ConflictInfo, 0, len(metas))
	for k, m := range metas {
		r, _ := parseKey(k)
		out = append(out, ConflictInfo{Key: k, App: r.App, Kind: r.Kind, Author: m.Author, Device: m.Device, Reason: m.Reason, TheirsDeleted: m.TheirsDeleted})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Key < out[j].Key })
	return out, nil
}

// ConflictView: dữ liệu màn gộp 3 cột. Merged điền sẵn bằng textdiff.Merge3 (còn dấu xung đột khi Conflicts > 0).
type ConflictView struct {
	Key           string `json:"key"`
	App           string `json:"app"`
	Kind          string `json:"kind"`
	Base          string `json:"base"`
	Mine          string `json:"mine"`
	Theirs        string `json:"theirs"`
	Merged        string `json:"merged"`
	Conflicts     int    `json:"conflicts"`
	MineDeleted   bool   `json:"mineDeleted"`
	TheirsDeleted bool   `json:"theirsDeleted"`
	Binary        bool   `json:"binary"` // ảnh: chỉ chọn một bản (KeepMine / TakeTheirs)
	TheirAuthor   string `json:"theirAuthor"`
	TheirDevice   string `json:"theirDevice"`
	Reason        string `json:"reason,omitempty"`
	Detail        string `json:"detail,omitempty"`
	// TheirsSHA256: sha256 bản của họ đang hiện ("" khi họ đã xoá); gửi lại khi chọn để không gộp nhầm bản cũ.
	TheirsSHA256 string `json:"theirsSha256"`
}

func (s *Syncer) openConflict(key string) (fileRef, ConflictMeta, []byte, error) {
	r, err := parseKey(key)
	if err != nil {
		return fileRef{}, ConflictMeta{}, nil, err
	}
	moved, err := s.stateMoved()
	if err != nil {
		return fileRef{}, ConflictMeta{}, nil, err
	}
	m, theirs, ok, err := s.loadConflict(r)
	if err != nil {
		return fileRef{}, ConflictMeta{}, nil, err
	}
	if !ok || moved {
		return fileRef{}, ConflictMeta{}, nil, apperr.New(apperr.CodeNotFound, "không có xung đột cho "+key)
	}
	return r, m, theirs, nil
}

// Conflict trả gốc / của tôi / của họ và bản gộp gợi ý.
func (s *Syncer) Conflict(key string) (ConflictView, error) {
	r, m, theirs, err := s.openConflict(key)
	if err != nil {
		return ConflictView{}, err
	}
	v := ConflictView{
		Key: r.Key, App: r.App, Kind: r.Kind, TheirsDeleted: m.TheirsDeleted, Binary: !r.text(),
		TheirAuthor: m.Author, TheirDevice: m.Device, Reason: m.Reason, Detail: m.Detail, TheirsSHA256: m.TheirsSHA256,
	}
	path, err := s.localPath(r)
	if err != nil {
		return ConflictView{}, err
	}
	mine, err := os.ReadFile(path)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		v.MineDeleted = true
	case err != nil:
		return ConflictView{}, err
	}
	if v.Binary {
		return v, nil
	}
	base, err := s.baseText(r)
	if err != nil {
		return ConflictView{}, err
	}
	v.Base, v.Mine, v.Theirs = string(base), string(mine), string(theirs)
	v.Merged, v.Conflicts = textdiff.Merge3(v.Base, v.Mine, v.Theirs)
	return v, nil
}

// Resolve ghi bản gộp vào tệp làm việc và lấy bản của họ làm gốc, nên lần Push sau PUT If-Match bản của họ thành công.
// Bản gộp còn dấu xung đột hoặc không qua kiểm tra (flow, tài liệu, JSON) bị từ chối. theirsSHA là ConflictView.TheirsSHA256
// lúc mở màn gộp: bản của họ đã đổi từ đó ⇒ CodeConflictChanged, không ghi gì.
func (s *Syncer) Resolve(key, merged, theirsSHA string) error {
	r, err := parseKey(key)
	if err != nil {
		return err
	}
	if !r.text() {
		return apperr.New(apperr.CodeInvalid, "ảnh không gộp được; chọn giữ bản của tôi hoặc lấy bản của họ")
	}
	if hasMarkers(merged) {
		return apperr.New(apperr.CodeInvalid, "bản gộp còn dấu xung đột <<<<<<< / >>>>>>>")
	}
	if int64(len(merged)) > r.maxBytes() {
		return apperr.New(apperr.CodeInvalid, fmt.Sprintf("bản gộp lớn quá %d MB", r.maxBytes()>>20))
	}
	content := []byte(merged)
	return s.resolve(key, theirsSHA, resolveMerged, content)
}

// KeepMine giữ bản của tôi (kể cả khi tôi đã xoá): gốc = bản của họ, lần Push sau ghi đè/xoá bản của họ có điều kiện.
func (s *Syncer) KeepMine(key, theirsSHA string) error {
	return s.resolve(key, theirsSHA, resolveKeepMine, nil)
}

// TakeTheirs lấy bản của họ (kể cả khi họ đã xoá) vào tệp làm việc; bản của họ luôn được kiểm lại và bị từ chối khi
// không qua (flow độc).
func (s *Syncer) TakeTheirs(key, theirsSHA string) error {
	return s.resolve(key, theirsSHA, resolveTakeTheirs, nil)
}

type resolveMode int

const (
	resolveMerged resolveMode = iota
	resolveKeepMine
	resolveTakeTheirs
)

// resolve chạy trọn dưới khoá đồng bộ: mở lại xung đột, so bản của họ với bản người dùng đã xem, kiểm nội dung sắp ghi,
// ghi tệp làm việc (tài liệu cũ vào lịch sử), lấy bản của họ làm gốc rồi đóng xung đột.
func (s *Syncer) resolve(key, theirsSHA string, mode resolveMode, merged []byte) error {
	done, err := s.begin()
	if err != nil {
		return err
	}
	defer done()
	if err := s.resetIfMoved(); err != nil {
		return err
	}
	r, m, theirs, err := s.openConflict(key)
	if err != nil {
		return err
	}
	if m.TheirsSHA256 != theirsSHA {
		return apperr.New(CodeConflictChanged, "bản của họ đã đổi sau khi mở màn gộp; mở lại xung đột "+key)
	}
	write, content := true, merged // write = true và content = nil ⇒ xoá tệp làm việc
	switch mode {
	case resolveKeepMine:
		write = false
	case resolveTakeTheirs:
		if !m.TheirsDeleted {
			content = theirs
			// Kiểm lại: bộ kiểm có thể đã nới (vd đã khai báo biến) hoặc siết, nhưng không bao giờ ghi bản chưa qua kiểm tra.
			if reason, detail := s.check(r, content); reason != "" {
				return apperr.New(apperr.CodeInvalid, fmt.Sprintf("bản của họ không qua kiểm tra (%s): %s", reason, truncate(detail, 500)))
			}
		}
	case resolveMerged:
		if reason, detail := s.check(r, content); reason != "" {
			return apperr.New(apperr.CodeInvalid, fmt.Sprintf("bản gộp không qua kiểm tra (%s): %s", reason, truncate(detail, 500)))
		}
	}
	st, err := s.loadState()
	if err != nil {
		return err
	}
	path, err := s.localPath(r)
	if err != nil {
		return err
	}
	if write {
		err := s.locker.WithLock(r.App, func() error {
			if _, err := s.localPath(r); err != nil {
				return err
			}
			if err := s.archiveDoc(r); err != nil {
				return err
			}
			if content == nil {
				return removeIfExists(path)
			}
			return writeAtomic(path, content)
		})
		if err != nil {
			return err
		}
	}
	// Gốc = bản của họ. Họ đã xoá ⇒ không còn gốc: tệp còn ở máy là local_new (PUT If-None-Match), không còn là đã khớp.
	if m.TheirsDeleted {
		if err := s.dropBase(st, r); err != nil {
			return err
		}
	} else if err := s.setBase(st, r, m.TheirsETag, theirs); err != nil {
		return err
	}
	if err := s.saveState(st); err != nil {
		return err
	}
	return s.clearConflict(r)
}

// hasMarkers: dòng bắt đầu bằng <<<<<<< hoặc >>>>>>> (kể cả trơ trọi, không nhãn), hoặc dòng chỉ có =======.
func hasMarkers(text string) bool {
	for line := range strings.SplitSeq(text, "\n") {
		line = strings.TrimRight(line, "\r")
		if strings.HasPrefix(line, "<<<<<<<") || strings.HasPrefix(line, ">>>>>>>") || line == "=======" {
			return true
		}
	}
	return false
}
