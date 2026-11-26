// Package googletest: Drive giả (httptest) cho test của go-core và các sản phẩm.
//
// Giống Drive v3 ở những điểm client google dùng: tệp có version tăng dần, appProperties gộp như Drive (giá trị null
// thì gỡ khoá), parents, md5Checksum, truy vấn q (parents, name, trashed, appProperties has), changes feed có page
// token, upload multipart và resumable, sao chép tệp. Không có API xoá (app không bao giờ xoá trên Drive).
//
// Gây lỗi theo ý (Inject): Drive đầy, bị giới hạn tần suất, mất quyền, và cắt kết nối trước hoặc sau khi Drive đã
// làm request thứ N, để test đứt giữa chừng ở từng bước.
//
// Khác Drive thật: luôn trả đủ mọi trường (bỏ qua fields), version đếm chung cho cả kho (vẫn tăng dần theo từng tệp).
package googletest

import (
	"bytes"
	"context"
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"deskcore/google"
)

// Tên loại request, dùng cho Fault.Op và Calls.
const (
	OpGet           = "files.get"
	OpDownload      = "files.download"
	OpList          = "files.list"
	OpCreate        = "files.create" // tạo chỉ metadata (thư mục)
	OpUpdate        = "files.update" // sửa chỉ metadata
	OpCopy          = "files.copy"
	OpUploadCreate  = "upload.create" // multipart, hoặc mở phiên resumable để tạo
	OpUploadUpdate  = "upload.update" // multipart, hoặc mở phiên resumable để ghi đè
	OpUploadSession = "upload.session"
	OpChangesStart  = "changes.startPageToken"
	OpChanges       = "changes.list"
)

// DropMode: cắt kết nối ở đâu.
type DropMode int

const (
	// NoDrop: trả lỗi HTTP (Status, Reason).
	NoDrop DropMode = iota
	// DropBeforeApply: cắt kết nối, Drive CHƯA làm gì.
	DropBeforeApply
	// DropAfterApply: Drive đã làm xong (tệp đã đổi) nhưng cắt kết nối trước khi trả lời.
	DropAfterApply
)

// Fault: lỗi gây ra cho các request khớp Op.
type Fault struct {
	Op     string // "" = mọi request
	Skip   int    // để Skip request khớp đầu tiên chạy bình thường rồi mới gây lỗi
	Count  int    // số lần gây lỗi; 0 = mãi tới ClearFaults
	Status int    // mã HTTP khi Drop = NoDrop
	Reason string // error.errors[0].reason
	Drop   DropMode

	seen, fired int
}

// QuotaExceeded: Drive chủ TK đã đầy (403 storageQuotaExceeded).
func QuotaExceeded(op string) Fault {
	return Fault{Op: op, Status: http.StatusForbidden, Reason: "storageQuotaExceeded"}
}

// RateLimited: 403 userRateLimitExceeded.
func RateLimited(op string) Fault {
	return Fault{Op: op, Status: http.StatusForbidden, Reason: "userRateLimitExceeded"}
}

// TooManyRequests: 429 rateLimitExceeded.
func TooManyRequests(op string) Fault {
	return Fault{Op: op, Status: http.StatusTooManyRequests, Reason: "rateLimitExceeded"}
}

// NoAccess: app mất quyền với tệp (403 insufficientFilePermissions).
func NoAccess(op string) Fault {
	return Fault{Op: op, Status: http.StatusForbidden, Reason: "insufficientFilePermissions"}
}

// NotFound: 404 notFound (vd thư mục gốc bị xoá hẳn).
func NotFound(op string) Fault {
	return Fault{Op: op, Status: http.StatusNotFound, Reason: "notFound"}
}

// DropBefore: cắt kết nối 1 lần ở request khớp thứ skip+1, trước khi Drive làm. DropBefore("", n) = cắt sau n request.
func DropBefore(op string, skip int) Fault {
	return Fault{Op: op, Skip: skip, Count: 1, Drop: DropBeforeApply}
}

// DropAfter: request khớp thứ skip+1 được Drive làm xong nhưng mất câu trả lời (1 lần).
func DropAfter(op string, skip int) Fault {
	return Fault{Op: op, Skip: skip, Count: 1, Drop: DropAfterApply}
}

// Token: access token client giả gửi kèm.
const Token = "fake-drive-token"

type entry struct {
	f    google.File
	data []byte
}

type session struct {
	target string // "" = tạo mới
	meta   metaIn
	mime   string
}

