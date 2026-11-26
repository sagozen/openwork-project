package fetch

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
)

// Options: chính sách giải nén. Giá trị rỗng = chính sách chặt nhất (không symlink, giữ nguyên đường dẫn).
type Options struct {
	// AllowSymlinks: nhận symlink có đích (sau khi lần theo các symlink đã giải nén) vẫn nằm trong thư mục
	// đích. Gói .app/.framework của trình duyệt macOS cần (Versions/Current); bộ driver thì không.
	AllowSymlinks bool
	// Strip: bỏ n thành phần đầu của mỗi đường dẫn (npm: "package/", Node: "node-v<ver>-<os>-<arch>/").
	// Mục có ít thành phần hơn bị bỏ qua.
	Strip int
	// Include: chỉ giải nén mục có tên (sau Strip, dạng a/b) được nhận; nil = mọi mục.
	Include func(name string) bool
}

// Giới hạn độ dài đích symlink và số lần lần theo symlink lồng nhau.
const (
	maxLinkTarget = 4096
	maxLinkDepth  = 40
)

// UnzipSafe giải nén zipPath vào dest. dest phải là thư mục mới tạo (staging): mọi kiểm tra dựa trên việc
// chỉ chính lượt giải nén này ghi vào đó.
func UnzipSafe(zipPath, dest string, o Options) error {
	r, err := zip.OpenReader(zipPath)
	if err != nil {
		return err
	}
	defer r.Close()
	x := newExtractor(dest, o)
	for _, f := range r.File {
		rel, ok, err := x.name(f.Name)
		if err != nil || !ok {
			if err != nil {
				return err
			}
			continue
		}
		mode := f.Mode()
		switch {
		case f.FileInfo().IsDir():
			err = x.dir(rel)
		case mode&fs.ModeSymlink != 0:
			err = x.zipLink(rel, f)
		case mode.IsRegular():
			err = x.zipFile(rel, f, mode.Perm())
		default:
			err = fmt.Errorf("loại mục không được phép (%v): %s", mode.Type(), f.Name)
		}
		if err != nil {
			return err
		}
	}
	return x.finish()
}

// UntarGz giải nén file .tar.gz vào dest (cùng điều kiện dest như UnzipSafe). Chỉ nhận file thường,
// thư mục và symlink: hardlink, thiết bị ký tự/khối và fifo bị từ chối.
func UntarGz(tgzPath, dest string, o Options) error {
	f, err := os.Open(tgzPath)
	if err != nil {
		return err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	x := newExtractor(dest, o)
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return err
		}
		if h.Typeflag == tar.TypeXGlobalHeader { // chỉ là siêu dữ liệu pax, không có nội dung
			continue
		}
		rel, ok, err := x.name(h.Name)
		if err != nil {
			return err
		}
		if !ok {
			continue
		}
		switch h.Typeflag {
		case tar.TypeDir:
			err = x.dir(rel)
		case tar.TypeReg, tar.TypeRegA: //nolint:staticcheck // TypeRegA vẫn có trong file nén cũ
			err = x.file(rel, tr, fs.FileMode(h.Mode).Perm())
		case tar.TypeSymlink:
			err = x.symlink(rel, h.Linkname)
		default:
			err = fmt.Errorf("loại mục không được phép (%q): %s", h.Typeflag, h.Name)
		}
		if err != nil {
			return err
		}
	}
	return x.finish()
}

type extractor struct {
	dest  string
	o     Options
	fold  bool              // hệ tệp không phân biệt hoa thường: so đường dẫn theo chữ thường
	seen  map[string]bool   // theo key(rel)
	links map[string]string // key(đường dẫn tương đối của symlink) -> đích (dạng a/b)
}

// foldCase: APFS (mặc định) và NTFS không phân biệt hoa thường, nên sub/A và sub/a là cùng một mục trên đĩa.
var foldCase = runtime.GOOS == "darwin" || runtime.GOOS == "windows"

func newExtractor(dest string, o Options) *extractor {
	return &extractor{dest: dest, o: o, fold: foldCase, seen: map[string]bool{}, links: map[string]string{}}
}

// key: khoá so sánh của đường dẫn tương đối, cùng cách hệ tệp đích coi hai tên là một.
func (x *extractor) key(rel string) string {
	if x.fold {
		return strings.ToLower(rel)
	}
	return rel
}

// name kiểm tra tên mục và trả đường dẫn tương đối (dạng a/b) sau Strip; ok=false nghĩa là bỏ qua.
// Tên chứa "\", ":" (ổ đĩa, luồng dữ liệu phụ NTFS) hoặc ".." bị từ chối trên mọi hệ điều hành.
func (x *extractor) name(raw string) (string, bool, error) {
	if strings.ContainsAny(raw, `\:`) || strings.HasPrefix(raw, "/") {
		return "", false, fmt.Errorf("tên mục không hợp lệ: %s", raw)
	}
	var parts []string
	for _, p := range strings.Split(raw, "/") {
		switch p {
		case "", ".":
			continue
		case "..":
			return "", false, fmt.Errorf("đường dẫn ngoài thư mục đích: %s", raw)
		}
		parts = append(parts, p)
	}
	if len(parts) <= x.o.Strip {
		return "", false, nil
	}
	rel := strings.Join(parts[x.o.Strip:], "/")
	if x.o.Include != nil && !x.o.Include(rel) {
		return "", false, nil
	}
	if x.seen[x.key(rel)] {
		return "", false, fmt.Errorf("mục trùng lặp: %s", raw)
	}
	x.seen[x.key(rel)] = true
	return rel, true, nil
}

func (x *extractor) path(rel string) string { return filepath.Join(x.dest, filepath.FromSlash(rel)) }

