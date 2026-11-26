// Package google: client REST tối giản cho Drive v3 và Sheets v4 (không kéo SDK Google nặng).
// Access token lấy từ Worker (token của chủ tài khoản, scope drive.file).
package google

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"

	"deskcore/netprog"
)

// TokenSource trả access token còn hạn.
type TokenSource func(ctx context.Context) (string, error)

type Client struct {
	Token TokenSource
	HTTP  *http.Client
	// Base cho test; mặc định Google.
	SheetsBase, DriveBase, UploadBase string
	// ResumableAbove: tệp lớn hơn ngưỡng này (byte) tải lên bằng resumable upload; 0 = DefaultResumableAbove.
	ResumableAbove int
}

func New(ts TokenSource) *Client {
	return &Client{
		Token:          ts,
		HTTP:           &http.Client{Timeout: 60 * time.Second},
		SheetsBase:     "https://sheets.googleapis.com/v4",
		DriveBase:      "https://www.googleapis.com/drive/v3",
		UploadBase:     "https://www.googleapis.com/upload/drive/v3",
		ResumableAbove: DefaultResumableAbove,
	}
}

// Error: lỗi Google API. Reason lấy từ error.errors[0].reason (vd storageQuotaExceeded).
type Error struct {
	Status  int
	Message string
	Reason  string
	// root: không thấy thư mục gốc HS Desk (404) => coi như mất quyền (NoAccess).
	root bool
}

func (e *Error) Error() string { return fmt.Sprintf("google_api: %d %s", e.Status, e.Message) }

// Mã lỗi máy của Drive (contracts/errors.json).
const (
	CodeDriveFull     = "drive_full"
	CodeDriveBusy     = "drive_busy"
	CodeDriveNoAccess = "drive_no_access"
)

// Code: mã lỗi máy cho UI; "" nếu không thuộc các lỗi Drive đã biết.
//   - drive_full: Drive chủ TK hết dung lượng.
//   - drive_busy: bị giới hạn tần suất (429 hoặc 403 rateLimitExceeded/userRateLimitExceeded).
//   - drive_no_access: app mất quyền với tệp, hoặc không thấy thư mục gốc (NoAccess); cần Quản lý kết nối lại.
func (e *Error) Code() string {
	switch {
	case e.Reason == "storageQuotaExceeded":
		return CodeDriveFull
	case e.Status == 429 || e.Reason == "rateLimitExceeded" || e.Reason == "userRateLimitExceeded":
		return CodeDriveBusy
	case e.root, e.Status == 403 && (e.Reason == "insufficientFilePermissions" || e.Reason == "appNotAuthorizedToFile"):
		return CodeDriveNoAccess
	}
	return ""
}

// ErrorCode: như Code, để apperr.CodeOf đọc được.
func (e *Error) ErrorCode() string { return e.Code() }

// Retryable: token hết hạn (401), lỗi phía Google (5xx) và các lỗi Drive có mã (đầy, bận, mất quyền) thì thử lại
// được (offline.Retryable): dữ liệu vẫn giữ trên máy, giãn cách tới khi hết lỗi.
func (e *Error) Retryable() bool { return e.Status == 401 || e.Status >= 500 || e.Code() != "" }

// NeedsAdmin: lỗi chỉ hết khi Quản lý kết nối lại Drive.
func (e *Error) NeedsAdmin() bool { return e.Code() == CodeDriveNoAccess }

// NoAccess: dùng khi thư mục gốc HS Desk trả 404 (bị xoá hẳn hoặc app không còn thấy): đổi thành drive_no_access.
// Lỗi khác giữ nguyên.
func NoAccess(err error) error {
	var ge *Error
	if errors.As(err, &ge) && ge.Status == http.StatusNotFound {
		cp := *ge
		cp.root = true
		return &cp
	}
	return err
}

func (c *Client) do(ctx context.Context, method, u string, body io.Reader, contentType string, out any) error {
	res, err := c.send(ctx, method, u, body, contentType, nil)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if out == nil {
		return nil
	}
	return json.NewDecoder(res.Body).Decode(out)
}

