package docs

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"deskcore/apperr"
)

func reqIDs(reqs []Requirement) []string {
	ids := make([]string, len(reqs))
	for i, r := range reqs {
		ids[i] = r.ID
	}
	return ids
}

func TestParse(t *testing.T) {
	cases := []struct {
		name    string
		text    string
		ids     []string
		titles  []string
		bodies  []string
		typ     string
		errPart string
	}{
		{
			name:   "tiêu đề và danh sách",
			text:   "---\ntype: ac\ntitle: Thanh toán\nrev: 3\n---\n# Thanh toán\n## Giỏ hàng {#AC-01}\nThêm hàng.\n- Hết hàng thì báo {#AC-02}\n  chi tiết con\n\n  đoạn con thứ hai\nđoạn rời\n",
			ids:    []string{"AC-01", "AC-02"},
			titles: []string{"Giỏ hàng", "Hết hàng thì báo"},
			bodies: []string{"Thêm hàng.", "  chi tiết con\n\n  đoạn con thứ hai"},
			typ:    TypeAC,
		},
		{
			name:   "khối tiêu đề dừng ở tiêu đề cùng cấp, giữ tiêu đề con chưa neo",
			text:   "## A {#REQ-1}\na\n### con\nc\n## B {#REQ-2}\nb\n",
			ids:    []string{"REQ-1", "REQ-2"},
			bodies: []string{"a\n### con\nc", "b"},
			typ:    TypeOther,
		},
		{
			name:   "neo lồng: tiêu đề con có neo kết thúc khối cha",
			text:   "## A {#REQ-1}\na\n### A1 {#REQ-2}\na1\n#### A1a\nx\n## B {#REQ-3}\n",
			ids:    []string{"REQ-1", "REQ-2", "REQ-3"},
			bodies: []string{"a", "a1\n#### A1a\nx", ""},
			typ:    TypeOther,
		},
		{
			name:   "mục danh sách có neo kết thúc khối tiêu đề",
			text:   "## A {#REQ-1}\nmở đầu\n- mục {#REQ-2}\n- mục thường\n",
			ids:    []string{"REQ-1", "REQ-2"},
			bodies: []string{"mở đầu", ""},
			typ:    TypeOther,
		},
		{
			name: "bỏ qua khối mã",
			text: "## A {#REQ-1}\n```md\n## Không phải tiêu đề {#BAD}\n```\nsau\n",
			ids:  []string{"REQ-1"},
			typ:  TypeOther,
		},
		{name: "mã sai dạng", text: "## A {#req-1}\n", errPart: "sai dạng"},
		{name: "mã quá 4 chữ số", text: "## A {#REQ-12345}\n", errPart: "sai dạng"},
		{name: "neo rỗng", text: "## A {#}\n", errPart: "sai dạng"},
		{name: "neo ở tiêu đề cấp 1", text: "# Tên {#REQ-1}\n", errPart: "cấp 1"},
		{name: "loại sai", text: "---\ntype: XYZ\n---\n", errPart: "loại tài liệu"},
		{name: "thiếu dòng đóng front-matter", text: "---\ntype: PRD\n", errPart: "dòng đóng"},
		{name: "rev sai", text: "---\nrev: abc\n---\n", errPart: "rev"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			d, err := Parse(c.text)
			if c.errPart != "" {
				if apperr.CodeOf(err) != apperr.CodeInvalid || !strings.Contains(err.Error(), c.errPart) {
					t.Fatalf("err = %v, muốn chứa %q", err, c.errPart)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if got := reqIDs(d.Requirements); strings.Join(got, ",") != strings.Join(c.ids, ",") {
				t.Fatalf("ids = %v, want %v", got, c.ids)
			}
			if d.Type != c.typ {
				t.Fatalf("type = %q, want %q", d.Type, c.typ)
			}
			for i, title := range c.titles {
				if d.Requirements[i].Title != title {
					t.Fatalf("title[%d] = %q, want %q", i, d.Requirements[i].Title, title)
				}
			}
			for i, body := range c.bodies {
				if d.Requirements[i].Body != body {
					t.Fatalf("body[%d] = %q, want %q", i, d.Requirements[i].Body, body)
				}
			}
		})
	}
}

func TestParseLineNumbersCountFrontMatter(t *testing.T) {
	d, err := Parse("---\ntype: PRD\n---\n\n## A {#REQ-1}\n")
	if err != nil {
		t.Fatal(err)
	}
	if d.Requirements[0].Line != 5 || d.Rev != 0 || d.Type != TypePRD {
		t.Fatalf("doc = %+v", d)
	}
}

func TestHashIgnoresFormattingOnly(t *testing.T) {
	base := "## Đăng nhập {#REQ-1}\nNhập email.\n\nNhập mật khẩu.\n"
	hash := func(text string) string {
		t.Helper()
		d, err := Parse(text)
		if err != nil {
			t.Fatal(err)
		}
		return d.Requirements[0].Hash
	}
	h := hash(base)
	same := []string{
		"## Đăng nhập {#REQ-1}  \nNhập email.   \n\n\n\nNhập mật khẩu.\t\n\n",
		"## Đăng nhập   {#REQ-1}\r\nNhập email.\r\n\r\nNhập mật khẩu.\r\n",
		"\n## Đăng nhập {#REQ-1}\nNhập email.\n   \nNhập mật khẩu.\n",
	}
	for _, s := range same {
		if hash(s) != h {
			t.Errorf("chỉ đổi khoảng trắng mà hash đổi: %q", s)
		}
	}
	// Bỏ neo vẫn cùng nội dung: so khối đã chuẩn hoá trực tiếp.
	if hashBlock([]string{"## Đăng nhập", "Nhập email.", "", "Nhập mật khẩu."}) != h {
		t.Error("neo phải bị bỏ khi băm")
	}
	diff := []string{
		"## Đăng nhập {#REQ-1}\nNhập email hoặc số điện thoại.\n\nNhập mật khẩu.\n",
		"## Đăng nhập {#REQ-1}\nNhập email.\nNhập mật khẩu.\n",
		"## Đăng nhập lại {#REQ-1}\nNhập email.\n\nNhập mật khẩu.\n",
	}
	for _, s := range diff {
		if hash(s) == h {
			t.Errorf("đổi nội dung mà hash giữ nguyên: %q", s)
		}
	}
}

func TestSaveAssignsUniqueIDsAndResaveOnlyBumpsRev(t *testing.T) {
	dir := t.TempDir()
	s := NewStore(dir)
	src := "---\ntype: PRD\ntitle: Thanh toán\n---\n# Thanh toán\n\n## Giỏ hàng\nThêm.\n\n## Mã giảm giá\nÁp mã.\n\n### Hết hạn\nBáo lỗi.\n"
	d, err := s.Save("shop", "prd-checkout", src)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(reqIDs(d.Requirements), ","); got != "REQ-001,REQ-002,REQ-003" {
		t.Fatalf("ids = %s", got)
	}
	if d.Rev != 1 || d.Title != "Thanh toán" || d.Type != TypePRD {
		t.Fatalf("doc = %+v", d)
	}
	path := filepath.Join(dir, "shop", "prd-checkout.md")
	disk, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(disk) != d.Markdown || len(regexp.MustCompile(`\{#REQ-\d+\}`).FindAllString(string(disk), -1)) != 3 {
		t.Fatalf("tệp trên đĩa:\n%s", disk)
	}

	d2, err := s.Save("shop", "prd-checkout", d.Markdown)
	if err != nil {
		t.Fatal(err)
	}
	if d2.Rev != 2 {
		t.Fatalf("rev = %d", d2.Rev)
	}
	if strings.Replace(d2.Markdown, "rev: 2", "rev: 1", 1) != d.Markdown {
		t.Fatalf("lưu lại đổi nội dung ngoài rev:\n%s\n---\n%s", d.Markdown, d2.Markdown)
	}
	for i := range d.Requirements {
		if d.Requirements[i] != d2.Requirements[i] {
			t.Fatalf("yêu cầu đổi sau khi lưu lại: %+v vs %+v", d.Requirements[i], d2.Requirements[i])
		}
	}
	old, err := s.Revision("shop", "prd-checkout", 1)
	if err != nil || old != d.Markdown {
		t.Fatalf("Revision(1) = %q, %v", old, err)
	}
	if _, err := os.Stat(filepath.Join(dir, "shop", ".history", "prd-checkout", "1.md")); err != nil {
		t.Fatal("thiếu bản cũ trong .history:", err)
	}
	h, err := s.History("shop", "prd-checkout")
	if err != nil || len(h) != 2 || !h[0].Current || h[0].Rev != 2 || h[1].Rev != 1 {
		t.Fatalf("History = %+v, %v", h, err)
	}
	cur, err := s.Revision("shop", "prd-checkout", 2)
	if err != nil || cur != d2.Markdown {
		t.Fatalf("Revision(2) = %q, %v", cur, err)
	}
}

func TestSavePrefixByTypeAndMaxAcrossApp(t *testing.T) {
	s := NewStore(t.TempDir())
	if _, err := s.Save("shop", "a", "## X {#REQ-007}\n## Y\n"); err != nil {
		t.Fatal(err)
	}
	cases := []struct{ id, src, want string }{
		{"b", "---\ntype: SRS\n---\n## Z\n", "REQ-009"},
		{"c", "---\ntype: BRD\n---\n## Z\n", "BR-001"},
		{"d", "---\ntype: URD\n---\n## Z\n", "UR-001"},
		{"e", "---\ntype: AC\n---\n- có sẵn {#AC-41}\n## Z\n", "AC-41,AC-042"},
	}
	for _, c := range cases {
		d, err := s.Save("shop", c.id, c.src)
		if err != nil {
			t.Fatal(err)
		}
		ids := reqIDs(d.Requirements)
		if strings.Join(ids, ",") != c.want {
			t.Errorf("%s: ids = %v, want %s", c.id, ids, c.want)
		}
	}
	// Mã đã có không đổi; mã đã xoá khỏi tài liệu không bị cấp lại cho mục mới.
	d, err := s.Save("shop", "a", "## X {#REQ-007}\n## Mới\n")
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(reqIDs(d.Requirements), ","); got != "REQ-007,REQ-010" {
		t.Fatalf("ids = %s", got)
	}
	// Front-matter thiếu type/title giữ của bản trước.
	d, err = s.Save("shop", "c", "## Z {#BR-001}\n## Thêm\n")
	if err != nil {
		t.Fatal(err)
	}
	if d.Type != TypeBRD || reqIDs(d.Requirements)[1] != "BR-002" {
		t.Fatalf("doc = %+v", d)
	}
}

func TestSaveRejectsDuplicateIDs(t *testing.T) {
	s := NewStore(t.TempDir())
	if _, err := s.Save("shop", "prd", "## A {#REQ-1}\n"); err != nil {
		t.Fatal(err)
	}
	_, err := s.Save("shop", "srs", "## B {#REQ-1}\n")
	if apperr.CodeOf(err) != apperr.CodeInvalid || !strings.Contains(err.Error(), "REQ-1") ||
		!strings.Contains(err.Error(), `"prd"`) || !strings.Contains(err.Error(), `"srs"`) {
		t.Fatalf("err = %v", err)
	}
	_, err = s.Save("shop", "srs", "## B {#REQ-2}\n## C {#REQ-2}\n")
	if apperr.CodeOf(err) != apperr.CodeInvalid || !strings.Contains(err.Error(), "REQ-2") {
		t.Fatalf("err = %v", err)
	}
	// Cùng mã ở app khác không tính là trùng.
	if _, err := s.Save("other", "srs", "## B {#REQ-1}\n"); err != nil {
		t.Fatal(err)
	}
	// Lưu lại chính tài liệu đó không tự trùng với bản cũ.
	if _, err := s.Save("shop", "prd", "## A sửa {#REQ-1}\n"); err != nil {
		t.Fatal(err)
	}
}

func TestRequirementsReportsDuplicatesFromDisk(t *testing.T) {
	dir := t.TempDir()
	s := NewStore(dir)
	if _, err := s.Save("shop", "a", "## A {#REQ-1}\n## B {#REQ-2}\n"); err != nil {
		t.Fatal(err)
	}
	// Tệp đến từ đồng bộ (ghi thẳng, không qua Save) có thể trùng mã.
	if err := os.WriteFile(filepath.Join(dir, "shop", "b.md"), []byte("## C {#REQ-2}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	idx, err := s.Requirements("shop")
	if err != nil {
		t.Fatal(err)
	}
	if len(idx.Reqs) != 3 || strings.Join(idx.Duplicates, ",") != "REQ-2" {
		t.Fatalf("idx = %+v", idx)
	}
	if idx.Reqs[0].Doc != "a" || idx.Reqs[2].Doc != "b" {
		t.Fatalf("doc của yêu cầu sai: %+v", idx.Reqs)
	}
	empty, err := s.Requirements("none")
	if err != nil || len(empty.Reqs) != 0 || len(empty.Duplicates) != 0 {
		t.Fatalf("app trống = %+v, %v", empty, err)
	}
}

func TestHistoryKeepsNewest(t *testing.T) {
	s := NewStore(t.TempDir())
	for i := 0; i < MaxHistory+5; i++ {
		if _, err := s.Save("shop", "prd", fmt.Sprintf("## A {#REQ-1}\nbản %d\n", i)); err != nil {
			t.Fatal(err)
		}
	}
	h, err := s.History("shop", "prd")
	if err != nil {
		t.Fatal(err)
	}
	if len(h) != MaxHistory+1 || h[0].Rev != MaxHistory+5 || h[len(h)-1].Rev != 5 {
		t.Fatalf("history: %d bản, mới nhất %d, cũ nhất %d", len(h), h[0].Rev, h[len(h)-1].Rev)
	}
	if _, err := s.Revision("shop", "prd", 4); apperr.CodeOf(err) != apperr.CodeNotFound {
		t.Fatalf("bản đã dọn: err = %v", err)
	}
}

func TestDeleteArchivesAndRevContinues(t *testing.T) {
	s := NewStore(t.TempDir())
	for i := 0; i < 2; i++ {
		if _, err := s.Save("shop", "prd", "## A\n"); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.Delete("shop", "prd"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Get("shop", "prd"); apperr.CodeOf(err) != apperr.CodeNotFound {
		t.Fatalf("Get sau xoá: %v", err)
	}
	if err := s.Delete("shop", "prd"); apperr.CodeOf(err) != apperr.CodeNotFound {
		t.Fatalf("xoá lần hai: %v", err)
	}
	if text, err := s.Revision("shop", "prd", 2); err != nil || !strings.Contains(text, "{#REQ-002}") {
		t.Fatalf("bản cuối trước khi xoá: %q, %v", text, err)
	}
	d, err := s.Save("shop", "prd", "## B\n")
	if err != nil {
		t.Fatal(err)
	}
	if d.Rev != 3 {
		t.Fatalf("tạo lại: %+v", d)
	}
}

func TestSaveReplacesBrokenDocAndKeepsIt(t *testing.T) {
	dir := t.TempDir()
	s := NewStore(dir)
	if err := os.MkdirAll(filepath.Join(dir, "shop"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "shop", "prd.md"), []byte("## A {#bad}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Requirements("shop"); apperr.CodeOf(err) != apperr.CodeInvalid {
		t.Fatalf("tài liệu hỏng phải báo lỗi: %v", err)
	}
	d, err := s.Save("shop", "prd", "## A\n")
	if err != nil {
		t.Fatal(err)
	}
	if d.Rev != 2 {
		t.Fatalf("rev = %d", d.Rev)
	}
	if text, err := s.Revision("shop", "prd", 1); err != nil || text != "## A {#bad}\n" {
		t.Fatalf("bản hỏng trong lịch sử: %q, %v", text, err)
	}
}

func TestStoreValidatesInput(t *testing.T) {
	s := NewStore(t.TempDir())
	cases := []struct {
		name, app, id, src string
	}{
		{"app sai", "Shop", "prd", "x"},
		{"app có dấu chấm đầu", ".shop", "prd", "x"},
		{"mã tài liệu có gạch chéo", "shop", "../x", "x"},
		{"mã tài liệu chữ hoa", "shop", "PRD", "x"},
		{"quá 1 MB", "shop", "prd", strings.Repeat("a", MaxDocBytes+1)},
	}
	for _, c := range cases {
		if _, err := s.Save(c.app, c.id, c.src); apperr.CodeOf(err) != apperr.CodeInvalid {
			t.Errorf("%s: err = %v", c.name, err)
		}
	}
	if _, err := s.Get("shop", "missing"); apperr.CodeOf(err) != apperr.CodeNotFound {
		t.Fatalf("Get thiếu: %v", err)
	}
	if list, err := s.List("shop"); err != nil || len(list) != 0 {
		t.Fatalf("List trống = %v, %v", list, err)
	}
}

func TestListAndDefaultTitle(t *testing.T) {
	s := NewStore(t.TempDir())
	if _, err := s.Save("shop", "b-doc", "# Tiêu đề lớn\n## A\n"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Save("shop", "a-doc", "## A\n"); err != nil {
		t.Fatal(err)
	}
	list, err := s.List("shop")
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 || list[0].ID != "a-doc" || list[0].Title != "a-doc" || list[1].Title != "Tiêu đề lớn" ||
		list[1].Type != TypeOther || list[1].Rev != 1 || list[1].UpdatedAt.IsZero() {
		t.Fatalf("list = %+v", list)
	}
}

func TestConcurrentSavesKeepIDsUnique(t *testing.T) {
	s := NewStore(t.TempDir())
	var wg sync.WaitGroup
	errs := make(chan error, 20)
	for g := 0; g < 2; g++ {
		for k := 0; k < 10; k++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				_, err := s.Save("shop", fmt.Sprintf("doc-%d-%d", g, k), "## A\n## B\n")
				errs <- err
			}()
		}
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	idx, err := s.Requirements("shop")
	if err != nil {
		t.Fatal(err)
	}
	if len(idx.Reqs) != 40 || len(idx.Duplicates) != 0 {
		t.Fatalf("%d yêu cầu, trùng %v", len(idx.Reqs), idx.Duplicates)
	}
}

func TestWithLockExcludesSave(t *testing.T) {
	s := NewStore(t.TempDir())
	done := make(chan struct{})
	err := s.WithLock(func() error {
		go func() {
			_, _ = s.Save("shop", "prd", "## A\n")
			close(done)
		}()
		time.Sleep(20 * time.Millisecond)
		select {
		case <-done:
			return fmt.Errorf("Save chạy khi đang giữ khoá")
		default:
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	<-done
}

func TestNotes(t *testing.T) {
	dir := t.TempDir()
	s := NewStore(dir)
	n, err := s.AddNote("shop", Note{Req: "REQ-001", RunID: "r1", Flow: "login.yaml", Text: " PRD ghi sai mã lỗi ", Author: "An"})
	if err != nil {
		t.Fatal(err)
	}
	if n.ID == "" || n.Status != NoteOpen || n.At.IsZero() || n.Text != "PRD ghi sai mã lỗi" {
		t.Fatalf("note = %+v", n)
	}
	if _, err := os.Stat(filepath.Join(dir, "shop", "notes", n.ID+".json")); err != nil {
		t.Fatal("mỗi ghi chú một tệp:", err)
	}
	if _, err := s.AddNote("shop", Note{Req: "AC-2", Text: "khác"}); err != nil {
		t.Fatal(err)
	}
	// Tệp hỏng bị bỏ qua.
	if err := os.WriteFile(filepath.Join(dir, "shop", "notes", "broken.json"), []byte("{"), 0o644); err != nil {
		t.Fatal(err)
	}
	list, err := s.Notes("shop")
	if err != nil || len(list) != 2 {
		t.Fatalf("Notes = %+v, %v", list, err)
	}
	r, err := s.ResolveNote("shop", n.ID)
	if err != nil || r.Status != NoteResolved || r.Text != n.Text {
		t.Fatalf("ResolveNote = %+v, %v", r, err)
	}
	if _, err := s.ResolveNote("shop", "missing"); apperr.CodeOf(err) != apperr.CodeNotFound {
		t.Fatalf("ghi chú thiếu: %v", err)
	}
	if _, err := s.ResolveNote("shop", "../x"); apperr.CodeOf(err) != apperr.CodeInvalid {
		t.Fatalf("mã ghi chú sai: %v", err)
	}
	bad := []Note{
		{Req: "req-1", Text: "x"},
		{Req: "REQ-1", Text: "   "},
		{Req: "REQ-1", Text: strings.Repeat("x", maxNoteText+1)},
		{Req: "REQ-1", Text: "x", Flow: "a\nb"},
	}
	for _, b := range bad {
		if _, err := s.AddNote("shop", b); apperr.CodeOf(err) != apperr.CodeInvalid {
			t.Errorf("AddNote(%+v) err = %v", b, err)
		}
	}
	if empty, err := s.Notes("none"); err != nil || len(empty) != 0 {
		t.Fatalf("app trống = %v, %v", empty, err)
	}
}