// metaIn: metadata client gửi. AppProperties giá trị null = gỡ khoá.
type metaIn struct {
	Name          *string            `json:"name"`
	MimeType      string             `json:"mimeType"`
	Parents       []string           `json:"parents"`
	AppProperties map[string]*string `json:"appProperties"`
	Trashed       *bool              `json:"trashed"`

	// addParents, removeParents: tham số truy vấn của lần chuyển thư mục (PATCH files/{id}?addParents=..&removeParents=..).
	addParents, removeParents []string
}

// FakeDrive: Drive giả. Dùng New; mọi hàm an toàn khi gọi song song.
type FakeDrive struct {
	Server *httptest.Server
	// PageSize: trần số tệp/thay đổi mỗi trang (0 = theo pageSize client gửi, mặc định 100).
	PageSize int

	mu       sync.Mutex
	files    map[string]*entry
	order    []string
	version  int64
	nextID   int
	changes  []string // fileId theo thứ tự thay đổi
	sessions map[string]*session
	faults   []*Fault
	requests int
	calls    map[string]int
}

// New chạy Drive giả, tự đóng khi test xong.
func New(t testing.TB) *FakeDrive {
	d := &FakeDrive{files: map[string]*entry{}, sessions: map[string]*session{}, calls: map[string]int{}}
	d.Server = httptest.NewServer(d)
	t.Cleanup(d.Server.Close)
	return d
}

// Configure trỏ client vào Drive giả.
func (d *FakeDrive) Configure(c *google.Client) {
	c.DriveBase = d.Server.URL + "/drive/v3"
	c.UploadBase = d.Server.URL + "/upload/drive/v3"
	c.HTTP = d.Server.Client()
}

// Client: client google trỏ vào Drive giả với Token.
func (d *FakeDrive) Client() *google.Client {
	c := google.New(func(context.Context) (string, error) { return Token, nil })
	d.Configure(c)
	return c
}

// Inject thêm một lỗi; nhiều lỗi cùng khớp thì lỗi thêm trước dùng trước.
func (d *FakeDrive) Inject(f Fault) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.faults = append(d.faults, &f)
	// Bỏ các kết nối rảnh đang giữ: request có lỗi phải đi trên kết nối mới, nếu không net/http gửi lại và che lỗi cắt.
	d.Server.CloseClientConnections()
}

// ClearFaults gỡ mọi lỗi đã gây.
func (d *FakeDrive) ClearFaults() {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.faults = nil
}

// Requests: tổng số request đã nhận.
func (d *FakeDrive) Requests() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.requests
}

// Calls: số request loại op đã nhận.
func (d *FakeDrive) Calls(op string) int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.calls[op]
}

// File: trạng thái hiện tại của tệp id.
func (d *FakeDrive) File(id string) (google.File, []byte, bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	e, ok := d.files[id]
	if !ok {
		return google.File{}, nil, false
	}
	return cloneFile(e.f), bytes.Clone(e.data), true
}

// Files: mọi tệp (kể cả trong thùng rác) theo thứ tự tạo.
func (d *FakeDrive) Files() []google.File {
	d.mu.Lock()
	defer d.mu.Unlock()
	out := make([]google.File, 0, len(d.order))
	for _, id := range d.order {
		out = append(out, cloneFile(d.files[id].f))
	}
	return out
}

// SetTrashed: giả lập chủ TK bỏ tệp vào / lấy tệp khỏi thùng rác trên web Drive.
func (d *FakeDrive) SetTrashed(id string, trashed bool) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	e, ok := d.files[id]
	if !ok {
		return false
	}
	e.f.Trashed = trashed
	d.touch(e)
	return true
}

// ---------- HTTP ----------

func (d *FakeDrive) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	op := classify(r)
	d.mu.Lock()
	d.requests++
	d.calls[op]++
	f := d.fault(op)
	faulty := len(d.faults) > 0
	d.mu.Unlock()

	// Khi có lỗi được gây thì không dùng lại kết nối: net/http tự gửi lại request bị cắt trên kết nối cũ, làm mất lỗi cắt kết nối đã gây.
	// Không có lỗi thì giữ kết nối: đóng sau mỗi request làm cạn cổng tạm của Windows (16.384 cổng, TIME_WAIT 120 giây).
	if faulty {
		w.Header().Set("Connection", "close")
	}
	if r.Header.Get("Authorization") != "Bearer "+Token {
		writeErr(w, http.StatusUnauthorized, "authError", "Invalid Credentials")
		return
	}
	switch {
	case f == nil:
		d.handle(w, r, op)
	case f.Drop == DropBeforeApply:
		drop(w)
	case f.Drop == DropAfterApply:
		d.handle(httptest.NewRecorder(), r, op)
		drop(w)
	default:
		writeErr(w, f.Status, f.Reason, "injected "+f.Reason)
	}
}