// send gửi request kèm token; mã >= 300 thành *Error. Người gọi đóng Body khi không lỗi.
func (c *Client) send(ctx context.Context, method, u string, body io.Reader, contentType string, hdr http.Header) (*http.Response, error) {
	tok, err := c.Token(ctx)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, method, u, body)
	if err != nil {
		return nil, err
	}
	if body != nil && netprog.From(ctx) != nil {
		// Chỉ thay nơi đọc byte; ContentLength và GetBody do NewRequest đặt từ thân gốc vẫn giữ nguyên.
		req.Body = io.NopCloser(netprog.Reader(ctx, body, bodyLen(body)))
	}
	for k, v := range hdr {
		req.Header[k] = v
	}
	req.Header.Set("Authorization", "Bearer "+tok)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	if res.StatusCode >= 300 {
		defer res.Body.Close()
		return nil, parseError(res)
	}
	res.Body = netprog.ReadCloser(ctx, res.Body, res.ContentLength)
	return res, nil
}

// bodyLen: độ dài thân yêu cầu khi biết trước (bytes.Reader/Buffer), 0 nếu không.
func bodyLen(r io.Reader) int64 {
	if l, ok := r.(interface{ Len() int }); ok {
		return int64(l.Len())
	}
	return 0
}

func parseError(res *http.Response) error {
	var e struct {
		Error struct {
			Message string `json:"message"`
			Errors  []struct {
				Reason string `json:"reason"`
			} `json:"errors"`
		} `json:"error"`
	}
	_ = json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&e)
	ge := &Error{Status: res.StatusCode, Message: e.Error.Message}
	if len(e.Error.Errors) > 0 {
		ge.Reason = e.Error.Errors[0].Reason
	}
	return ge
}

func (c *Client) doJSON(ctx context.Context, method, u string, in, out any) error {
	var body io.Reader
	if in != nil {
		b, err := json.Marshal(in)
		if err != nil {
			return err
		}
		body = bytes.NewReader(b)
	}
	return c.do(ctx, method, u, body, "application/json", out)
}

// ---------- Sheets ----------

// GetValues đọc 1 vùng, vd "Yêu cầu!A2:P".
func (c *Client) GetValues(ctx context.Context, sheetID, rng string) ([][]any, error) {
	var r struct {
		Values [][]any `json:"values"`
	}
	u := fmt.Sprintf("%s/spreadsheets/%s/values/%s?valueRenderOption=UNFORMATTED_VALUE", c.SheetsBase, sheetID, url.PathEscape(rng))
	err := c.doJSON(ctx, http.MethodGet, u, nil, &r)
	return r.Values, err
}

// UpdateValues ghi đè 1 vùng. App chỉ nên ghi vào vùng cột của mình (vd HS Desk: docs/ARCHITECTURE.md mục 6).
func (c *Client) UpdateValues(ctx context.Context, sheetID, rng string, values [][]any) error {
	u := fmt.Sprintf("%s/spreadsheets/%s/values/%s?valueInputOption=USER_ENTERED", c.SheetsBase, sheetID, url.PathEscape(rng))
	return c.doJSON(ctx, http.MethodPut, u, map[string]any{"range": rng, "values": values}, nil)
}

// AppendValues thêm dòng vào cuối bảng (Sổ dạy AI, Nhật ký).
func (c *Client) AppendValues(ctx context.Context, sheetID, rng string, values [][]any) error {
	u := fmt.Sprintf("%s/spreadsheets/%s/values/%s:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS",
		c.SheetsBase, sheetID, url.PathEscape(rng))
	return c.doJSON(ctx, http.MethodPost, u, map[string]any{"values": values}, nil)
}

// ---------- Drive ----------

type File struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	MimeType string `json:"mimeType"`
	// Các trường dưới chỉ có khi được yêu cầu trong fields (xem FileFields).
	// Version: tăng mỗi lần tệp đổi (nội dung hoặc metadata); Drive trả dạng chuỗi.
	Version       int64             `json:"version,string,omitempty"`
	Md5Checksum   string            `json:"md5Checksum,omitempty"`
	Size          int64             `json:"size,string,omitempty"`
	AppProperties map[string]string `json:"appProperties,omitempty"`
	Parents       []string          `json:"parents,omitempty"`
	Trashed       bool              `json:"trashed,omitempty"`
	ModifiedTime  string            `json:"modifiedTime,omitempty"`
}

const FolderMime = "application/vnd.google-apps.folder"

