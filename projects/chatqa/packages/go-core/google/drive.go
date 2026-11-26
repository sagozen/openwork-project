package google

// Drive v3 cho đồng bộ dữ liệu (docs/ARCHITECTURE.md mục 6): đọc/ghi tệp kèm appProperties, tìm theo thư mục cha,
// tên hoặc appProperties, tải về, sao chép (sao lưu), và changes feed để kéo thay đổi.
// KHÔNG có xoá, dọn thùng rác hay xoá vĩnh viễn: app không bao giờ xoá dữ liệu trên Drive (test quét mã nguồn).

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"strconv"
	"strings"
)

// FileFields: các trường tệp đồng bộ cần (mặc định của GetFile, list, changes).
const FileFields = "id,name,mimeType,version,md5Checksum,size,appProperties,trashed,parents,modifiedTime"

// DefaultResumableAbove: trên 5 MB thì dùng resumable upload (Drive khuyên multipart cho tệp nhỏ).
const DefaultResumableAbove = 5 << 20

// FileMeta: metadata khi tạo / ghi đè. Trường rỗng không gửi. AppProperties gộp vào khoá sẵn có (khoá không nhắc
// tới giữ nguyên). Parents chỉ dùng khi tạo; ghi đè không chuyển thư mục.
type FileMeta struct {
	Name          string            `json:"name,omitempty"`
	MimeType      string            `json:"mimeType,omitempty"`
	Parents       []string          `json:"parents,omitempty"`
	AppProperties map[string]string `json:"appProperties,omitempty"`
}

// Change: một mục của changes feed.
type Change struct {
	FileID  string `json:"fileId"`
	Removed bool   `json:"removed"`
	File    *File  `json:"file"`
}

// ChangeList: một trang changes. NextPageToken rỗng = trang cuối, khi đó NewStartPageToken là token cho lần kéo sau.
type ChangeList struct {
	Changes           []Change `json:"changes"`
	NextPageToken     string   `json:"nextPageToken"`
	NewStartPageToken string   `json:"newStartPageToken"`
}

func fieldsOr(fields string) string {
	if fields == "" {
		return FileFields
	}
	return fields
}

// GetFile đọc metadata tệp; fields rỗng = FileFields.
func (c *Client) GetFile(ctx context.Context, id, fields string) (*File, error) {
	var f File
	u := fmt.Sprintf("%s/files/%s?fields=%s", c.DriveBase, url.PathEscape(id), url.QueryEscape(fieldsOr(fields)))
	if err := c.doJSON(ctx, http.MethodGet, u, nil, &f); err != nil {
		return nil, err
	}
	return &f, nil
}

// CreateFile tạo tệp. data nil = chỉ metadata (vd thư mục, MimeType = FolderMime); không thì tải nội dung lên
// (multipart, trên ResumableAbove thì resumable). Trả tệp với FileFields (version, appProperties...).
func (c *Client) CreateFile(ctx context.Context, meta FileMeta, mimeType string, data []byte) (*File, error) {
	if data == nil {
		var f File
		if err := c.doJSON(ctx, http.MethodPost, c.DriveBase+"/files?fields="+url.QueryEscape(FileFields), meta, &f); err != nil {
			return nil, err
		}
		return &f, nil
	}
	return c.upload(ctx, http.MethodPost, c.UploadBase+"/files", meta, mimeType, data)
}

// UpdateFile ghi đè tệp id tại chỗ. data nil = chỉ sửa metadata; data khác nil (kể cả rỗng) = thay nội dung.
// meta.Parents bị bỏ qua (ghi đè không chuyển thư mục).
func (c *Client) UpdateFile(ctx context.Context, id string, meta FileMeta, mimeType string, data []byte) (*File, error) {
	meta.Parents = nil
	if data == nil {
		var f File
		u := fmt.Sprintf("%s/files/%s?fields=%s", c.DriveBase, url.PathEscape(id), url.QueryEscape(FileFields))
		if err := c.doJSON(ctx, http.MethodPatch, u, meta, &f); err != nil {
			return nil, err
		}
		return &f, nil
	}
	return c.upload(ctx, http.MethodPatch, c.UploadBase+"/files/"+url.PathEscape(id), meta, mimeType, data)
}

