package teamsync

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"chatqa/internal/proc"
	"deskcore/apperr"
)

// Trạng thái máy ở <dataDir>/sync: state.json (bản gốc của từng khoá), base/<khoá> (văn bản gốc cho gộp 3-way),
// conflicts/<khoá> + <khoá>.meta.json (bản của họ khi xung đột). Không chứa khoá S3.

const (
	stateFile    = "state.json"
	baseSub      = "base"
	conflictsSub = "conflicts"
	metaSuffix   = ".meta.json"
	lockFile     = ".lock"
	stateVersion = 1
)

// BaseEntry: bản đã đồng bộ lần cuối của một khoá.
type BaseEntry struct {
	BaseETag   string    `json:"baseETag"`
	BaseSHA256 string    `json:"baseSha256"`
	SyncedAt   time.Time `json:"syncedAt"`
}

type syncState struct {
	Version int `json:"version"`
	// Remote: dấu vân tay kho (endpoint/bucket/prefix, không khoá) mà các bản gốc thuộc về.
	Remote   string               `json:"remote"`
	Files    map[string]BaseEntry `json:"files"`
	LastPush time.Time            `json:"lastPush,omitzero"`
	LastPull time.Time            `json:"lastPull,omitzero"`
	// moved: state.json ghi cho kho khác (đổi bucket, chuyển MinIO, đổi tổ chức) ⇒ mọi bản gốc và xung đột cũ vô hiệu.
	moved bool
}

// ConflictMeta: thông tin bản của họ đang giữ ở vùng xung đột.
type ConflictMeta struct {
	Key           string    `json:"key"`
	TheirsETag    string    `json:"theirsETag"`
	TheirsSHA256  string    `json:"theirsSha256"`
	TheirsDeleted bool      `json:"theirsDeleted"`
	Author        string    `json:"author"`
	Device        string    `json:"device"`
	Reason        string    `json:"reason,omitempty"` // trống = sửa trùng; invalid_flow / invalid_doc / ...
	Detail        string    `json:"detail,omitempty"` // lỗi kiểm tra (khi Reason khác trống)
	At            time.Time `json:"at"`
}