// fault: lỗi áp cho request này (gọi khi giữ mu).
func (d *FakeDrive) fault(op string) *Fault {
	for _, f := range d.faults {
		if f.Op != "" && f.Op != op {
			continue
		}
		if f.Count > 0 && f.fired >= f.Count {
			continue
		}
		f.seen++
		if f.seen <= f.Skip {
			continue
		}
		f.fired++
		cp := *f
		return &cp
	}
	return nil
}

func drop(w http.ResponseWriter) {
	hj, ok := w.(http.Hijacker)
	if !ok {
		panic("googletest: ResponseWriter không hijack được")
	}
	conn, _, err := hj.Hijack()
	if err == nil {
		_ = conn.Close()
	}
}

func classify(r *http.Request) string {
	p := r.URL.Path
	rest, isFile := strings.CutPrefix(p, "/drive/v3/files/")
	switch {
	case p == "/drive/v3/files" && r.Method == http.MethodGet:
		return OpList
	case p == "/drive/v3/files" && r.Method == http.MethodPost:
		return OpCreate
	case isFile && strings.HasSuffix(rest, "/copy") && r.Method == http.MethodPost:
		return OpCopy
	case isFile && r.Method == http.MethodGet && r.URL.Query().Get("alt") == "media":
		return OpDownload
	case isFile && r.Method == http.MethodGet:
		return OpGet
	case isFile && r.Method == http.MethodPatch:
		return OpUpdate
	case p == "/drive/v3/changes/startPageToken" && r.Method == http.MethodGet:
		return OpChangesStart
	case p == "/drive/v3/changes" && r.Method == http.MethodGet:
		return OpChanges
	case p == "/upload/drive/v3/files" && r.Method == http.MethodPost:
		return OpUploadCreate
	case strings.HasPrefix(p, "/upload/drive/v3/files/") && r.Method == http.MethodPatch:
		return OpUploadUpdate
	case strings.HasPrefix(p, "/upload/session/") && r.Method == http.MethodPut:
		return OpUploadSession
	}
	return "unsupported"
}

func (d *FakeDrive) handle(w http.ResponseWriter, r *http.Request, op string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	q := r.URL.Query()
	fileID := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/drive/v3/files/"), "/copy")
	switch op {
	case OpGet:
		e, ok := d.files[fileID]
		if !ok {
			writeErr(w, http.StatusNotFound, "notFound", "File not found: "+fileID)
			return
		}
		writeJSON(w, e.f)
	case OpDownload:
		e, ok := d.files[fileID]
		if !ok {
			writeErr(w, http.StatusNotFound, "notFound", "File not found: "+fileID)
			return
		}
		if e.f.MimeType == google.FolderMime {
			writeErr(w, http.StatusForbidden, "fileNotDownloadable", "Only files with binary content can be downloaded")
			return
		}
		w.Header().Set("Content-Type", e.f.MimeType)
		_, _ = w.Write(e.data)
	case OpList:
		d.list(w, q)
	case OpCreate:
		var m metaIn
		if !decodeJSON(w, r.Body, &m) {
			return
		}
		d.create(w, m, m.MimeType, nil)
	case OpUpdate:
		var m metaIn
		if !decodeJSON(w, r.Body, &m) {
			return
		}
		m.addParents, m.removeParents = splitIDs(q.Get("addParents")), splitIDs(q.Get("removeParents"))
		d.update(w, fileID, m, "", nil, false)
	case OpCopy:
		var m metaIn
		if !decodeJSON(w, r.Body, &m) {
			return
		}
		d.copy(w, fileID, m)
	case OpChangesStart:
		writeJSON(w, map[string]string{"startPageToken": strconv.Itoa(len(d.changes))})
	case OpChanges:
		d.changeList(w, q)
	case OpUploadCreate, OpUploadUpdate:
		target := ""
		if op == OpUploadUpdate {
			target = strings.TrimPrefix(r.URL.Path, "/upload/drive/v3/files/")
			if _, ok := d.files[target]; !ok {
				writeErr(w, http.StatusNotFound, "notFound", "File not found: "+target)
				return
			}
		}
		d.upload(w, r, target)
	case OpUploadSession:
		sid := strings.TrimPrefix(r.URL.Path, "/upload/session/")
		s, ok := d.sessions[sid]
		if !ok {
			writeErr(w, http.StatusNotFound, "notFound", "upload session not found")
			return
		}
		data, err := io.ReadAll(r.Body)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "badContent", err.Error())
			return
		}
		delete(d.sessions, sid)
		if s.target == "" {
			d.create(w, s.meta, s.mime, data)
		} else {
			d.update(w, s.target, s.meta, s.mime, data, true)
		}
	default:
		writeErr(w, http.StatusMethodNotAllowed, "methodNotAllowed", r.Method+" "+r.URL.Path)
	}
}

