package docs

import (
	"crypto/rand"
	"encoding/base32"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"deskcore/apperr"
)

// Ghi chú "nguồn có thể sai": mỗi ghi chú một tệp <dir>/<app>/notes/<id>.json, để hai máy thêm ghi chú không bao giờ
// sửa cùng một tệp khi đồng bộ.

// Trạng thái ghi chú.
const (
	NoteOpen     = "open"
	NoteResolved = "resolved"
)

const (
	notesDir     = "notes"
	maxNoteText  = 4000
	maxNoteField = 200
	maxNoteBytes = 64 << 10
)

var (
	noteIDRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)
	noteB32  = base32.StdEncoding.WithPadding(base32.NoPadding)
)

// Note: ghi chú gắn vào một yêu cầu, thường mở từ một lượt chạy lỗi.
type Note struct {
	ID     string    `json:"id"`
	Req    string    `json:"req"`
	RunID  string    `json:"runId"`
	Flow   string    `json:"flow"`
	Text   string    `json:"text"`
	Author string    `json:"author"`
	At     time.Time `json:"at"`
	Status string    `json:"status"`
}

func (s *Store) notesPath(app, id string) (string, error) {
	dir, err := s.appDir(app)
	if err != nil {
		return "", err
	}
	if !noteIDRe.MatchString(id) {
		return "", apperr.New(apperr.CodeInvalid, fmt.Sprintf("mã ghi chú %q không hợp lệ", id))
	}
	return filepath.Join(dir, notesDir, id+".json"), nil
}

// Notes trả ghi chú của app, mới nhất trước. Tệp hỏng (vd kéo về lỗi) bị bỏ qua để không chặn cả danh sách.
func (s *Store) Notes(app string) ([]Note, error) {
	dir, err := s.appDir(app)
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(filepath.Join(dir, notesDir))
	if errors.Is(err, fs.ErrNotExist) {
		return []Note{}, nil
	}
	if err != nil {
		return nil, err
	}
	out := []Note{}
	for _, e := range entries {
		id, ok := strings.CutSuffix(e.Name(), ".json")
		if !ok || !e.Type().IsRegular() || !noteIDRe.MatchString(id) {
			continue
		}
		n, err := readNote(filepath.Join(dir, notesDir, e.Name()))
		if err != nil || n.ID != id {
			continue
		}
		out = append(out, n)
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].At.Equal(out[j].At) {
			return out[i].At.After(out[j].At)
		}
		return out[i].ID < out[j].ID
	})
	return out, nil
}

func readNote(path string) (Note, error) {
	st, err := os.Stat(path)
	if err != nil {
		return Note{}, err
	}
	if st.Size() > maxNoteBytes {
		return Note{}, apperr.New(apperr.CodeInvalid, "ghi chú quá lớn")
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return Note{}, err
	}
	var n Note
	if err := json.Unmarshal(b, &n); err != nil {
		return Note{}, err
	}
	return n, nil
}

// AddNote lưu ghi chú mới (mã, thời điểm, trạng thái open do kho gán). Req phải là mã yêu cầu hợp lệ; Author do bên gọi điền.
func (s *Store) AddNote(app string, n Note) (Note, error) {
	n.Req, n.Text = strings.TrimSpace(n.Req), strings.TrimSpace(n.Text)
	if !reqIDRe.MatchString(n.Req) {
		return Note{}, apperr.New(apperr.CodeInvalid, fmt.Sprintf("mã yêu cầu %q sai dạng", n.Req))
	}
	if n.Text == "" {
		return Note{}, apperr.New(apperr.CodeInvalid, "ghi chú trống")
	}
	if utf8.RuneCountInString(n.Text) > maxNoteText {
		return Note{}, apperr.New(apperr.CodeInvalid, fmt.Sprintf("ghi chú dài quá %d ký tự", maxNoteText))
	}
	for name, v := range map[string]string{"runId": n.RunID, "flow": n.Flow, "author": n.Author} {
		if len(v) > maxNoteField || strings.ContainsAny(v, "\r\n") {
			return Note{}, apperr.New(apperr.CodeInvalid, fmt.Sprintf("%s không hợp lệ", name))
		}
	}
	id, err := newNoteID()
	if err != nil {
		return Note{}, err
	}
	n.ID, n.At, n.Status = id, time.Now().UTC(), NoteOpen
	path, err := s.notesPath(app, id)
	if err != nil {
		return Note{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := writeNote(path, n); err != nil {
		return Note{}, err
	}
	return n, nil
}

// ResolveNote đánh dấu ghi chú đã xử lý.
func (s *Store) ResolveNote(app, id string) (Note, error) {
	path, err := s.notesPath(app, id)
	if err != nil {
		return Note{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	n, err := readNote(path)
	if errors.Is(err, fs.ErrNotExist) {
		return Note{}, apperr.New(apperr.CodeNotFound, fmt.Sprintf("ghi chú %q của app %q", id, app))
	}
	if err != nil {
		return Note{}, fmt.Errorf("đọc ghi chú %q: %w", id, err)
	}
	if n.Status == NoteResolved {
		return n, nil
	}
	n.Status = NoteResolved
	if err := writeNote(path, n); err != nil {
		return Note{}, err
	}
	return n, nil
}

func writeNote(path string, n Note) error {
	b, err := json.MarshalIndent(n, "", "  ")
	if err != nil {
		return err
	}
	if err := writeAtomic(path, append(b, '\n'), 0o644); err != nil {
		return fmt.Errorf("ghi ghi chú: %w", err)
	}
	return nil
}

// newNoteID: thời điểm (để sắp theo tên) + phần ngẫu nhiên để hai máy không trùng.
func newNoteID() (string, error) {
	var b [5]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("sinh mã ghi chú: %w", err)
	}
	return time.Now().UTC().Format("20060102t150405") + "-" + strings.ToLower(noteB32.EncodeToString(b[:])), nil
}
