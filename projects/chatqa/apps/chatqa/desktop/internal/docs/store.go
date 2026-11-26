// Package docs: kho tài liệu nghiệp vụ (PRD/BRD/URD/SRS/AC) dạng Markdown theo app, mã yêu cầu ổn định, lịch sử bản sửa
// và ghi chú "nguồn có thể sai". Gói lá: không import testengine.
package docs

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"deskcore/apperr"
)

// Bố cục: <dir>/<app>/<docId>.md, <dir>/<app>/.history/<docId>/<rev>.md, <dir>/<app>/notes/<noteId>.json.

// MaxHistory: số bản cũ giữ lại cho mỗi tài liệu.
const MaxHistory = 50

const historyDir = ".history"

var (
	appNameRe = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)
	docIDRe   = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)
)

// Store: kho tài liệu dưới một thư mục gốc. Mọi lần ghi chạy dưới mu.
type Store struct {
	dir string
	mu  sync.Mutex
}

// DocInfo: một dòng trong danh sách tài liệu.
type DocInfo struct {
	ID        string    `json:"id"`
	Type      string    `json:"type"`
	Title     string    `json:"title"`
	Rev       int       `json:"rev"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// Revision: một bản trong lịch sử (Current = bản đang dùng).
type Revision struct {
	Rev     int       `json:"rev"`
	At      time.Time `json:"at"`
	Size    int64     `json:"size"`
	Current bool      `json:"current"`
}

// ReqIndex: mọi yêu cầu của một app; Duplicates là các mã xuất hiện hơn một lần (vd trùng sau khi kéo về).
type ReqIndex struct {
	Reqs       []Requirement `json:"reqs"`
	Duplicates []string      `json:"duplicates"`
}

// NewStore tạo kho tại dir (thư mục được tạo khi ghi lần đầu).
func NewStore(dir string) *Store { return &Store{dir: dir} }

// WithLock chạy fn dưới khoá ghi của kho (cho đồng bộ ghi tệp trực tiếp). fn không được gọi lại hàm ghi của Store.
func (s *Store) WithLock(fn func() error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return fn()
}

func (s *Store) appDir(app string) (string, error) {
	if !appNameRe.MatchString(app) {
		return "", apperr.New(apperr.CodeInvalid, fmt.Sprintf("tên app %q chỉ gồm chữ thường, số, . _ -", app))
	}
	return filepath.Join(s.dir, app), nil
}

func (s *Store) docPath(app, id string) (string, error) {
	dir, err := s.appDir(app)
	if err != nil {
		return "", err
	}
	if !docIDRe.MatchString(id) {
		return "", apperr.New(apperr.CodeInvalid, fmt.Sprintf("mã tài liệu %q chỉ gồm chữ thường, số, gạch nối (tối đa 64)", id))
	}
	return filepath.Join(dir, id+".md"), nil
}

func readDocFile(path string) (string, error) {
	st, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	if st.Size() > MaxDocBytes {
		return "", apperr.New(apperr.CodeInvalid, fmt.Sprintf("tệp %s quá giới hạn %d byte", filepath.Base(path), MaxDocBytes))
	}
	b, err := os.ReadFile(path)
	return string(b), err
}

func notFound(app, id string) error {
	return apperr.New(apperr.CodeNotFound, fmt.Sprintf("tài liệu %q của app %q", id, app))
}

// List trả các tài liệu của app, sắp theo mã. App chưa có tài liệu ⇒ danh sách rỗng.
func (s *Store) List(app string) ([]DocInfo, error) {
	ids, dir, err := s.docIDs(app)
	if err != nil {
		return nil, err
	}
	out := make([]DocInfo, 0, len(ids))
	for _, id := range ids {
		path := filepath.Join(dir, id+".md")
		text, err := readDocFile(path)
		if err != nil {
			return nil, fmt.Errorf("đọc tài liệu %q: %w", id, err)
		}
		p, err := parse(text)
		if err != nil {
			return nil, fmt.Errorf("tài liệu %q: %w", id, err)
		}
		info := DocInfo{ID: id, Type: p.typ, Title: p.title, Rev: p.rev}
		if st, err := os.Stat(path); err == nil {
			info.UpdatedAt = st.ModTime()
		}
		out = append(out, info)
	}
	return out, nil
}

// docIDs: mã các tài liệu hợp lệ trong thư mục app, đã sắp.
func (s *Store) docIDs(app string) ([]string, string, error) {
	dir, err := s.appDir(app)
	if err != nil {
		return nil, "", err
	}
	entries, err := os.ReadDir(dir)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, dir, nil
	}
	if err != nil {
		return nil, "", err
	}
	var ids []string
	for _, e := range entries {
		id, ok := strings.CutSuffix(e.Name(), ".md")
		if ok && e.Type().IsRegular() && docIDRe.MatchString(id) {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	return ids, dir, nil
}

// Get đọc một tài liệu kèm các yêu cầu đã phân tích.
func (s *Store) Get(app, id string) (Doc, error) {
	path, err := s.docPath(app, id)
	if err != nil {
		return Doc{}, err
	}
	text, err := readDocFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return Doc{}, notFound(app, id)
	}
	if err != nil {
		return Doc{}, err
	}
	return docFrom(id, text)
}

func docFrom(id, text string) (Doc, error) {
	d, err := Parse(text)
	if err != nil {
		return Doc{}, err
	}
	d.ID = id
	for i := range d.Requirements {
		d.Requirements[i].Doc = id
	}
	return d, nil
}

// Requirements trả mọi yêu cầu của app (theo mã tài liệu rồi theo dòng) và các mã trùng.
func (s *Store) Requirements(app string) (ReqIndex, error) {
	all, err := s.loadAll(app, "")
	if err != nil {
		return ReqIndex{}, err
	}
	idx := ReqIndex{Reqs: []Requirement{}, Duplicates: []string{}}
	count := map[string]int{}
	for _, d := range all {
		for _, r := range d.reqs {
			r.Doc = d.id
			idx.Reqs = append(idx.Reqs, r)
			count[r.ID]++
		}
	}
	for id, n := range count {
		if n > 1 {
			idx.Duplicates = append(idx.Duplicates, id)
		}
	}
	sort.Strings(idx.Duplicates)
	return idx, nil
}

type loadedDoc struct {
	id string
	*parsed
}

// loadAll đọc mọi tài liệu của app trừ except.
func (s *Store) loadAll(app, except string) ([]loadedDoc, error) {
	ids, dir, err := s.docIDs(app)
	if err != nil {
		return nil, err
	}
	out := make([]loadedDoc, 0, len(ids))
	for _, id := range ids {
		if id == except {
			continue
		}
		text, err := readDocFile(filepath.Join(dir, id+".md"))
		if errors.Is(err, fs.ErrNotExist) {
			continue // vừa bị xoá giữa lúc liệt kê
		}
		if err != nil {
			return nil, fmt.Errorf("đọc tài liệu %q: %w", id, err)
		}
		p, err := parse(text)
		if err != nil {
			return nil, fmt.Errorf("tài liệu %q: %w", id, err)
		}
		out = append(out, loadedDoc{id, p})
	}
	return out, nil
}

// Save ghi tài liệu: tự gán mã cho tiêu đề chưa có neo (số lớn nhất của tiền tố trong cả app + 1), tăng rev, chép bản
// cũ vào lịch sử. Front-matter thiếu type/title thì giữ của bản đang có (tài liệu mới: type other, title = tiêu đề cấp 1
// hoặc mã tài liệu). Mã trùng trong tài liệu hoặc với tài liệu khác của app bị từ chối.
func (s *Store) Save(app, id, markdown string) (Doc, error) {
	path, err := s.docPath(app, id)
	if err != nil {
		return Doc{}, err
	}
	p, err := parse(markdown)
	if err != nil {
		return Doc{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	others, err := s.loadAll(app, id)
	if err != nil {
		return Doc{}, err
	}
	next := map[string]int{}
	owner := map[string]Requirement{} // mã ⇒ yêu cầu ở tài liệu khác
	for _, d := range others {
		for _, r := range d.reqs {
			bumpMax(next, r.ID)
			if _, ok := owner[r.ID]; !ok {
				r.Doc = d.id
				owner[r.ID] = r
			}
		}
	}
	// Bản đang có: mã cũ vẫn tính vào số lớn nhất để mã đã xoá không bị cấp lại. Bản hỏng (sửa tay) vẫn được thay và lưu
	// vào lịch sử, chỉ không lấy được type/title/mã.
	var old *parsed
	oldText, err := readDocFile(path)
	exists := err == nil
	switch {
	case exists:
		if op, perr := parse(oldText); perr == nil {
			old = op
			for _, r := range op.reqs {
				bumpMax(next, r.ID)
			}
		}
	case !errors.Is(err, fs.ErrNotExist):
		return Doc{}, err
	}
	seen := map[string]int{}
	for _, r := range p.reqs {
		if line, ok := seen[r.ID]; ok {
			return Doc{}, apperr.New(apperr.CodeInvalid, fmt.Sprintf("mã %s trùng trong tài liệu %q (dòng %d và %d)", r.ID, id, line, r.Line))
		}
		seen[r.ID] = r.Line
		if o, ok := owner[r.ID]; ok {
			return Doc{}, apperr.New(apperr.CodeInvalid, fmt.Sprintf("mã %s ở tài liệu %q (dòng %d) trùng với tài liệu %q (dòng %d); đổi mã ở một bên", r.ID, id, r.Line, o.Doc, o.Line))
		}
		bumpMax(next, r.ID)
	}

	if !p.hasType && old != nil {
		p.typ = old.typ
	}
	if !p.hasTitle {
		switch {
		case old != nil:
			p.title = old.title
		case p.h1 != "":
			p.title = p.h1
		default:
			p.title = id
		}
	}
	if err := p.assign(next); err != nil {
		return Doc{}, err
	}
	hist := filepath.Join(filepath.Dir(path), historyDir, id)
	maxHist, err := maxHistoryRev(hist)
	if err != nil {
		return Doc{}, err
	}
	// Bản cũ vào lịch sử với rev của nó; rev không mới hơn lịch sử (sửa tay, hỏng) thì lấy số kế tiếp để không đè bản cũ.
	oldRev := maxHist + 1
	if old != nil && old.rev > maxHist {
		oldRev = old.rev
	}
	p.rev = maxHist + 1
	if exists {
		p.rev = oldRev + 1
	}
	out := p.render()
	if len(out) > MaxDocBytes {
		return Doc{}, apperr.New(apperr.CodeInvalid, fmt.Sprintf("tài liệu sau khi gắn mã quá giới hạn %d byte", MaxDocBytes))
	}
	if exists {
		if err := archive(path, hist, oldRev); err != nil {
			return Doc{}, err
		}
	}
	if err := writeAtomic(path, []byte(out), 0o644); err != nil {
		return Doc{}, fmt.Errorf("ghi tài liệu %q: %w", id, err)
	}
	return docFrom(id, out)
}

func bumpMax(next map[string]int, id string) {
	if prefix, n, ok := splitID(id); ok && n > next[prefix] {
		next[prefix] = n
	}
}

// archive chép tệp hiện tại vào lịch sử với tên <rev>.md rồi bỏ bớt bản cũ quá MaxHistory.
func archive(path, hist string, rev int) error {
	cur, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("đọc bản cũ: %w", err)
	}
	if err := writeAtomic(filepath.Join(hist, strconv.Itoa(rev)+".md"), cur, 0o644); err != nil {
		return fmt.Errorf("lưu lịch sử: %w", err)
	}
	revs, err := historyRevs(hist)
	if err != nil {
		return err
	}
	for len(revs) > MaxHistory {
		if err := os.Remove(filepath.Join(hist, strconv.Itoa(revs[0])+".md")); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return fmt.Errorf("dọn lịch sử: %w", err)
		}
		revs = revs[1:]
	}
	return nil
}

// historyRevs: các rev trong thư mục lịch sử, tăng dần.
func historyRevs(hist string) ([]int, error) {
	entries, err := os.ReadDir(hist)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var revs []int
	for _, e := range entries {
		name, ok := strings.CutSuffix(e.Name(), ".md")
		if !ok || !e.Type().IsRegular() {
			continue
		}
		if n, err := strconv.Atoi(name); err == nil && n >= 0 {
			revs = append(revs, n)
		}
	}
	sort.Ints(revs)
	return revs, nil
}

func maxHistoryRev(hist string) (int, error) {
	revs, err := historyRevs(hist)
	if err != nil || len(revs) == 0 {
		return 0, err
	}
	return revs[len(revs)-1], nil
}

// Delete xoá tài liệu; bản cuối được chép vào lịch sử để còn khôi phục, và lần tạo lại tiếp tục đánh số rev.
func (s *Store) Delete(app, id string) error {
	path, err := s.docPath(app, id)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	archived, err := archiveCurrent(path, id)
	if err != nil {
		return err
	}
	if !archived {
		return notFound(app, id)
	}
	return os.Remove(path)
}

// ArchiveCurrent chép bản đang có của tài liệu <dir>/<app>/<id>.md vào lịch sử (cùng tên rev và giới hạn MaxHistory như
// Save/Delete) trước khi đồng bộ nhóm ghi đè hay xoá tệp trực tiếp. Không có tệp ⇒ không làm gì. Không giữ khoá:
// người gọi phải đang ở trong WithLock của kho dùng thư mục dir.
func ArchiveCurrent(dir, app, id string) error {
	path, err := (&Store{dir: dir}).docPath(app, id)
	if err != nil {
		return err
	}
	_, err = archiveCurrent(path, id)
	return err
}

// archiveCurrent: chép tệp hiện tại vào lịch sử với rev của nó (rev không mới hơn lịch sử ⇒ số kế tiếp); archived =
// false khi tệp không có.
func archiveCurrent(path, id string) (archived bool, err error) {
	text, err := readDocFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	rev := 0
	if p, perr := parse(text); perr == nil {
		rev = p.rev
	}
	hist := filepath.Join(filepath.Dir(path), historyDir, id)
	maxHist, err := maxHistoryRev(hist)
	if err != nil {
		return false, err
	}
	if rev <= maxHist {
		rev = maxHist + 1
	}
	return true, archive(path, hist, rev)
}

// History trả các bản của tài liệu, mới nhất trước (bản đang dùng có Current).
func (s *Store) History(app, id string) ([]Revision, error) {
	path, err := s.docPath(app, id)
	if err != nil {
		return nil, err
	}
	hist := filepath.Join(filepath.Dir(path), historyDir, id)
	revs, err := historyRevs(hist)
	if err != nil {
		return nil, err
	}
	out := []Revision{}
	if text, err := readDocFile(path); err == nil {
		cur := Revision{Current: true, Size: int64(len(text))}
		if p, perr := parse(text); perr == nil {
			cur.Rev = p.rev
		}
		if st, err := os.Stat(path); err == nil {
			cur.At = st.ModTime()
		}
		out = append(out, cur)
	} else if !errors.Is(err, fs.ErrNotExist) {
		return nil, err
	}
	for k := len(revs) - 1; k >= 0; k-- {
		st, err := os.Stat(filepath.Join(hist, strconv.Itoa(revs[k])+".md"))
		if err != nil {
			continue // bị dọn giữa lúc liệt kê
		}
		out = append(out, Revision{Rev: revs[k], At: st.ModTime(), Size: st.Size()})
	}
	if len(out) == 0 {
		return nil, notFound(app, id)
	}
	return out, nil
}

// Revision đọc nội dung một bản (bản đang dùng hoặc trong lịch sử).
func (s *Store) Revision(app, id string, rev int) (string, error) {
	path, err := s.docPath(app, id)
	if err != nil {
		return "", err
	}
	if text, err := readDocFile(path); err == nil {
		if p, perr := parse(text); perr == nil && p.rev == rev {
			return text, nil
		}
	} else if !errors.Is(err, fs.ErrNotExist) {
		return "", err
	}
	if rev < 0 {
		return "", apperr.New(apperr.CodeInvalid, fmt.Sprintf("rev %d không hợp lệ", rev))
	}
	text, err := readDocFile(filepath.Join(filepath.Dir(path), historyDir, id, strconv.Itoa(rev)+".md"))
	if errors.Is(err, fs.ErrNotExist) {
		return "", apperr.New(apperr.CodeNotFound, fmt.Sprintf("bản %d của tài liệu %q", rev, id))
	}
	return text, err
}

// writeAtomic: ghi tệp tạm cùng thư mục rồi đổi tên, để người đọc không bao giờ thấy tệp ghi dở.
func writeAtomic(path string, data []byte, perm os.FileMode) error {
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
		err = os.Chmod(tmp, perm)
	}
	if err == nil {
		err = os.Rename(tmp, path)
	}
	if err != nil {
		_ = os.Remove(tmp)
	}
	return err
}
