package teamsync

import (
	"bytes"
	"context"
	"errors"
	"io/fs"
	"os"
)

// PushResult: kết quả Push.
type PushResult struct {
	Pushed    []string    `json:"pushed"`    // đã ghi hoặc xoá trên kho
	Conflicts []string    `json:"conflicts"` // mọi khoá đang xung đột sau lần chạy (bị bỏ qua, gộp trong trang Đồng bộ)
	Skipped   []Skip      `json:"skipped"`
	Errors    []FileError `json:"errors"`
	Warnings  []Warning   `json:"warnings"`
}

// Push đẩy thay đổi của máy này: local_changed (PUT If-Match gốc), local_new (PUT If-None-Match *), local_deleted (xoá có
// điều kiện). Phía xa đã đổi (phát hiện lúc quét hoặc do 412) ⇒ bản của họ vào vùng xung đột, không ghi đè gì; riêng
// manifest được gộp theo khoá JSON rồi đẩy luôn bản gộp. Thay đổi chỉ ở phía xa bị bỏ qua (cần Kéo về).
func (s *Syncer) Push(ctx context.Context, apps []string) (PushResult, error) {
	done, err := s.begin()
	if err != nil {
		return PushResult{}, err
	}
	defer done()
	if err := s.resetIfMoved(); err != nil {
		return PushResult{}, err
	}
	snap, err := s.scan(ctx, apps)
	if err != nil {
		return PushResult{}, err
	}
	res := PushResult{Pushed: []string{}, Conflicts: []string{}, Skipped: []Skip{}, Errors: []FileError{}, Warnings: snap.warnings}
	st := snap.st
	for _, it := range snap.items {
		if err := ctx.Err(); err != nil {
			res.Errors = append(res.Errors, FileError{Key: it.ref.Key, Error: err.Error()})
			break
		}
		out, err := s.pushOne(ctx, st, it)
		switch {
		case errors.Is(err, errLocalMoved):
			res.Skipped = append(res.Skipped, Skip{Key: it.ref.Key, Reason: StateLocalChanged})
		case err != nil:
			res.Errors = append(res.Errors, FileError{Key: it.ref.Key, Error: err.Error()})
		case out == outPushed:
			res.Pushed = append(res.Pushed, it.ref.Key)
		case out == outConflict:
			res.Conflicts = append(res.Conflicts, it.ref.Key)
		case out == outMerged:
			// Đã gộp ở máy nhưng lại có người đẩy trước: lần Đẩy sau gửi tiếp.
			res.Skipped = append(res.Skipped, Skip{Key: it.ref.Key, Reason: StateLocalChanged})
		case out == outSkipped:
			res.Skipped = append(res.Skipped, Skip{Key: it.ref.Key, Reason: it.state})
		}
	}
	st.LastPush = s.now().UTC()
	if err := s.saveState(st); err != nil {
		return res, err
	}
	return res, nil
}

func (s *Syncer) pushOne(ctx context.Context, st *syncState, it *item) (outcome, error) {
	switch it.state {
	case "":
		return outNone, s.dropBase(st, it.ref)
	case StateSynced:
		return outNone, nil
	case StateConflict:
		return outConflict, nil
	case StateLocalNew:
		return s.put(ctx, st, it, PutCond{IfNoneMatch: "*"})
	case StateLocalChanged:
		return s.put(ctx, st, it, PutCond{IfMatch: it.base.BaseETag})
	case StateLocalDeleted:
		return s.del(ctx, st, it)
	case StateBothChanged:
		return s.pushAfterReconcile(ctx, st, it)
	}
	return outSkipped, nil // remote_*: cần Kéo về
}

// put đọc tệp làm việc và ghi có điều kiện. Kho không hỗ trợ điều kiện ⇒ HEAD so với gốc rồi PUT thường.
func (s *Syncer) put(ctx context.Context, st *syncState, it *item, cond PutCond) (outcome, error) {
	data, err := os.ReadFile(it.path)
	if errors.Is(err, fs.ErrNotExist) {
		return outNone, errLocalMoved
	}
	if err != nil {
		return outNone, err
	}
	if int64(len(data)) > it.ref.maxBytes() {
		return outSkipped, nil
	}
	key := s.remoteKey(it.ref.Key)
	if s.noCond {
		if err := s.headMatches(ctx, key, cond); err != nil {
			return s.remoteMoved(ctx, st, it, err)
		}
		cond = PutCond{}
	}
	etag, err := s.store.Put(ctx, key, bytes.NewReader(data), int64(len(data)), cond, s.meta(data))
	if errors.Is(err, ErrPrecondition) || errors.Is(err, ErrNotFound) {
		return s.remoteMoved(ctx, st, it, err)
	}
	if err != nil {
		return outNone, err
	}
	return outPushed, s.setBase(st, it.ref, etag, data)
}