const SpreadsheetMime = "application/vnd.google-apps.spreadsheet"

// CreateFolder tạo thư mục (parent rỗng = gốc Drive của chủ TK).
func (c *Client) CreateFolder(ctx context.Context, name, parent string) (*File, error) {
	meta := FileMeta{Name: name, MimeType: FolderMime}
	if parent != "" {
		meta.Parents = []string{parent}
	}
	return c.CreateFile(ctx, meta, "", nil)
}

// CreateSpreadsheet tạo Google Sheet trong thư mục parent với các tab theo thứ tự tabs (tab đầu là tab mặc định đổi tên).
func (c *Client) CreateSpreadsheet(ctx context.Context, name, parent string, tabs []string) (*File, error) {
	meta := FileMeta{Name: name, MimeType: SpreadsheetMime}
	if parent != "" {
		meta.Parents = []string{parent}
	}
	f, err := c.CreateFile(ctx, meta, "", nil)
	if err != nil || len(tabs) == 0 {
		return f, err
	}
	reqs := []map[string]any{{"updateSheetProperties": map[string]any{
		"properties": map[string]any{"sheetId": 0, "title": tabs[0]}, "fields": "title"}}}
	for _, t := range tabs[1:] {
		reqs = append(reqs, map[string]any{"addSheet": map[string]any{"properties": map[string]any{"title": t}}})
	}
	u := fmt.Sprintf("%s/spreadsheets/%s:batchUpdate", c.SheetsBase, f.ID)
	return f, c.doJSON(ctx, http.MethodPost, u, map[string]any{"requests": reqs}, nil)
}

// ClearValues xoá giá trị một vùng (giữ định dạng), vd trước khi ghi lại cả tab ảnh chụp.
func (c *Client) ClearValues(ctx context.Context, sheetID, rng string) error {
	u := fmt.Sprintf("%s/spreadsheets/%s/values/%s:clear", c.SheetsBase, sheetID, url.PathEscape(rng))
	return c.doJSON(ctx, http.MethodPost, u, map[string]any{}, nil)
}

// Upload tải file lên thư mục parent (multipart; tệp lớn hơn ResumableAbove dùng resumable).
func (c *Client) Upload(ctx context.Context, name, parent, mimeType string, data io.Reader) (*File, error) {
	b, err := io.ReadAll(data)
	if err != nil {
		return nil, err
	}
	meta := FileMeta{Name: name}
	if parent != "" {
		meta.Parents = []string{parent}
	}
	return c.CreateFile(ctx, meta, mimeType, b)
}

// BatchGetColumns đọc nhiều vùng 1 CỘT trong 1 request (vd cột ID + cột stamp).
// Kết quả[i] = giá trị của vùng ranges[i], từ trên xuống.
func (c *Client) BatchGetColumns(ctx context.Context, sheetID string, ranges []string) ([][]any, error) {
	q := url.Values{"valueRenderOption": {"UNFORMATTED_VALUE"}, "majorDimension": {"COLUMNS"}}
	for _, r := range ranges {
		q.Add("ranges", r)
	}
	var r struct {
		ValueRanges []struct {
			Values [][]any `json:"values"`
		} `json:"valueRanges"`
	}
	u := fmt.Sprintf("%s/spreadsheets/%s/values:batchGet?%s", c.SheetsBase, sheetID, q.Encode())
	if err := c.doJSON(ctx, http.MethodGet, u, nil, &r); err != nil {
		return nil, err
	}
	out := make([][]any, len(ranges))
	for i, vr := range r.ValueRanges {
		if i < len(out) && len(vr.Values) > 0 {
			out[i] = vr.Values[0]
		}
	}
	return out, nil
}

// CellUpdate: ghi 1 vùng (A1 notation) trong BatchUpdate.
type CellUpdate struct {
	Range  string  `json:"range"`
	Values [][]any `json:"values"`
}

// BatchUpdate ghi nhiều vùng trong 1 request.
func (c *Client) BatchUpdate(ctx context.Context, sheetID string, data []CellUpdate) error {
	u := fmt.Sprintf("%s/spreadsheets/%s/values:batchUpdate", c.SheetsBase, sheetID)
	return c.doJSON(ctx, http.MethodPost, u, map[string]any{"valueInputOption": "USER_ENTERED", "data": data}, nil)
}
