package google_test

import (
	"bytes"
	"context"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"deskcore/google"
	"deskcore/google/googletest"
)

var ctx = context.Background()

func mustFolder(t *testing.T, c *google.Client, name, parent string) *google.File {
	t.Helper()
	meta := google.FileMeta{Name: name, MimeType: google.FolderMime}
	if parent != "" {
		meta.Parents = []string{parent}
	}
	f, err := c.CreateFile(ctx, meta, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	return f
}

// Tạo, đọc, ghi đè: version tăng, appProperties gộp như Drive, md5 và nội dung theo bản mới.
func TestCreateGetUpdateFile(t *testing.T) {
	fd := googletest.New(t)
	c := fd.Client()
	root := mustFolder(t, c, "HS Desk", "")
	created, err := c.CreateFile(ctx, google.FileMeta{
		Name: "VP-1.json", Parents: []string{root.ID},
		AppProperties: map[string]string{"hsKind": "card", "hsId": "VP-1", "hsRev": "1"},
	}, "application/json", []byte(`{"a":1}`))
	if err != nil {
		t.Fatal(err)
	}
	if created.Version <= 0 || created.AppProperties["hsRev"] != "1" || created.Md5Checksum == "" {
		t.Fatalf("tạo phải trả version, appProperties, md5: %+v", created)
	}

	got, err := c.GetFile(ctx, created.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	if got.Version != created.Version || len(got.Parents) != 1 || got.Parents[0] != root.ID || got.Trashed || got.Size != 7 {
		t.Fatalf("GetFile: %+v", got)
	}

	updated, err := c.UpdateFile(ctx, created.ID, google.FileMeta{AppProperties: map[string]string{"hsRev": "2"}},
		"application/json", []byte(`{"a":2}`))
	if err != nil {
		t.Fatal(err)
	}
	if updated.Version <= created.Version || updated.AppProperties["hsRev"] != "2" || updated.AppProperties["hsKind"] != "card" {
		t.Fatalf("ghi đè: version tăng, khoá cũ giữ, khoá mới đổi: %+v", updated)
	}
	if updated.Md5Checksum == created.Md5Checksum || updated.Name != "VP-1.json" {
		t.Fatalf("ghi đè đổi nội dung, giữ tên: %+v", updated)
	}
	data, err := c.Download(ctx, created.ID)
	if err != nil || string(data) != `{"a":2}` {
		t.Fatalf("Download: %q %v", data, err)
	}

	// Chỉ sửa metadata (data nil): nội dung giữ nguyên, version vẫn tăng.
	meta, err := c.UpdateFile(ctx, created.ID, google.FileMeta{AppProperties: map[string]string{"hsRemoved": "1"}}, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	if meta.Version <= updated.Version || meta.Md5Checksum != updated.Md5Checksum || meta.AppProperties["hsRemoved"] != "1" {
		t.Fatalf("sửa metadata: %+v", meta)
	}
	if fd.Calls(googletest.OpUploadSession) != 0 {
		t.Fatal("tệp nhỏ phải dùng multipart, không resumable")
	}
}

// Trên ngưỡng: tạo và ghi đè đều qua resumable upload.
func TestResumableUploadAboveThreshold(t *testing.T) {
	fd := googletest.New(t)
	c := fd.Client()
	c.ResumableAbove = 16
	big := bytes.Repeat([]byte("x"), 32)
	f, err := c.CreateFile(ctx, google.FileMeta{Name: "lon.bin", AppProperties: map[string]string{"hsRev": "1"}}, "application/octet-stream", big)
	if err != nil {
		t.Fatal(err)
	}
	if fd.Calls(googletest.OpUploadSession) != 1 || f.Size != 32 || f.AppProperties["hsRev"] != "1" {
		t.Fatalf("tạo lớn qua resumable: calls=%d %+v", fd.Calls(googletest.OpUploadSession), f)
	}
	big2 := bytes.Repeat([]byte("y"), 40)
	u, err := c.UpdateFile(ctx, f.ID, google.FileMeta{AppProperties: map[string]string{"hsRev": "2"}}, "application/octet-stream", big2)
	if err != nil {
		t.Fatal(err)
	}
	if fd.Calls(googletest.OpUploadSession) != 2 || u.Size != 40 || u.AppProperties["hsRev"] != "2" || u.Version <= f.Version {
		t.Fatalf("ghi đè lớn qua resumable: %+v", u)
	}
	data, _ := c.Download(ctx, f.ID)
	if !bytes.Equal(data, big2) {
		t.Fatal("nội dung sau resumable sai")
	}
	// Đứt khi đẩy nội dung: không có tệp nửa vời, phiên bỏ.
	fd.Inject(googletest.DropBefore(googletest.OpUploadSession, 0))
	if _, err := c.CreateFile(ctx, google.FileMeta{Name: "dut.bin"}, "application/octet-stream", big); err == nil {
		t.Fatal("đứt kết nối phải báo lỗi")
	}
	if n := len(fd.Files()); n != 1 {
		t.Fatalf("đứt giữa resumable không được để lại tệp: %d tệp", n)
	}
}

// FindChild thoát dấu nháy, bỏ tệp trong thùng rác; ListChildren đi hết các trang.
func TestFindChildAndListChildrenPaged(t *testing.T) {
	fd := googletest.New(t)
	fd.PageSize = 2
	c := fd.Client()
	root := mustFolder(t, c, "HS Desk", "")
	other := mustFolder(t, c, "Khác", "")
	names := []string{"a.json", "b'c.json", `d\e.json`, "f.json", "g.json"}
	for _, n := range names {
		if _, err := c.CreateFile(ctx, google.FileMeta{Name: n, Parents: []string{root.ID}}, "application/json", []byte("{}")); err != nil {
			t.Fatal(err)
		}
	}
	_, _ = c.CreateFile(ctx, google.FileMeta{Name: "a.json", Parents: []string{other.ID}}, "application/json", []byte("{}"))

	for _, n := range []string{"b'c.json", `d\e.json`} {
		f, err := c.FindChild(ctx, root.ID, n)
		if err != nil || f == nil || f.Name != n || f.Parents[0] != root.ID {
			t.Fatalf("FindChild %q: %+v %v", n, f, err)
		}
	}
	if f, err := c.FindChild(ctx, root.ID, "khong-co.json"); err != nil || f != nil {
		t.Fatalf("không có thì nil, không lỗi: %+v %v", f, err)
	}
	a, _ := c.FindChild(ctx, root.ID, "a.json")
	fd.SetTrashed(a.ID, true)
	if f, _ := c.FindChild(ctx, root.ID, "a.json"); f != nil {
		t.Fatalf("tệp trong thùng rác không được tìm thấy: %+v", f)
	}

	var all []google.File
	tok := ""
	pages := 0
	for {
		files, next, err := c.ListChildren(ctx, root.ID, tok)
		if err != nil {
			t.Fatal(err)
		}
		all = append(all, files...)
		pages++
		if next == "" {
			break
		}
		tok = next
	}
	if len(all) != 4 || pages != 2 {
		t.Fatalf("ListChildren: %d tệp / %d trang", len(all), pages)
	}
	for _, f := range all {
		if f.Version == 0 || len(f.Parents) == 0 {
			t.Fatalf("ListChildren phải trả đủ trường: %+v", f)
		}
	}
}

func TestFindByAppProperty(t *testing.T) {
	fd := googletest.New(t)
	fd.PageSize = 1
	c := fd.Client()
	for _, tenant := range []string{"t1", "t2", "t1"} {
		if _, err := c.CreateFile(ctx, google.FileMeta{Name: "HS Desk", MimeType: google.FolderMime,
			AppProperties: map[string]string{"hsdeskTenant": tenant}}, "", nil); err != nil {
			t.Fatal(err)
		}
	}
	got, err := c.FindByAppProperty(ctx, "hsdeskTenant", "t1")
	if err != nil || len(got) != 2 {
		t.Fatalf("FindByAppProperty phải đi hết các trang: %d %v", len(got), err)
	}
	if got, _ := c.FindByAppProperty(ctx, "hsdeskTenant", "x'y"); len(got) != 0 {
		t.Fatalf("không khớp: %+v", got)
	}
}

func TestCopyFile(t *testing.T) {
	fd := googletest.New(t)
	c := fd.Client()
	src, _ := c.CreateFile(ctx, google.FileMeta{Name: "VP-1.json", AppProperties: map[string]string{"hsRev": "3"}}, "application/json", []byte(`{"v":3}`))
	snap := mustFolder(t, c, "2026-11-13-2130", "")
	cp, err := c.CopyFile(ctx, src.ID, snap.ID, "VP-1.json")
	if err != nil {
		t.Fatal(err)
	}
	if cp.ID == src.ID || cp.Parents[0] != snap.ID || cp.Md5Checksum != src.Md5Checksum || cp.AppProperties["hsRev"] != "3" {
		t.Fatalf("CopyFile: %+v", cp)
	}
}

// changes.list: page token, đi hết các trang rồi nhận newStartPageToken; lần sau từ token đó chỉ thấy thay đổi mới.
func TestChangesFeed(t *testing.T) {
	fd := googletest.New(t)
	fd.PageSize = 2
	c := fd.Client()
	start, err := c.StartPageToken(ctx)
	if err != nil || start == "" {
		t.Fatalf("StartPageToken: %q %v", start, err)
	}
	ids := map[string]bool{}
	for _, n := range []string{"a", "b", "c"} {
		f, _ := c.CreateFile(ctx, google.FileMeta{Name: n, AppProperties: map[string]string{"hsId": n}}, "text/plain", []byte(n))
		ids[f.ID] = true
	}
	seen := map[string]bool{}
	tok, next := start, ""
	for {
		cl, err := c.Changes(ctx, tok)
		if err != nil {
			t.Fatal(err)
		}
		for _, ch := range cl.Changes {
			if ch.File == nil || ch.File.AppProperties["hsId"] == "" || ch.Removed {
				t.Fatalf("thay đổi phải kèm tệp đủ trường: %+v", ch)
			}
			seen[ch.FileID] = true
		}
		if cl.NextPageToken == "" {
			next = cl.NewStartPageToken
			break
		}
		tok = cl.NextPageToken
	}
	if len(seen) != 3 || next == "" {
		t.Fatalf("changes: %v next=%q", seen, next)
	}
	cl, err := c.Changes(ctx, next)
	if err != nil || len(cl.Changes) != 0 || cl.NewStartPageToken != next {
		t.Fatalf("không có gì mới: %+v %v", cl, err)
	}
}

// Lỗi Drive có mã: đầy, bận, mất quyền là lỗi tạm thời (dữ liệu giữ trên máy); 404 thường thì không.
func TestDriveErrorCodes(t *testing.T) {
	cases := []struct {
		name       string
		fault      googletest.Fault
		code       string
		retry      bool
		needsAdmin bool
	}{
		{"quota", googletest.QuotaExceeded(""), google.CodeDriveFull, true, false},
		{"user_rate", googletest.RateLimited(""), google.CodeDriveBusy, true, false},
		{"429", googletest.TooManyRequests(""), google.CodeDriveBusy, true, false},
		{"no_access", googletest.NoAccess(""), google.CodeDriveNoAccess, true, true},
		{"not_found", googletest.NotFound(""), "", false, false},
		{"server", googletest.Fault{Status: 503, Reason: "backendError"}, "", true, false},
		{"bad_request", googletest.Fault{Status: 400, Reason: "invalid"}, "", false, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fd := googletest.New(t)
			c := fd.Client()
			fd.Inject(tc.fault)
			_, err := c.CreateFile(ctx, google.FileMeta{Name: "x"}, "text/plain", []byte("x"))
			var ge *google.Error
			if !errors.As(err, &ge) {
				t.Fatalf("phải là *google.Error: %v", err)
			}
			if ge.Code() != tc.code || ge.ErrorCode() != tc.code || ge.Retryable() != tc.retry || ge.NeedsAdmin() != tc.needsAdmin {
				t.Fatalf("%+v: code=%q retry=%v admin=%v", ge, ge.Code(), ge.Retryable(), ge.NeedsAdmin())
			}
			if tc.fault.Reason != "" && ge.Reason != tc.fault.Reason {
				t.Fatalf("reason: %q", ge.Reason)
			}
		})
	}
}

// Thư mục gốc 404 => drive_no_access (cần Quản lý kết nối lại); lỗi khác giữ nguyên.
func TestNoAccessOnMissingRoot(t *testing.T) {
	fd := googletest.New(t)
	c := fd.Client()
	_, err := c.GetFile(ctx, "khong-co", "")
	var ge *google.Error
	if !errors.As(google.NoAccess(err), &ge) || ge.Code() != google.CodeDriveNoAccess || !ge.Retryable() || !ge.NeedsAdmin() {
		t.Fatalf("404 gốc: %v", google.NoAccess(err))
	}
	if errors.As(err, &ge); ge.Code() != "" {
		t.Fatal("NoAccess không được sửa lỗi gốc")
	}
	other := errors.New("x")
	if google.NoAccess(other) != other {
		t.Fatal("lỗi khác giữ nguyên")
	}
}

// Cắt kết nối trước khi Drive làm: không có tệp; sau khi Drive làm: tệp đã có dù client báo lỗi.
func TestDropConnection(t *testing.T) {
	fd := googletest.New(t)
	c := fd.Client()
	fd.Inject(googletest.DropBefore(googletest.OpUploadCreate, 0))
	if _, err := c.CreateFile(ctx, google.FileMeta{Name: "a"}, "text/plain", []byte("a")); err == nil {
		t.Fatal("phải lỗi khi mất kết nối")
	}
	if len(fd.Files()) != 0 {
		t.Fatal("cắt trước khi làm: không được có tệp")
	}
	fd.Inject(googletest.DropAfter(googletest.OpUploadCreate, 0))
	if _, err := c.CreateFile(ctx, google.FileMeta{Name: "a"}, "text/plain", []byte("a")); err == nil {
		t.Fatal("phải lỗi khi mất câu trả lời")
	}
	if fs := fd.Files(); len(fs) != 1 || fs[0].Name != "a" {
		t.Fatalf("cắt sau khi làm: tệp đã có: %+v", fs)
	}
	// Cắt sau N request bất kỳ.
	fd.Inject(googletest.DropBefore("", 1))
	if _, err := c.GetFile(ctx, fd.Files()[0].ID, ""); err != nil {
		t.Fatalf("request đầu chạy bình thường: %v", err)
	}
	if _, err := c.UpdateFile(ctx, fd.Files()[0].ID, google.FileMeta{Name: "b"}, "", nil); err == nil {
		t.Fatal("request thứ 2 phải mất kết nối")
	}
	if _, err := c.UpdateFile(ctx, fd.Files()[0].ID, google.FileMeta{Name: "b"}, "", nil); err != nil {
		t.Fatalf("lỗi chỉ 1 lần: %v", err)
	}
}

// Drive giả không có API xoá.
func TestFakeDriveRefusesDelete(t *testing.T) {
	fd := googletest.New(t)
	f, _ := fd.Client().CreateFile(ctx, google.FileMeta{Name: "a"}, "text/plain", []byte("a"))
	req, _ := http.NewRequest(http.MethodDelete, fd.Server.URL+"/drive/v3/files/"+f.ID, nil)
	req.Header.Set("Authorization", "Bearer "+googletest.Token)
	res, err := fd.Server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	if res.StatusCode != http.StatusMethodNotAllowed || len(fd.Files()) != 1 {
		t.Fatalf("xoá phải bị từ chối: %d", res.StatusCode)
	}
}

// App không bao giờ xoá trên Drive: mã nguồn gói google không được gọi API xoá, dọn thùng rác hay xoá vĩnh viễn.
func TestNoDeleteEndpointsInSource(t *testing.T) {
	forbidden := regexp.MustCompile(`(?i)MethodDelete|"DELETE"|emptyTrash|/trash\b|permanentDelete|permanently`)
	checked := 0
	err := filepath.WalkDir(".", func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return err
		}
		src, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		checked++
		if loc := forbidden.FindIndex(src); loc != nil {
			t.Errorf("%s gọi API xoá Drive: %q", path, src[loc[0]:loc[1]])
		}
		return nil
	})
	if err != nil || checked < 3 {
		t.Fatalf("phải quét client.go, drive.go, googletest: %d tệp, %v", checked, err)
	}
}