// headMatches mô phỏng điều kiện bằng HEAD (cửa sổ đua nhỏ giữa HEAD và PUT).
func (s *Syncer) headMatches(ctx context.Context, key string, cond PutCond) error {
	o, err := s.store.Head(ctx, key)
	switch {
	case cond.IfNoneMatch == "*" && err == nil:
		return ErrPrecondition
	case cond.IfNoneMatch == "*" && errors.Is(err, ErrNotFound):
		return nil
	case err != nil:
		return err
	case cond.IfMatch != "" && o.ETag != cond.IfMatch:
		return ErrPrecondition
	}
	return nil
}

func (s *Syncer) del(ctx context.Context, st *syncState, it *item) (outcome, error) {
	if _, err := os.Stat(it.path); err == nil {
		return outNone, errLocalMoved // vừa được tạo lại
	}
	err := s.store.Delete(ctx, s.remoteKey(it.ref.Key), it.base.BaseETag)
	switch {
	case errors.Is(err, ErrNotFound):
		return outPushed, s.dropBase(st, it.ref) // phía xa cũng đã xoá
	case errors.Is(err, ErrPrecondition):
		return s.remoteMoved(ctx, st, it, err)
	case err != nil:
		return outNone, err
	}
	return outPushed, s.dropBase(st, it.ref)
}

// remoteMoved: phía xa đổi sau lúc quét (412 hoặc đã bị xoá) ⇒ đọc lại trạng thái phía xa rồi xử lý như hai bên cùng đổi.
func (s *Syncer) remoteMoved(ctx context.Context, st *syncState, it *item, cause error) (outcome, error) {
	if !errors.Is(cause, ErrPrecondition) && !errors.Is(cause, ErrNotFound) {
		return outNone, cause
	}
	o, err := s.store.Head(ctx, s.remoteKey(it.ref.Key))
	switch {
	case errors.Is(err, ErrNotFound):
		it.remote = nil
	case err != nil:
		return outNone, err
	default:
		it.remote = &o
	}
	if it.base == nil && it.remote == nil {
		// If-None-Match hỏng rồi đối tượng lại biến mất: đẩy lại ở lần sau.
		return outSkipped, nil
	}
	it.state = StateBothChanged
	return s.pushAfterReconcile(ctx, st, it)
}

// pushAfterReconcile: hai bên cùng đổi ⇒ reconcile; manifest gộp được thì đẩy bản gộp với If-Match bản của họ.
func (s *Syncer) pushAfterReconcile(ctx context.Context, st *syncState, it *item) (outcome, error) {
	out, theirsETag, err := s.reconcile(ctx, st, it)
	if err != nil || out != outMerged {
		if out == outSame {
			return outPushed, err
		}
		return out, err
	}
	merged, err := os.ReadFile(it.path)
	if err != nil {
		return outNone, err
	}
	it.local, it.localSHA = true, sha256Hex(merged)
	b := st.Files[it.ref.Key]
	it.base = &b
	it.state = StateLocalChanged
	key := s.remoteKey(it.ref.Key)
	cond := PutCond{IfMatch: theirsETag}
	if s.noCond {
		if err := s.headMatches(ctx, key, cond); err != nil {
			return outMerged, nil // lại có người đẩy: bản gộp nằm ở máy, lần sau đẩy tiếp
		}
		cond = PutCond{}
	}
	etag, err := s.store.Put(ctx, key, bytes.NewReader(merged), int64(len(merged)), cond, s.meta(merged))
	if errors.Is(err, ErrPrecondition) || errors.Is(err, ErrNotFound) {
		return outMerged, nil
	}
	if err != nil {
		return outNone, err
	}
	return outPushed, s.setBase(st, it.ref, etag, merged)
}