// MoveFile chuyển tệp id sang thư mục addParent và bỏ khỏi thư mục removeParent (rỗng = không bỏ thư mục nào). Chỉ
// sửa metadata: mã tệp, nội dung và appProperties giữ nguyên.
func (c *Client) MoveFile(ctx context.Context, id, addParent, removeParent string) (*File, error) {
	if addParent == "" {
		return nil, errors.New("MoveFile: thiếu thư mục đích")
	}
	v := url.Values{"addParents": {addParent}, "fields": {FileFields}}
	if removeParent != "" {
		v.Set("removeParents", removeParent)
	}
	var f File
	u := fmt.Sprintf("%s/files/%s?%s", c.DriveBase, url.PathEscape(id), v.Encode())
	if err := c.doJSON(ctx, http.MethodPatch, u, struct{}{}, &f); err != nil {
		return nil, err
	}
	return &f, nil
}

func (c *Client) upload(ctx context.Context, method, base string, meta FileMeta, mimeType string, data []byte) (*File, error) {
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}
	limit := c.ResumableAbove
	if limit <= 0 {
		limit = DefaultResumableAbove
	}
	fields := "&fields=" + url.QueryEscape(FileFields)
	var f File
	if len(data) <= limit {
		body, ct, err := multipartBody(meta, mimeType, data)
		if err != nil {
			return nil, err
		}
		if err := c.do(ctx, method, base+"?uploadType=multipart"+fields, body, ct, &f); err != nil {
			return nil, err
		}
		return &f, nil
	}
	// Resumable: mở phiên (metadata), rồi gửi toàn bộ nội dung vào địa chỉ phiên. Đứt giữa chừng thì lần thử sau mở
	// phiên mới; Drive chỉ tạo/đổi tệp khi nhận đủ nội dung.
	m, err := json.Marshal(meta)
	if err != nil {
		return nil, err
	}
	hdr := http.Header{
		"X-Upload-Content-Type":   {mimeType},
		"X-Upload-Content-Length": {strconv.Itoa(len(data))},
	}
	res, err := c.send(ctx, method, base+"?uploadType=resumable"+fields, bytes.NewReader(m), "application/json; charset=UTF-8", hdr)
	if err != nil {
		return nil, err
	}
	_ = res.Body.Close()
	loc := res.Header.Get("Location")
	if loc == "" {
		return nil, errors.New("Drive không trả địa chỉ phiên resumable upload (Location)")
	}
	if err := c.do(ctx, http.MethodPut, loc, bytes.NewReader(data), mimeType, &f); err != nil {
		return nil, err
	}
	return &f, nil
}

func multipartBody(meta FileMeta, mimeType string, data []byte) (io.Reader, string, error) {
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	mp, err := w.CreatePart(textproto.MIMEHeader{"Content-Type": {"application/json; charset=UTF-8"}})
	if err != nil {
		return nil, "", err
	}
	if err := json.NewEncoder(mp).Encode(meta); err != nil {
		return nil, "", err
	}
	fp, err := w.CreatePart(textproto.MIMEHeader{"Content-Type": {mimeType}})
	if err != nil {
		return nil, "", err
	}
	if _, err := fp.Write(data); err != nil {
		return nil, "", err
	}
	if err := w.Close(); err != nil {
		return nil, "", err
	}
	return &buf, "multipart/related; boundary=" + w.Boundary(), nil
}