func (d *FakeDrive) upload(w http.ResponseWriter, r *http.Request, target string) {
	switch r.URL.Query().Get("uploadType") {
	case "multipart":
		m, mt, data, err := readMultipart(r)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "badMultipart", err.Error())
			return
		}
		if target == "" {
			d.create(w, m, firstNonEmpty(m.MimeType, mt), data)
		} else {
			d.update(w, target, m, firstNonEmpty(m.MimeType, mt), data, true)
		}
	case "resumable":
		var m metaIn
		if r.ContentLength != 0 && !decodeJSON(w, r.Body, &m) {
			return
		}
		d.nextID++
		sid := fmt.Sprintf("s%d", d.nextID)
		d.sessions[sid] = &session{target: target, meta: m, mime: firstNonEmpty(m.MimeType, r.Header.Get("X-Upload-Content-Type"))}
		w.Header().Set("Location", d.Server.URL+"/upload/session/"+sid)
		w.WriteHeader(http.StatusOK)
	default:
		writeErr(w, http.StatusBadRequest, "badRequest", "unsupported uploadType")
	}
}

func readMultipart(r *http.Request) (metaIn, string, []byte, error) {
	var m metaIn
	mt, params, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mt != "multipart/related" {
		return m, "", nil, fmt.Errorf("content-type phải là multipart/related: %q", r.Header.Get("Content-Type"))
	}
	mr := multipart.NewReader(r.Body, params["boundary"])
	p, err := mr.NextPart()
	if err != nil {
		return m, "", nil, err
	}
	if err := json.NewDecoder(p).Decode(&m); err != nil {
		return m, "", nil, fmt.Errorf("đọc metadata: %w", err)
	}
	p, err = mr.NextPart()
	if err != nil {
		return m, "", nil, fmt.Errorf("thiếu phần nội dung: %w", err)
	}
	data, err := io.ReadAll(p)
	return m, p.Header.Get("Content-Type"), data, err
}

// ---------- thao tác trên kho (gọi khi giữ mu) ----------

func (d *FakeDrive) parentsOK(w http.ResponseWriter, parents []string) bool {
	for _, p := range parents {
		if e, ok := d.files[p]; p != "root" && (!ok || e.f.MimeType != google.FolderMime) {
			writeErr(w, http.StatusNotFound, "notFound", "File not found: "+p)
			return false
		}
	}
	return true
}

func (d *FakeDrive) create(w http.ResponseWriter, m metaIn, mimeType string, data []byte) {
	parents := m.Parents
	if len(parents) == 0 {
		parents = []string{"root"}
	}
	if !d.parentsOK(w, parents) {
		return
	}
	d.nextID++
	e := &entry{f: google.File{
		ID: fmt.Sprintf("f%05d", d.nextID), Name: "Untitled",
		MimeType: firstNonEmpty(mimeType, "application/octet-stream"), Parents: slices.Clone(parents),
	}}
	if m.Name != nil {
		e.f.Name = *m.Name
	}
	mergeProps(&e.f, m.AppProperties)
	if e.f.MimeType != google.FolderMime {
		setData(e, data)
	}
	d.files[e.f.ID] = e
	d.order = append(d.order, e.f.ID)
	d.touch(e)
	writeJSON(w, e.f)
}

