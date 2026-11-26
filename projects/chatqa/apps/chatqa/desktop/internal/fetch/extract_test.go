package fetch

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// entry: một mục trong file nén thử. kind: f (file), d (thư mục), l (symlink), h (hardlink), c (thiết bị ký tự), p (fifo).
type entry struct {
	name, kind, body string
	mode             fs.FileMode
}

func writeZip(t *testing.T, entries []entry) string {
	t.Helper()
	var buf bytes.Buffer
	w := zip.NewWriter(&buf)
	for _, e := range entries {
		h := &zip.FileHeader{Name: e.name, Method: zip.Deflate}
		mode := e.mode
		switch e.kind {
		case "d":
			mode = fs.ModeDir | 0o755
		case "l":
			mode = fs.ModeSymlink | 0o777
		case "c":
			mode = fs.ModeDevice | fs.ModeCharDevice | 0o644
		case "p":
			mode = fs.ModeNamedPipe | 0o644
		}
		if mode == 0 {
			mode = 0o644
		}
		h.SetMode(mode)
		f, err := w.CreateHeader(h)
		if err != nil {
			t.Fatal(err)
		}
		f.Write([]byte(e.body))
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(t.TempDir(), "a.zip")
	if err := os.WriteFile(p, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func writeTgz(t *testing.T, entries []entry) string {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for _, e := range entries {
		h := &tar.Header{Name: e.name, Mode: int64(e.mode)}
		if h.Mode == 0 {
			h.Mode = 0o644
		}
		switch e.kind {
		case "f":
			h.Typeflag, h.Size = tar.TypeReg, int64(len(e.body))
		case "d":
			h.Typeflag, h.Mode = tar.TypeDir, 0o755
		case "l":
			h.Typeflag, h.Linkname = tar.TypeSymlink, e.body
		case "h":
			h.Typeflag, h.Linkname = tar.TypeLink, e.body
		case "c":
			h.Typeflag = tar.TypeChar
		case "p":
			h.Typeflag = tar.TypeFifo
		}
		if err := tw.WriteHeader(h); err != nil {
			t.Fatal(err)
		}
		if e.kind == "f" {
			tw.Write([]byte(e.body))
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	gz.Close()
	p := filepath.Join(t.TempDir(), "a.tgz")
	if err := os.WriteFile(p, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

var links = Options{AllowSymlinks: true}

func TestExtractCases(t *testing.T) {
	cases := []struct {
		name    string
		entries []entry
		opt     Options
		ok      bool
	}{
		{"file thường", []entry{{name: "a/b.txt", kind: "f", body: "x"}}, Options{}, true},
		{"../evil", []entry{{name: "a/../../evil", kind: "f"}}, links, false},
		{"đường dẫn tuyệt đối", []entry{{name: "/etc/evil", kind: "f"}}, links, false},
		{"tên có backslash", []entry{{name: `a\..\evil`, kind: "f"}}, links, false},
		{"tên ổ đĩa C:", []entry{{name: "C:/evil", kind: "f"}}, links, false},
		{"luồng dữ liệu phụ a:b", []entry{{name: "a:b", kind: "f"}}, links, false},
		{"symlink trong đích (Versions/Current)", []entry{
			{name: "F.framework/Versions/A/lib", kind: "f", body: "x"},
			{name: "F.framework/Versions/Current", kind: "l", body: "A"},
			{name: "F.framework/lib", kind: "l", body: "Versions/Current/lib"},
		}, links, true},
		{"symlink tuyệt đối", []entry{{name: "l", kind: "l", body: "/etc"}}, links, false},
		{"symlink ra ngoài đích", []entry{{name: "a/l", kind: "l", body: "../../x"}}, links, false},
		{"symlink nối chuỗi thoát ra ngoài", []entry{
			{name: "a/l", kind: "l", body: ".."},
			{name: "b", kind: "l", body: "a/l/../../x"},
		}, links, false},
		{"symlink tạo sau làm symlink trước thoát ra ngoài", []entry{
			{name: "b", kind: "l", body: "a/l/../x"}, // lúc tạo: a/l chưa là symlink, b = dest/a/x
			{name: "a/l", kind: "l", body: ".."},     // tự nó trong đích, nhưng biến b thành dest/../x
		}, links, false},
		{"ghi xuyên thư mục symlink", []entry{
			{name: "d", kind: "d"},
			{name: "l", kind: "l", body: "d"},
			{name: "l/x", kind: "f", body: "x"},
		}, links, false},
		{"symlink tạo trước đích của nó", []entry{
			{name: "Current", kind: "l", body: "A"},
			{name: "A/x", kind: "f", body: "x"},
		}, links, true},
		{"symlink lặp vòng", []entry{{name: "a", kind: "l", body: "a/x"}}, links, false},
		// Hệ tệp không phân biệt hoa thường: sub/A chính là symlink sub/a -> .., nên l trỏ hai cấp trên đích.
		{"symlink thoát ra ngoài qua tên khác hoa thường", []entry{
			{name: "sub/a", kind: "l", body: ".."},
			{name: "l", kind: "l", body: "sub/A/../.."},
		}, links, !foldCase},
		{"mục trùng lặp", []entry{
			{name: "a.txt", kind: "f", body: "1"},
			{name: "a.txt", kind: "f", body: "2"},
		}, links, false},
		{"thiết bị ký tự", []entry{{name: "dev", kind: "c"}}, links, false},
		{"fifo", []entry{{name: "pipe", kind: "p"}}, links, false},
		{"không cho symlink (chính sách bộ driver)", []entry{
			{name: "A/x", kind: "f", body: "x"},
			{name: "Current", kind: "l", body: "A"},
		}, Options{}, false},
	}
	for _, c := range cases {
		for _, format := range []string{"zip", "tgz"} {
			t.Run(format+"/"+c.name, func(t *testing.T) {
				if c.ok && runtime.GOOS == "windows" && c.opt.AllowSymlinks {
					t.Skip("tạo symlink trên Windows cần quyền developer mode")
				}
				dest := filepath.Join(t.TempDir(), "out")
				outside := filepath.Join(filepath.Dir(dest), "evil")
				var err error
				if format == "zip" {
					err = UnzipSafe(writeZip(t, c.entries), dest, c.opt)
				} else {
					err = UntarGz(writeTgz(t, c.entries), dest, c.opt)
				}
				if c.ok && err != nil {
					t.Fatalf("muốn giải nén được: %v", err)
				}
				if !c.ok && err == nil {
					t.Fatal("muốn bị từ chối")
				}
				if _, err := os.Lstat(outside); err == nil {
					t.Fatal("đã ghi ra ngoài thư mục đích")
				}
			})
		}
	}
}

func TestUntarGzRejectsHardlink(t *testing.T) {
	p := writeTgz(t, []entry{{name: "a", kind: "f", body: "x"}, {name: "b", kind: "h", body: "a"}})
	if err := UntarGz(p, filepath.Join(t.TempDir(), "out"), links); err == nil {
		t.Fatal("hardlink phải bị từ chối")
	}
}

func TestExtractKeepsExecutableMode(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows không có bit thực thi")
	}
	entries := []entry{{name: "bin/node", kind: "f", body: "#!", mode: 0o755}, {name: "LICENSE", kind: "f", body: "mit"}}
	for _, format := range []string{"zip", "tgz"} {
		dest := filepath.Join(t.TempDir(), "out")
		var err error
		if format == "zip" {
			err = UnzipSafe(writeZip(t, entries), dest, Options{})
		} else {
			err = UntarGz(writeTgz(t, entries), dest, Options{})
		}
		if err != nil {
			t.Fatal(err)
		}
		st, err := os.Stat(filepath.Join(dest, "bin", "node"))
		if err != nil || st.Mode().Perm() != 0o755 {
			t.Fatalf("%s: quyền %v, err %v", format, st.Mode(), err)
		}
	}
}

func TestExtractStripAndInclude(t *testing.T) {
	p := writeTgz(t, []entry{
		{name: "node-v1/", kind: "d"},
		{name: "node-v1/bin/node", kind: "f", body: "n", mode: 0o755},
		{name: "node-v1/bin/npm", kind: "l", body: "../lib/npm-cli.js"},
		{name: "node-v1/LICENSE", kind: "f", body: "mit"},
	})
	dest := filepath.Join(t.TempDir(), "out")
	only := map[string]bool{"bin/node": true, "LICENSE": true}
	if err := UntarGz(p, dest, Options{Strip: 1, Include: func(n string) bool { return only[n] }}); err != nil {
		t.Fatal(err) // symlink npm bị bỏ qua trước khi xét chính sách symlink
	}
	for _, n := range []string{"bin/node", "LICENSE"} {
		if _, err := os.Stat(filepath.Join(dest, filepath.FromSlash(n))); err != nil {
			t.Fatalf("thiếu %s", n)
		}
	}
	if _, err := os.Lstat(filepath.Join(dest, "bin", "npm")); err == nil {
		t.Fatal("mục không nằm trong Include không được giải nén")
	}
}

// Luật so đường dẫn theo chữ thường kiểm được trên mọi hệ điều hành: bật fold thì sub/A khớp symlink sub/a.
func TestSymlinkContainmentFoldsCase(t *testing.T) {
	dest := filepath.Join(t.TempDir(), "out")
	x := newExtractor(dest, links)
	x.fold = true
	if err := x.symlink("sub/a", ".."); err != nil {
		if runtime.GOOS == "windows" {
			t.Skip("tạo symlink trên Windows cần quyền developer mode")
		}
		t.Fatal(err)
	}
	if err := x.symlink("l", "sub/A/../.."); err == nil {
		t.Fatal("symlink thoát qua tên khác hoa thường phải bị từ chối")
	}
	if _, err := os.Lstat(filepath.Join(dest, "l")); err == nil {
		t.Fatal("symlink bị từ chối không được tạo trên đĩa")
	}
	if _, _, err := x.name("dir/f"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := x.name("DIR/F"); err == nil {
		t.Fatal("tên chỉ khác hoa thường là mục trùng lặp")
	}
}