// parents tạo các thư mục cha của rel, từ chối nếu một thư mục cha có sẵn trên đĩa là symlink
// (ghi xuyên symlink có thể ra ngoài dest) hoặc không phải thư mục.
func (x *extractor) parents(rel string) error {
	dir := path.Dir(rel)
	if dir == "." {
		return os.MkdirAll(x.dest, 0o755)
	}
	cur := x.dest
	for _, p := range strings.Split(dir, "/") {
		cur = filepath.Join(cur, p)
		st, err := os.Lstat(cur)
		if errors.Is(err, fs.ErrNotExist) {
			break // phần còn lại chưa tồn tại, nên không thể là symlink
		}
		if err != nil {
			return err
		}
		if st.Mode()&fs.ModeSymlink != 0 {
			return fmt.Errorf("ghi xuyên qua symlink: %s", rel)
		}
		if !st.IsDir() {
			return fmt.Errorf("thư mục cha là file: %s", rel)
		}
	}
	return os.MkdirAll(filepath.Dir(x.path(rel)), 0o755)
}

func (x *extractor) dir(rel string) error {
	if err := x.parents(rel); err != nil {
		return err
	}
	target := x.path(rel)
	if st, err := os.Lstat(target); err == nil && !st.IsDir() {
		return fmt.Errorf("thư mục trùng với mục khác: %s", rel)
	}
	return os.MkdirAll(target, 0o755)
}

// file tạo file mới bằng O_CREATE|O_EXCL và không theo symlink, nên mục trùng (kể cả khác hoa thường
// trên ổ không phân biệt hoa thường) hay symlink có sẵn đều làm lượt giải nén thất bại.
func (x *extractor) file(rel string, r io.Reader, perm fs.FileMode) error {
	if err := x.parents(rel); err != nil {
		return err
	}
	target := x.path(rel)
	if _, err := os.Lstat(target); err == nil { // Windows không có O_NOFOLLOW: kiểm tra trước khi tạo
		return fmt.Errorf("mục trùng lặp: %s", rel)
	}
	out, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY|openNoFollow, perm|0o600)
	if err != nil {
		return err
	}
	_, err = io.Copy(out, r)
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	return err
}

func (x *extractor) zipFile(rel string, f *zip.File, perm fs.FileMode) error {
	rc, err := f.Open()
	if err != nil {
		return err
	}
	defer rc.Close()
	return x.file(rel, rc, perm)
}

func (x *extractor) zipLink(rel string, f *zip.File) error {
	if !x.o.AllowSymlinks {
		return fmt.Errorf("file nén không được chứa symlink: %s", f.Name)
	}
	rc, err := f.Open()
	if err != nil {
		return err
	}
	defer rc.Close()
	b, err := io.ReadAll(io.LimitReader(rc, maxLinkTarget+1))
	if err != nil {
		return err
	}
	if len(b) > maxLinkTarget {
		return fmt.Errorf("đích symlink quá dài: %s", f.Name)
	}
	return x.symlink(rel, string(b))
}

func (x *extractor) symlink(rel, target string) error {
	if !x.o.AllowSymlinks {
		return fmt.Errorf("file nén không được chứa symlink: %s", rel)
	}
	if target == "" || strings.ContainsAny(target, `\:`) || strings.HasPrefix(target, "/") {
		return fmt.Errorf("đích symlink không hợp lệ: %s -> %s", rel, target)
	}
	x.links[x.key(rel)] = target
	if _, err := x.resolve(rel); err != nil {
		delete(x.links, x.key(rel))
		return err
	}
	if err := x.parents(rel); err != nil {
		return err
	}
	return os.Symlink(filepath.FromSlash(target), x.path(rel))
}

// resolve lần theo đích của symlink rel qua mọi symlink đã giải nén (không xét theo chuỗi), lỗi nếu
// đường đi ra khỏi dest ở bất kỳ bước nào. Ví dụ a/l -> .. rồi b -> a/l/../../x: theo chuỗi thì b là
// dest/x, nhưng thật ra b trỏ ra ngoài dest.
func (x *extractor) resolve(rel string) ([]string, error) {
	parent := splitRel(path.Dir(rel))
	return x.walk(parent, x.links[x.key(rel)], rel, 0)
}

func (x *extractor) walk(cur []string, target, link string, depth int) ([]string, error) {
	if depth > maxLinkDepth {
		return nil, fmt.Errorf("symlink lặp vòng: %s", link)
	}
	for _, c := range strings.Split(target, "/") {
		switch c {
		case "", ".":
			continue
		case "..":
			if len(cur) == 0 {
				return nil, fmt.Errorf("symlink trỏ ra ngoài thư mục đích: %s -> %s", link, x.links[x.key(link)])
			}
			cur = cur[:len(cur)-1]
			continue
		}
		cur = append(cur[:len(cur):len(cur)], c)
		if t, ok := x.links[x.key(strings.Join(cur, "/"))]; ok {
			var err error
			if cur, err = x.walk(cur[:len(cur)-1:len(cur)-1], t, link, depth+1); err != nil {
				return nil, err
			}
		}
	}
	return cur, nil
}

// finish kiểm tra lại mọi symlink với toàn bộ symlink đã giải nén: một symlink tạo sau có thể biến
// đường đi của symlink tạo trước thành đường thoát ra ngoài.
func (x *extractor) finish() error {
	names := make([]string, 0, len(x.links))
	for rel := range x.links {
		names = append(names, rel)
	}
	sort.Strings(names)
	for _, rel := range names {
		if _, err := x.resolve(rel); err != nil {
			return err
		}
	}
	return nil
}

func splitRel(rel string) []string {
	if rel == "." || rel == "" {
		return nil
	}
	return strings.Split(rel, "/")
}