// Chuyển tệp sang thư mục khác: PATCH chỉ metadata với addParents/removeParents; mã, nội dung và appProperties giữ nguyên.
func TestMoveFile(t *testing.T) {
	fd := googletest.New(t)
	c := fd.Client()
	from, to := mustFolder(t, c, "lich-su", ""), mustFolder(t, c, "da-go", "")
	f, err := c.CreateFile(ctx, google.FileMeta{Name: "du-lieu.xlsx", Parents: []string{from.ID},
		AppProperties: map[string]string{"hsHistoryFile": "hf_1"}}, "application/x", []byte("abc"))
	if err != nil {
		t.Fatal(err)
	}
	moved, err := c.MoveFile(ctx, f.ID, to.ID, from.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(moved.Parents) != 1 || moved.Parents[0] != to.ID || moved.ID != f.ID || moved.AppProperties["hsHistoryFile"] != "hf_1" {
		t.Fatalf("sau khi chuyển: %+v", moved)
	}
	if data, err := c.Download(ctx, f.ID); err != nil || string(data) != "abc" {
		t.Fatalf("nội dung giữ nguyên: %q %v", data, err)
	}
	if kids, _, err := c.ListChildren(ctx, from.ID, ""); err != nil || len(kids) != 0 {
		t.Fatalf("thư mục cũ phải trống: %v %v", kids, err)
	}
	// Không bỏ thư mục cũ: tệp nằm ở cả hai.
	both, err := c.MoveFile(ctx, f.ID, from.ID, "")
	if err != nil || len(both.Parents) != 2 {
		t.Fatalf("chỉ thêm thư mục: %+v %v", both, err)
	}
	if _, err := c.MoveFile(ctx, f.ID, "", from.ID); err == nil {
		t.Fatal("thiếu thư mục đích phải lỗi")
	}
	if _, err := c.MoveFile(ctx, f.ID, "khong-co", ""); err == nil {
		t.Fatal("thư mục đích không có phải lỗi")
	}
}

// Hình dạng request: PATCH files/{id}?addParents=..&removeParents=.. với thân rỗng, không đụng tới uploadType.
func TestMoveFileRequestShape(t *testing.T) {
	var method, path, rawQuery, body string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		method, path, rawQuery, body = r.Method, r.URL.Path, r.URL.RawQuery, string(b)
		_, _ = w.Write([]byte(`{"id":"f1","parents":["B"]}`))
	}))
	defer srv.Close()
	c := google.New(func(context.Context) (string, error) { return "t", nil })
	c.DriveBase = srv.URL + "/drive/v3"
	if _, err := c.MoveFile(ctx, "f1", "B", "A"); err != nil {
		t.Fatal(err)
	}
	q, _ := url.ParseQuery(rawQuery)
	if method != http.MethodPatch || path != "/drive/v3/files/f1" || q.Get("addParents") != "B" || q.Get("removeParents") != "A" ||
		strings.TrimSpace(body) != "{}" || q.Get("uploadType") != "" {
		t.Fatalf("%s %s ?%s body=%q", method, path, rawQuery, body)
	}
	if _, err := c.MoveFile(ctx, "f1", "B", ""); err != nil {
		t.Fatal(err)
	}
	if q, _ = url.ParseQuery(rawQuery); q.Has("removeParents") {
		t.Fatalf("không có thư mục cũ thì không gửi removeParents: %s", rawQuery)
	}
}