// quote: chuỗi trong truy vấn q của Drive ('...' với \ và ' được thoát).
func quote(s string) string {
	return "'" + strings.NewReplacer(`\`, `\\`, `'`, `\'`).Replace(s) + "'"
}

type fileList struct {
	Files         []File `json:"files"`
	NextPageToken string `json:"nextPageToken"`
}

func (c *Client) list(ctx context.Context, q, pageToken string) (*fileList, error) {
	v := url.Values{"q": {q}, "pageSize": {"1000"}, "fields": {"nextPageToken,files(" + FileFields + ")"}}
	if pageToken != "" {
		v.Set("pageToken", pageToken)
	}
	var r fileList
	if err := c.doJSON(ctx, http.MethodGet, c.DriveBase+"/files?"+v.Encode(), nil, &r); err != nil {
		return nil, err
	}
	return &r, nil
}

// FindChild: tệp tên name trong thư mục parent (không tính thùng rác); nil nếu không có. Trùng tên thì lấy tệp đầu.
func (c *Client) FindChild(ctx context.Context, parent, name string) (*File, error) {
	r, err := c.list(ctx, fmt.Sprintf("name = %s and %s in parents and trashed = false", quote(name), quote(parent)), "")
	if err != nil {
		return nil, err
	}
	if len(r.Files) == 0 {
		return nil, nil
	}
	return &r.Files[0], nil
}

// ListChildren: một trang tệp trong thư mục parent (không tính thùng rác). next rỗng = trang cuối.
func (c *Client) ListChildren(ctx context.Context, parent, pageToken string) (files []File, next string, err error) {
	r, err := c.list(ctx, quote(parent)+" in parents and trashed = false", pageToken)
	if err != nil {
		return nil, "", err
	}
	return r.Files, r.NextPageToken, nil
}

// FindByAppProperty: mọi tệp (không tính thùng rác) có appProperties[key] = value, đi hết các trang.
func (c *Client) FindByAppProperty(ctx context.Context, key, value string) ([]File, error) {
	q := fmt.Sprintf("appProperties has { key=%s and value=%s } and trashed = false", quote(key), quote(value))
	var out []File
	tok := ""
	for {
		r, err := c.list(ctx, q, tok)
		if err != nil {
			return nil, err
		}
		out = append(out, r.Files...)
		if r.NextPageToken == "" {
			return out, nil
		}
		tok = r.NextPageToken
	}
}

// Download tải nội dung tệp.
func (c *Client) Download(ctx context.Context, id string) ([]byte, error) {
	res, err := c.send(ctx, http.MethodGet, fmt.Sprintf("%s/files/%s?alt=media", c.DriveBase, url.PathEscape(id)), nil, "", nil)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	return io.ReadAll(res.Body)
}

// CopyFile sao chép tệp id vào thư mục parent với tên name (appProperties đi theo bản sao).
func (c *Client) CopyFile(ctx context.Context, id, parent, name string) (*File, error) {
	var f File
	u := fmt.Sprintf("%s/files/%s/copy?fields=%s", c.DriveBase, url.PathEscape(id), url.QueryEscape(FileFields))
	if err := c.doJSON(ctx, http.MethodPost, u, FileMeta{Name: name, Parents: []string{parent}}, &f); err != nil {
		return nil, err
	}
	return &f, nil
}

// StartPageToken: token để bắt đầu theo dõi thay đổi từ bây giờ.
func (c *Client) StartPageToken(ctx context.Context) (string, error) {
	var r struct {
		StartPageToken string `json:"startPageToken"`
	}
	if err := c.doJSON(ctx, http.MethodGet, c.DriveBase+"/changes/startPageToken", nil, &r); err != nil {
		return "", err
	}
	return r.StartPageToken, nil
}

// Changes: một trang thay đổi kể từ pageToken.
func (c *Client) Changes(ctx context.Context, pageToken string) (*ChangeList, error) {
	v := url.Values{
		"pageToken": {pageToken}, "pageSize": {"1000"}, "spaces": {"drive"},
		"fields": {"newStartPageToken,nextPageToken,changes(fileId,removed,file(" + FileFields + "))"},
	}
	var r ChangeList
	if err := c.doJSON(ctx, http.MethodGet, c.DriveBase+"/changes?"+v.Encode(), nil, &r); err != nil {
		return nil, err
	}
	return &r, nil
}