func (d *FakeDrive) update(w http.ResponseWriter, id string, m metaIn, mimeType string, data []byte, hasData bool) {
	e, ok := d.files[id]
	if !ok {
		writeErr(w, http.StatusNotFound, "notFound", "File not found: "+id)
		return
	}
	if len(m.Parents) > 0 {
		writeErr(w, http.StatusForbidden, "fieldNotWritable", "The resource body includes fields which are not directly writable.")
		return
	}
	if !d.parentsOK(w, m.addParents) {
		return
	}
	e.f.Parents = slices.DeleteFunc(e.f.Parents, func(p string) bool { return slices.Contains(m.removeParents, p) })
	for _, p := range m.addParents {
		if !slices.Contains(e.f.Parents, p) {
			e.f.Parents = append(e.f.Parents, p)
		}
	}
	if m.Name != nil {
		e.f.Name = *m.Name
	}
	if m.Trashed != nil {
		e.f.Trashed = *m.Trashed
	}
	if mimeType != "" {
		e.f.MimeType = mimeType
	}
	mergeProps(&e.f, m.AppProperties)
	if hasData {
		setData(e, data)
	}
	d.touch(e)
	writeJSON(w, e.f)
}

func (d *FakeDrive) copy(w http.ResponseWriter, id string, m metaIn) {
	src, ok := d.files[id]
	if !ok {
		writeErr(w, http.StatusNotFound, "notFound", "File not found: "+id)
		return
	}
	if src.f.MimeType == google.FolderMime {
		writeErr(w, http.StatusForbidden, "cannotCopyFile", "folders cannot be copied")
		return
	}
	if m.Name == nil {
		name := "Copy of " + src.f.Name
		m.Name = &name
	}
	if len(m.Parents) == 0 {
		m.Parents = src.f.Parents
	}
	props := map[string]*string{}
	for k, v := range src.f.AppProperties {
		props[k] = &v
	}
	for k, v := range m.AppProperties {
		props[k] = v
	}
	m.AppProperties = props
	d.create(w, m, src.f.MimeType, bytes.Clone(src.data))
}

// touch: tệp vừa đổi => version mới + một mục trong changes feed.
func (d *FakeDrive) touch(e *entry) {
	d.version++
	e.f.Version = d.version
	e.f.ModifiedTime = time.Now().UTC().Format(time.RFC3339Nano)
	d.changes = append(d.changes, e.f.ID)
}

// splitIDs: danh sách mã tách bằng dấu phẩy trong tham số truy vấn (rỗng = không có mã nào).
func splitIDs(s string) []string {
	if s == "" {
		return nil
	}
	return strings.Split(s, ",")
}

func setData(e *entry, data []byte) {
	sum := md5.Sum(data)
	e.data = bytes.Clone(data)
	e.f.Md5Checksum = hex.EncodeToString(sum[:])
	e.f.Size = int64(len(data))
}

// mergeProps: như Drive, khoá mới ghi đè, khoá có giá trị null bị gỡ, khoá không nhắc tới giữ nguyên.
func mergeProps(f *google.File, in map[string]*string) {
	for k, v := range in {
		if v == nil {
			delete(f.AppProperties, k)
			continue
		}
		if f.AppProperties == nil {
			f.AppProperties = map[string]string{}
		}
		f.AppProperties[k] = *v
	}
	if len(f.AppProperties) == 0 {
		f.AppProperties = nil
	}
}

func (d *FakeDrive) pageSize(q map[string][]string) int {
	n := 100
	if v, err := strconv.Atoi(first(q["pageSize"])); err == nil && v > 0 {
		n = v
	}
	if d.PageSize > 0 && d.PageSize < n {
		n = d.PageSize
	}
	return n
}

func (d *FakeDrive) list(w http.ResponseWriter, q map[string][]string) {
	match, err := parseQuery(first(q["q"]))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid", "Invalid Value: "+err.Error())
		return
	}
	var all []google.File
	for _, id := range d.order {
		if f := d.files[id].f; match(f) {
			all = append(all, f)
		}
	}
	start, end, next, ok := page(first(q["pageToken"]), len(all), d.pageSize(q))
	if !ok {
		writeErr(w, http.StatusBadRequest, "invalid", "Invalid pageToken")
		return
	}
	out := map[string]any{"files": nonNil(all[start:end])}
	if next != "" {
		out["nextPageToken"] = next
	}
	writeJSON(w, out)
}

func (d *FakeDrive) changeList(w http.ResponseWriter, q map[string][]string) {
	tok, err := strconv.Atoi(first(q["pageToken"]))
	if err != nil || tok < 0 || tok > len(d.changes) {
		writeErr(w, http.StatusBadRequest, "invalid", "Invalid Value: pageToken")
		return
	}
	end := min(tok+d.pageSize(q), len(d.changes))
	items := []map[string]any{}
	for _, id := range d.changes[tok:end] {
		items = append(items, map[string]any{"kind": "drive#change", "changeType": "file", "fileId": id, "removed": false, "file": d.files[id].f})
	}
	out := map[string]any{"changes": items}
	if end < len(d.changes) {
		out["nextPageToken"] = strconv.Itoa(end)
	} else {
		out["newStartPageToken"] = strconv.Itoa(end)
	}
	writeJSON(w, out)
}