func sha256Hex(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

func (s *Syncer) syncDir() string { return filepath.Join(s.dataDir, "sync") }

func (s *Syncer) loadState() (*syncState, error) {
	st := &syncState{Version: stateVersion, Files: map[string]BaseEntry{}}
	b, err := os.ReadFile(filepath.Join(s.syncDir(), stateFile))
	if errors.Is(err, fs.ErrNotExist) {
		return st, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(b, st); err != nil {
		return nil, fmt.Errorf("state.json hỏng: %w", err)
	}
	if st.Files == nil {
		st.Files = map[string]BaseEntry{}
	}
	if st.Remote != s.fingerprint {
		// Bản gốc của kho khác không nói gì về kho này: coi như lần đồng bộ đầu (không bao giờ suy ra "người khác đã xoá").
		return &syncState{Version: stateVersion, Remote: s.fingerprint, Files: map[string]BaseEntry{}, moved: true}, nil
	}
	// Khoá lạ (sửa tay) bị bỏ để không dẫn đường ghi ra ngoài.
	for k := range st.Files {
		if _, err := parseKey(k); err != nil {
			delete(st.Files, k)
		}
	}
	return st, nil
}

func (s *Syncer) saveState(st *syncState) error {
	st.Remote = s.fingerprint
	b, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	return writeAtomic(filepath.Join(s.syncDir(), stateFile), append(b, '\n'))
}

// resetIfMoved (dưới begin): state.json thuộc kho khác ⇒ bỏ mọi bản gốc, văn bản gốc và xung đột cũ rồi ghi state mới,
// để lần quét sau đi đúng đường đồng bộ lần đầu (tệp ở máy là local_new hoặc gộp/xung đột với bản trên kho).
func (s *Syncer) resetIfMoved() error {
	st, err := s.loadState()
	if err != nil || !st.moved {
		return err
	}
	for _, sub := range []string{baseSub, conflictsSub} {
		if err := os.RemoveAll(filepath.Join(s.syncDir(), sub)); err != nil {
			return err
		}
	}
	st.moved = false
	return s.saveState(st)
}

// stateMoved: state.json thuộc kho khác (chưa dọn); xung đột cũ khi đó không còn hiệu lực.
func (s *Syncer) stateMoved() (bool, error) {
	st, err := s.loadState()
	if err != nil {
		return false, err
	}
	return st.moved, nil
}

// setBase ghi nhận bản gốc mới của khoá; content (văn bản) được lưu vào base/ cho gộp 3-way.
func (s *Syncer) setBase(st *syncState, r fileRef, etag string, content []byte) error {
	st.Files[r.Key] = BaseEntry{BaseETag: etag, BaseSHA256: sha256Hex(content), SyncedAt: s.now().UTC()}
	if !r.text() {
		return nil
	}
	p, err := s.syncPath(baseSub, r.Key)
	if err != nil {
		return err
	}
	return writeAtomic(p, content)
}

func (s *Syncer) dropBase(st *syncState, r fileRef) error {
	delete(st.Files, r.Key)
	p, err := s.syncPath(baseSub, r.Key)
	if err != nil {
		return err
	}
	return removeIfExists(p)
}

// baseText: văn bản gốc; chưa có ⇒ rỗng.
func (s *Syncer) baseText(r fileRef) ([]byte, error) {
	p, err := s.syncPath(baseSub, r.Key)
	if err != nil {
		return nil, err
	}
	b, err := os.ReadFile(p)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	return b, err
}

// saveConflict giữ bản của họ (theirs = nil khi phía xa đã xoá) ở vùng xung đột.
func (s *Syncer) saveConflict(r fileRef, theirs []byte, m ConflictMeta) error {
	m.Key, m.At = r.Key, s.now().UTC()
	p, err := s.syncPath(conflictsSub, r.Key)
	if err != nil {
		return err
	}
	if m.TheirsDeleted {
		if err := removeIfExists(p); err != nil {
			return err
		}
	} else {
		m.TheirsSHA256 = sha256Hex(theirs)
		if err := writeAtomic(p, theirs); err != nil {
			return err
		}
	}
	b, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	return writeAtomic(p+metaSuffix, append(b, '\n'))
}

// loadConflict: meta và bản của họ; không có xung đột ⇒ ok = false.
func (s *Syncer) loadConflict(r fileRef) (m ConflictMeta, theirs []byte, ok bool, err error) {
	p, err := s.syncPath(conflictsSub, r.Key)
	if err != nil {
		return m, nil, false, err
	}
	b, err := os.ReadFile(p + metaSuffix)
	if errors.Is(err, fs.ErrNotExist) {
		return m, nil, false, nil
	}
	if err != nil {
		return m, nil, false, err
	}
	if err := json.Unmarshal(b, &m); err != nil || m.Key != r.Key {
		return m, nil, false, fmt.Errorf("thông tin xung đột của %s hỏng", r.Key)
	}
	if !m.TheirsDeleted {
		if theirs, err = os.ReadFile(p); err != nil {
			return m, nil, false, fmt.Errorf("đọc bản của họ %s: %w", r.Key, err)
		}
	}
	return m, theirs, true, nil
}

func (s *Syncer) clearConflict(r fileRef) error {
	p, err := s.syncPath(conflictsSub, r.Key)
	if err != nil {
		return err
	}
	if err := removeIfExists(p + metaSuffix); err != nil {
		return err
	}
	return removeIfExists(p)
}

// conflictMetas: mọi xung đột đang mở, theo khoá.
func (s *Syncer) conflictMetas() (map[string]ConflictMeta, error) {
	root := filepath.Join(s.syncDir(), conflictsSub)
	out := map[string]ConflictMeta{}
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		if err != nil {
			return err
		}
		if d.IsDir() || !d.Type().IsRegular() || !strings.HasSuffix(p, metaSuffix) {
			return nil
		}
		rel, err := filepath.Rel(root, strings.TrimSuffix(p, metaSuffix))
		if err != nil {
			return nil
		}
		r, err := parseKey(filepath.ToSlash(rel))
		if err != nil {
			return nil // tệp lạ trong vùng xung đột: bỏ qua
		}
		m, _, ok, err := s.loadConflict(r)
		if err != nil || !ok {
			return nil
		}
		out[r.Key] = m
		return nil
	})
	return out, err
}

// begin giữ khoá đồng bộ (trong tiến trình và giữa các tiến trình) cho một lần đẩy/kéo/gộp; đang có lần khác ⇒ busy.
func (s *Syncer) begin() (func(), error) {
	if !s.mu.TryLock() {
		return nil, apperr.New("busy", "đang đồng bộ")
	}
	if err := os.MkdirAll(s.syncDir(), 0o755); err != nil {
		s.mu.Unlock()
		return nil, err
	}
	f, err := proc.LockFile(filepath.Join(s.syncDir(), lockFile))
	if err != nil {
		s.mu.Unlock()
		if errors.Is(err, proc.ErrLocked) {
			return nil, apperr.New("busy", "đang đồng bộ ở phiên khác")
		}
		return nil, err
	}
	return func() {
		f.Close()
		s.mu.Unlock()
	}, nil
}

// writeAtomic: ghi tệp tạm cùng thư mục rồi đổi tên.
func writeAtomic(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	_, err = f.Write(data)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Chmod(tmp, 0o644)
	}
	if err == nil {
		err = os.Rename(tmp, path)
	}
	if err != nil {
		_ = os.Remove(tmp)
	}
	return err
}

func removeIfExists(p string) error {
	if err := os.Remove(p); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}