// page: pageToken là vị trí bắt đầu.
func page(token string, total, size int) (start, end int, next string, ok bool) {
	if token != "" {
		var err error
		if start, err = strconv.Atoi(token); err != nil || start < 0 || start > total {
			return 0, 0, "", false
		}
	}
	end = min(start+size, total)
	if end < total {
		next = strconv.Itoa(end)
	}
	return start, end, next, true
}

// ---------- truy vấn q ----------

const strLit = `'((?:[^'\\]|\\.)*)'`

var (
	reParent  = regexp.MustCompile(`^` + strLit + `\s+in\s+parents`)
	reName    = regexp.MustCompile(`^name\s*=\s*` + strLit)
	reTrashed = regexp.MustCompile(`^trashed\s*=\s*(true|false)`)
	reAppProp = regexp.MustCompile(`^appProperties\s+has\s+\{\s*key\s*=\s*` + strLit + `\s+and\s+value\s*=\s*` + strLit + `\s*\}`)
	reAnd     = regexp.MustCompile(`^\s+and\s+`)
)

// parseQuery hiểu các điều kiện client google gửi, nối bằng "and". Điều kiện lạ => lỗi (test bắt được client gửi sai).
func parseQuery(q string) (func(google.File) bool, error) {
	var preds []func(google.File) bool
	s := strings.TrimSpace(q)
	for s != "" {
		var m []string
		switch {
		case match(reParent, &s, &m):
			p := unquote(m[1])
			preds = append(preds, func(f google.File) bool { return slices.Contains(f.Parents, p) })
		case match(reName, &s, &m):
			n := unquote(m[1])
			preds = append(preds, func(f google.File) bool { return f.Name == n })
		case match(reTrashed, &s, &m):
			t := m[1] == "true"
			preds = append(preds, func(f google.File) bool { return f.Trashed == t })
		case match(reAppProp, &s, &m):
			k, v := unquote(m[1]), unquote(m[2])
			preds = append(preds, func(f google.File) bool { got, ok := f.AppProperties[k]; return ok && got == v })
		default:
			return nil, fmt.Errorf("q không hỗ trợ: %q", s)
		}
		if s == "" {
			break
		}
		if !match(reAnd, &s, &m) {
			return nil, fmt.Errorf("q thiếu 'and' trước: %q", s)
		}
	}
	return func(f google.File) bool {
		for _, p := range preds {
			if !p(f) {
				return false
			}
		}
		return true
	}, nil
}

func match(re *regexp.Regexp, s *string, m *[]string) bool {
	*m = re.FindStringSubmatch(*s)
	if *m == nil {
		return false
	}
	*s = (*s)[len((*m)[0]):]
	return true
}

func unquote(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+1 < len(s) {
			i++
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

// ---------- tiện ích ----------

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=UTF-8")
	_ = json.NewEncoder(w).Encode(v)
}

// writeErr: định dạng lỗi Drive v3 ({"error":{"code","message","errors":[{"reason"}]}}).
func writeErr(w http.ResponseWriter, status int, reason, msg string) {
	w.Header().Set("Content-Type", "application/json; charset=UTF-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]any{
		"code": status, "message": msg,
		"errors": []map[string]string{{"domain": "global", "reason": reason, "message": msg}},
	}})
}

func decodeJSON(w http.ResponseWriter, body io.Reader, v any) bool {
	if err := json.NewDecoder(body).Decode(v); err != nil && err != io.EOF {
		writeErr(w, http.StatusBadRequest, "parseError", "Parse Error: "+err.Error())
		return false
	}
	return true
}

func cloneFile(f google.File) google.File {
	f.Parents = slices.Clone(f.Parents)
	if f.AppProperties != nil {
		p := make(map[string]string, len(f.AppProperties))
		for k, v := range f.AppProperties {
			p[k] = v
		}
		f.AppProperties = p
	}
	return f
}

func nonNil(fs []google.File) []google.File {
	if fs == nil {
		return []google.File{}
	}
	return fs
}

func first(v []string) string {
	if len(v) == 0 {
		return ""
	}
	return v[0]
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}
