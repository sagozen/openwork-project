// Package cloud: client gọi Cloudflare Worker.
package cloud

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// APIError: lỗi trả về từ Worker ({"error": "code"}).
type APIError struct {
	Code   string
	Status int
	// Cause: lỗi mạng gốc khi không nhận được phản hồi (Status = 0).
	Cause error
	// Body: phần còn lại của phản hồi lỗi (vd minutes khi khoá tạm, lockedAt khi khoá), nil nếu không có.
	Body map[string]any
}

func (e *APIError) Error() string {
	msg := fmt.Sprintf("%s: http %d", e.Code, e.Status)
	// Phản hồi gốc của nhà cung cấp AI (Worker kèm trong "upstream"): cho thấy lý do thật phía sau mã chung.
	if up, ok := e.Body["upstream"].(map[string]any); ok {
		code, _ := up["code"].(string)
		text, _ := up["message"].(string)
		if code != "" || text != "" {
			msg += fmt.Sprintf(" (nhà cung cấp: %s %s)", code, text)
		}
	}
	return msg
}
func (e *APIError) Unwrap() error     { return e.Cause }
func (e *APIError) ErrorCode() string { return e.Code }

type Client struct {
	Base string
	HTTP *http.Client
	// Session trả token phiên hiện tại ("" nếu chưa đăng nhập).
	Session func() string
	// Device trả id và hash của máy (gửi kèm để Worker kiểm tra license).
	Device func() (id, hash string)
	// Product: sản phẩm của exe (contracts/products.json), gửi kèm để Worker chọn đúng bản quyền và bản phát hành.
	Product string
}

func New(base, product string) *Client {
	return &Client{Base: strings.TrimRight(base, "/"), HTTP: &http.Client{Timeout: 30 * time.Second}, Product: product}
}

// Do gửi request JSON. body có thể là nil, []byte (JSON sẵn) hoặc struct.
func (c *Client) Do(ctx context.Context, method, path string, body, out any) error {
	return c.DoHeaders(ctx, nil, method, path, body, out)
}

// DoHeaders như Do, kèm header riêng cho lần gọi này (vd X-License-Token khi đẩy thao tác không có phiên).
func (c *Client) DoHeaders(ctx context.Context, hdr map[string]string, method, path string, body, out any) error {
	return c.do(ctx, c.HTTP, hdr, method, path, body, out)
}

// newRequest dựng request tới Worker kèm phiên, thông tin máy và header riêng.
func (c *Client) newRequest(ctx context.Context, hdr map[string]string, method, path string, body any) (*http.Request, error) {
	var rd io.Reader
	switch b := body.(type) {
	case nil:
	case []byte:
		rd = bytes.NewReader(b)
	default:
		buf, err := json.Marshal(b)
		if err != nil {
			return nil, err
		}
		rd = bytes.NewReader(buf)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.Base+"/api"+path, rd)
	if err != nil {
		return nil, err
	}
	if rd != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if _, own := hdr["Authorization"]; !own {
		c.authorize(req)
	} else {
		c.deviceHeaders(req)
	}
	for k, v := range hdr {
		if v != "" {
			req.Header.Set(k, v)
		}
	}
	return req, nil
}

// Authorize gắn phiên đăng nhập và thông tin máy của client này vào một request tới Worker (Authorization, X-Device-Id, X-Device-Hash).
// Dùng cho đường gọi không đi qua Do, ví dụ SDK của nhà cung cấp trỏ về Worker. Request không có phiên thì chỉ gắn thông tin máy.
func (c *Client) Authorize(req *http.Request) error {
	if req == nil {
		return errors.New("request is nil")
	}
	c.authorize(req)
	return nil
}

func (c *Client) authorize(req *http.Request) {
	if c.Session != nil {
		if t := c.Session(); t != "" {
			req.Header.Set("Authorization", "Bearer "+t)
		}
	}
	c.deviceHeaders(req)
}

func (c *Client) deviceHeaders(req *http.Request) {
	if c.Device != nil {
		id, hash := c.Device()
		if id != "" {
			req.Header.Set("X-Device-Id", id)
		}
		req.Header.Set("X-Device-Hash", hash)
	}
}

func (c *Client) do(ctx context.Context, hc *http.Client, hdr map[string]string, method, path string, body, out any) error {
	req, err := c.newRequest(ctx, hdr, method, path, body)
	if err != nil {
		return err
	}
	res, err := hc.Do(req)
	if err != nil {
		return &APIError{Code: "network", Status: 0, Cause: err}
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, 10<<20))
	if err != nil {
		return err
	}
	if res.StatusCode >= 300 {
		return apiError(res.StatusCode, data)
	}
	if out == nil {
		return nil
	}
	if raw, ok := out.(*json.RawMessage); ok {
		*raw = data
		return nil
	}
	return json.Unmarshal(data, out)
}

// apiError: lỗi Worker dạng {"error": "code", ...} thành APIError (các trường khác vào Body).
func apiError(status int, data []byte) *APIError {
	var e struct {
		Error string `json:"error"`
	}
	_ = json.Unmarshal(data, &e)
	var rest map[string]any
	_ = json.Unmarshal(data, &rest)
	delete(rest, "error")
	if e.Error == "" {
		e.Error = fmt.Sprintf("http_%d", status)
	}
	return &APIError{Code: e.Error, Status: status, Body: rest}
}

// ---------- Các API cụ thể ----------

// UserInfo: người dùng + quyền (worker/src/lib/auth.ts publicUser).
type UserInfo struct {
	ID     string   `json:"id"`
	Tenant string   `json:"tenant"`
	Name   string   `json:"name"`
	Role   string   `json:"role"`
	Apps   []string `json:"apps"`  // nil = mọi app bản quyền bật
	Perms  []string `json:"perms"` // quyền thao tác (contracts/permissions.json)
}

type LoginResp struct {
	Token string   `json:"token"`
	Exp   int64    `json:"exp"`
	User  UserInfo `json:"user"`
	// MustChangePassword: đăng nhập bằng mật khẩu tạm, chỉ được đổi mật khẩu (FR-007).
	MustChangePassword bool `json:"mustChangePassword"`
	// SessionVersion: users.session_version lúc cấp phiên; đổi/đặt lại mật khẩu ở nơi khác làm phiên này hết hiệu lực.
	SessionVersion int `json:"sessionVersion"`
	// ServerNow: giờ máy chủ lúc trả lời, mốc đồng hồ tin cậy cho chế độ offline.
	ServerNow int64 `json:"serverNow"`
	// Entitlement: ảnh chụp quyền ký Ed25519 để đăng nhập offline (chỉ khi không phải đổi mật khẩu).
	Entitlement string `json:"entitlement"`
}

// Login: máy Windows gửi mã máy để Worker đối chiếu công ty của bản quyền; công ty suy ra từ tài khoản, không nhập tay.
func (c *Client) Login(ctx context.Context, username, password, deviceID, deviceHash string) (*LoginResp, error) {
	var r LoginResp
	err := c.Do(ctx, "POST", "/v1/auth/login", map[string]string{
		"username": username, "password": password, "client": "desktop", "deviceId": deviceID, "deviceHash": deviceHash,
		"product": c.Product,
	}, &r)
	return &r, err
}

type LicenseResp struct {
	Token string `json:"token"`
	// DevicesUsed: số máy chưa thu hồi của công ty lúc cấp.
	DevicesUsed int `json:"devicesUsed"`
	Payload     struct {
		Dev string `json:"dev"`
		Iat int64  `json:"iat"` // giờ máy chủ lúc cấp: một lần kết nối
	} `json:"payload"`
}

func (c *Client) Activate(ctx context.Context, key, deviceHash, deviceName, appVersion string) (*LicenseResp, error) {
	var r LicenseResp
	err := c.Do(ctx, "POST", "/v1/license/activate", map[string]string{
		"licenseKey": key, "deviceHash": deviceHash, "deviceName": deviceName, "appVersion": appVersion,
		"product": c.Product,
	}, &r)
	return &r, err
}

func (c *Client) RefreshLicense(ctx context.Context, deviceID, deviceHash, appVersion string) (*LicenseResp, error) {
	var r LicenseResp
	err := c.Do(ctx, "POST", "/v1/license/refresh", map[string]string{
		"deviceId": deviceID, "deviceHash": deviceHash, "appVersion": appVersion,
		"product": c.Product,
	}, &r)
	return &r, err
}

type GoogleResources struct {
	RootFolderID *string `json:"rootFolderId"`
	VipoSheetID  *string `json:"vipoSheetId"`
	LogSheetID   *string `json:"logSheetId"`
	TeachSheetID *string `json:"teachSheetId"`
	// IndexSheetID: Sheet chỉ mục của sản phẩm khác HS Desk (ChatQASoftware: lượt chạy, thiết bị, cảnh báo cho PWA).
	IndexSheetID *string `json:"indexSheetId"`
}

type GoogleToken struct {
	AccessToken string          `json:"access_token"`
	ExpiresAt   int64           `json:"expires_at"`
	Resources   GoogleResources `json:"resources"`
}

type SessionResp struct {
	Token string    `json:"token"`
	Exp   int64     `json:"exp"`
	User  *UserInfo `json:"user"` // worker mới trả kèm quyền hiện tại; nil với worker cũ
	// ServerNow và Entitlement như LoginResp: mỗi lần gia hạn là một lần kết nối, làm mới đồng hồ tin cậy và ảnh chụp quyền offline.
	ServerNow          int64  `json:"serverNow"`
	Entitlement        string `json:"entitlement"`
	MustChangePassword bool   `json:"mustChangePassword"`
	SessionVersion     int    `json:"sessionVersion"`
}

// RefreshSession: gia hạn phiên đăng nhập còn hạn.
func (c *Client) RefreshSession(ctx context.Context) (*SessionResp, error) {
	var r SessionResp
	err := c.Do(ctx, "POST", "/v1/auth/refresh", nil, &r)
	return &r, err
}

// AIChat gọi AI qua Worker (/v1/ai/chat, OpenAI-compatible). Khoá API và ngân sách nằm ở Worker:
// lỗi trả về dạng APIError với mã ai_key_invalid | ai_budget_exceeded | ai_unavailable.
// Như AIMessages, không dùng trần 30 giây của các lệnh khác: hạn chót do context của bên gọi đặt (vd kiểm trùng quy
// tắc chờ đúng 30 giây rồi mới bỏ, trần của client sẽ cắt đúng ở mốc đó).
func (c *Client) AIChat(ctx context.Context, body, out any) error {
	long := *c.HTTP
	long.Timeout = aiMessagesTimeout
	return c.do(ctx, &long, nil, "POST", "/v1/ai/chat", body, out)
}

// AIMessages gọi Claude qua Worker (/v1/ai/messages, body theo Messages API; mô hình lấy từ cài đặt sản phẩm ở Worker).
// Lỗi như AIChat; câu trả lời có thêm billing (costVnd, budgetLeftVnd).
func (c *Client) AIMessages(ctx context.Context, body, out any) error {
	// Câu trả lời không stream tới hàng chục nghìn token có thể mất vài phút: không dùng trần 30 giây của các lệnh khác.
	long := *c.HTTP
	long.Timeout = aiMessagesTimeout
	return c.do(ctx, &long, nil, "POST", "/v1/ai/messages", body, out)
}

const aiMessagesTimeout = 10 * time.Minute

// AIMessagesStream gọi /v1/ai/messages với stream: true (body phải có "stream": true) và gọi onEvent với phần data
// của từng sự kiện SSE (JSON của Messages API: message_start, content_block_delta...). onEvent trả lỗi thì dừng đọc.
func (c *Client) AIMessagesStream(ctx context.Context, body any, onEvent func(data []byte) error) error {
	req, err := c.newRequest(ctx, nil, "POST", "/v1/ai/messages", body)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "text/event-stream")
	long := *c.HTTP
	long.Timeout = aiMessagesTimeout
	res, err := long.Do(req)
	if err != nil {
		return &APIError{Code: "network", Status: 0, Cause: err}
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		data, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
		return apiError(res.StatusCode, data)
	}
	sc := bufio.NewScanner(res.Body)
	sc.Buffer(make([]byte, 0, 64<<10), 8<<20)
	var data bytes.Buffer
	flush := func() error {
		if data.Len() == 0 {
			return nil
		}
		defer data.Reset()
		return onEvent(append([]byte(nil), data.Bytes()...))
	}
	for sc.Scan() {
		line := sc.Text()
		switch {
		case line == "":
			if err := flush(); err != nil {
				return err
			}
		case strings.HasPrefix(line, "data:"):
			if data.Len() > 0 {
				data.WriteByte('\n')
			}
			data.WriteString(strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
		}
	}
	if err := sc.Err(); err != nil {
		return &APIError{Code: "network", Status: 0, Cause: err}
	}
	return flush()
}

// SaveGoogleResources lưu ID tài nguyên Drive của sản phẩm của phiên (PUT /v1/google/resources); trường rỗng bị bỏ qua.
func (c *Client) SaveGoogleResources(ctx context.Context, res map[string]string) error {
	body := map[string]string{}
	for k, v := range res {
		if v != "" {
			body[k] = v
		}
	}
	return c.Do(ctx, "PUT", "/v1/google/resources", body, nil)
}

func (c *Client) GoogleToken(ctx context.Context) (*GoogleToken, error) {
	var r GoogleToken
	err := c.Do(ctx, "POST", "/v1/google/token", nil, &r)
	return &r, err
}

type ReleaseItem struct {
	Version   string `json:"version"`
	CoreAPI   int    `json:"coreApi"`
	URL       string `json:"url"`
	SHA256    string `json:"sha256"`
	Sig       string `json:"sig"`
	Size      int64  `json:"size"`
	Mandatory bool   `json:"mandatory"`
	Notes     string `json:"notes"`
}

type Manifest struct {
	UI  *ReleaseItem `json:"ui"`
	Bin *ReleaseItem `json:"bin"`
}

func (c *Client) Updates(ctx context.Context, channel, platform, uiVer, binVer string, coreAPI int) (*Manifest, error) {
	q := url.Values{"platform": {platform}, "ui": {uiVer}, "bin": {binVer}, "coreApi": {fmt.Sprint(coreAPI)}, "product": {c.Product}}
	var m Manifest
	err := c.Do(ctx, "GET", "/v1/updates/"+channel+"?"+q.Encode(), nil, &m)
	return &m, err
}

// HeartbeatResp: trả lời của /v1/auth/heartbeat (worker/src/routes/auth.ts). Máy gọi mỗi 5 phút khi có mạng (NFR-005).
type HeartbeatResp struct {
	Active         bool     `json:"active"`
	LockedAt       int64    `json:"lockedAt"`
	SessionVersion int      `json:"sessionVersion"`
	PermsVersion   int      `json:"permsVersion"`
	AppsVersion    int64    `json:"appsVersion"`
	LicenseState   string   `json:"licenseState"` // none | ok | revoked | suspended | expired | unknown
	LicenseApps    []string `json:"licenseApps"`
	ServerNow      int64    `json:"serverNow"`
	// Token/Exp: Worker gia hạn luôn phiên khi còn dưới nửa đời.
	Token string `json:"token"`
	Exp   int64  `json:"exp"`
}

func (c *Client) Heartbeat(ctx context.Context, deviceID, deviceHash string) (*HeartbeatResp, error) {
	var r HeartbeatResp
	err := c.Do(ctx, "POST", "/v1/auth/heartbeat", map[string]string{"deviceId": deviceID, "deviceHash": deviceHash, "product": c.Product}, &r)
	return &r, err
}

// ChangePassword đổi mật khẩu; thành công thì phiên cũ hết hiệu lực và trả phiên mới.
func (c *Client) ChangePassword(ctx context.Context, current, next, confirm string) (*LoginResp, error) {
	var r LoginResp
	err := c.Do(ctx, "POST", "/v1/auth/change-password", map[string]string{"currentPassword": current, "newPassword": next, "confirmPassword": confirm}, &r)
	return &r, err
}

// SyncOp: một thao tác gửi để Worker kiểm lại quyền tại thời điểm làm (worker/src/lib/authority.ts OpIn).
type SyncOp struct {
	OpID       string `json:"opId"`
	UserID     string `json:"userId"`
	Perm       string `json:"perm"`
	App        string `json:"app,omitempty"`
	DeviceTime int64  `json:"deviceTime"`
	At         int64  `json:"at"`
	Anchor     int64  `json:"anchor"`
}

type SyncResult struct {
	OpID   string `json:"opId"`
	Status string `json:"status"` // accepted | pending | rejected
	Reason string `json:"reason"`
}

type SyncDecision struct {
	OpID   string `json:"opId"`
	Status string `json:"status"` // accepted | dropped
}

type SyncOpsResp struct {
	ServerNow int64          `json:"serverNow"`
	Results   []SyncResult   `json:"results"`
	Decisions []SyncDecision `json:"decisions"`
}

// SyncOps: dùng phiên của chính tác giả thao tác; không có (đã khoá, bị thu hồi, đã đăng xuất, hoặc người khác đang đăng nhập)
// thì ký bằng mã máy + token bản quyền (BR-017). useSession=false bỏ qua phiên hiện tại.
func (c *Client) SyncOps(ctx context.Context, ops []SyncOp, awaiting []string, licenseToken string, useSession bool) (*SyncOpsResp, error) {
	var r SyncOpsResp
	hdr := map[string]string{}
	if !useSession {
		hdr["Authorization"] = "" // ghi đè: không gửi phiên
		hdr["X-License-Token"] = licenseToken
	}
	err := c.DoHeaders(ctx, hdr, "POST", "/v1/sync/ops", map[string]any{"ops": ops, "awaiting": awaiting}, &r)
	return &r, err
}

// ---------- Đồng bộ Drive công ty: tình trạng từng máy, cảnh báo, lịch sử kết nối và sao lưu ----------

// SyncDrop: số mục một loại trên Drive ở lần liệt kê đầy đủ trước và lần này; Worker tự xét có giảm bất thường không (NFR-011).
type SyncDrop struct {
	Kind   string `json:"kind"`
	Before int    `json:"before"`
	After  int    `json:"after"`
}

// SyncStatusReport: máy báo sau mỗi lượt đồng bộ (worker/src/routes/sync-status.ts). Giờ là unix giây, 0 = chưa có.
type SyncStatusReport struct {
	LastSyncAt int64     `json:"lastSyncAt,omitempty"`
	LastPushAt int64     `json:"lastPushAt,omitempty"`
	LastPullAt int64     `json:"lastPullAt,omitempty"`
	Pending    int       `json:"pending"`
	Conflicts  int       `json:"conflicts"`
	LastError  string    `json:"lastError,omitempty"`
	Code       string    `json:"code,omitempty"` // vd drive_full, drive_no_access: Worker tạo cảnh báo cho admin
	Drop       *SyncDrop `json:"drop,omitempty"`
	// UnreachableSince: máy không liên lạc được máy chủ bản quyền từ lúc này (giờ máy chủ, quá licenseUnreachableAlertHours):
	// Worker tạo cảnh báo license_unreachable cho admin (E-021).
	UnreachableSince int64 `json:"unreachableSince,omitempty"`
}

type SyncStatusResp struct {
	OK bool `json:"ok"`
	// Throttled: Worker chỉ ghi một lần mỗi phút mỗi máy; báo dày hơn bị bỏ qua, máy báo lại ở lượt sau.
	Throttled bool  `json:"throttled"`
	ServerNow int64 `json:"serverNow"`
}

// ReportSyncStatus: dùng phiên hiện tại và mã máy (Device). Không có phiên thì truyền licenseToken để ký bằng máy như SyncOps.
func (c *Client) ReportSyncStatus(ctx context.Context, r SyncStatusReport, licenseToken string) (*SyncStatusResp, error) {
	var out SyncStatusResp
	hdr := map[string]string{}
	if licenseToken != "" {
		hdr["Authorization"] = "" // ký bằng máy, không gửi phiên
		hdr["X-License-Token"] = licenseToken
	}
	err := c.DoHeaders(ctx, hdr, "POST", "/v1/sync/status", r, &out)
	return &out, err
}

// DeviceSyncStatus: một dòng trong bảng máy của admin. Giờ con trỏ: nil = máy chưa báo lần nào.
type DeviceSyncStatus struct {
	DeviceID   string  `json:"deviceId"`
	Name       string  `json:"name"`
	Revoked    bool    `json:"revoked"`
	UserID     *string `json:"userId"`
	UserName   *string `json:"userName"`
	LastSyncAt *int64  `json:"lastSyncAt"`
	LastPushAt *int64  `json:"lastPushAt"`
	LastPullAt *int64  `json:"lastPullAt"`
	Pending    int     `json:"pending"`
	Conflicts  int     `json:"conflicts"`
	LastError  *string `json:"lastError"`
	ReportedAt *int64  `json:"reportedAt"`
	// Stale: quá StaleDeviceHours không đồng bộ (Worker đã tạo cảnh báo device_stale).
	Stale bool `json:"stale"`
}

type AdminSyncStatus struct {
	ServerNow        int64              `json:"serverNow"`
	StaleDeviceHours int                `json:"staleDeviceHours"`
	Devices          []DeviceSyncStatus `json:"devices"`
}

// AdminSyncStatus: chỉ admin.drive; thiếu quyền => APIError drive_admin_only.
func (c *Client) AdminSyncStatus(ctx context.Context) (*AdminSyncStatus, error) {
	var out AdminSyncStatus
	err := c.Do(ctx, "GET", "/v1/admin/sync-status", nil, &out)
	return &out, err
}

// DriveAlert: cảnh báo chưa xem (drive_full, drive_no_access, drive_drop, device_stale, license_unreachable).
type DriveAlert struct {
	ID         string          `json:"id"`
	Kind       string          `json:"kind"`
	DeviceID   *string         `json:"deviceId"` // nil = cảnh báo cả công ty
	DeviceName *string         `json:"deviceName"`
	Detail     json.RawMessage `json:"detail"`
	Day        string          `json:"day"` // YYYY-MM-DD giờ VN
	CreatedAt  int64           `json:"createdAt"`
}

func (c *Client) DriveAlerts(ctx context.Context) ([]DriveAlert, error) {
	var out struct {
		Alerts []DriveAlert `json:"alerts"`
	}
	err := c.Do(ctx, "GET", "/v1/admin/drive-alerts", nil, &out)
	return out.Alerts, err
}

// SeeDriveAlerts đánh dấu đã xem; trả số cảnh báo vừa đổi.
func (c *Client) SeeDriveAlerts(ctx context.Context, ids []string) (int, error) {
	var out struct {
		Changed int `json:"changed"`
	}
	err := c.Do(ctx, "POST", "/v1/admin/drive-alerts/seen", map[string]any{"ids": ids}, &out)
	return out.Changed, err
}

// GoogleStatus: kết nối Drive công ty (GET /v1/google/status). Không bao giờ chứa token.
type GoogleStatus struct {
	Connected    bool    `json:"connected"`
	Email        string  `json:"email"`
	RootFolderID *string `json:"root_folder_id"`
	VipoSheetID  *string `json:"vipo_sheet_id"`
	LogSheetID   *string `json:"log_sheet_id"`
	TeachSheetID *string `json:"teach_sheet_id"`
	ConnectedBy  *string `json:"connectedBy"` // tên hiển thị người kết nối
	ConnectedAt  *int64  `json:"connectedAt"`
	LastBackupAt *int64  `json:"lastBackupAt"`
	LastBackupBy *string `json:"lastBackupBy"`
}

func (c *Client) GoogleStatus(ctx context.Context) (*GoogleStatus, error) {
	var out GoogleStatus
	err := c.Do(ctx, "GET", "/v1/google/status", nil, &out)
	return &out, err
}

// SetGoogleResources lưu ID tài nguyên (nil = giữ nguyên). Đổi thư mục gốc => Worker ghi lịch sử init_root. Chỉ admin.drive.
func (c *Client) SetGoogleResources(ctx context.Context, r GoogleResources) error {
	return c.Do(ctx, "PUT", "/v1/google/resources", r, nil)
}

// BackupRecord: kết quả "Sao lưu ngay". OK=false thì Error là mã lỗi ngắn (không chứa token hay dữ liệu).
type BackupRecord struct {
	OK       bool   `json:"ok"`
	FolderID string `json:"folderId,omitempty"`
	Items    int    `json:"items,omitempty"`
	Error    string `json:"error,omitempty"`
}

// RecordBackup trả giờ lần sao lưu thành công gần nhất (0 = chưa có) để máy điền {giờ} trong E-013.
func (c *Client) RecordBackup(ctx context.Context, r BackupRecord) (int64, error) {
	var out struct {
		LastBackupAt *int64 `json:"lastBackupAt"`
	}
	if err := c.Do(ctx, "POST", "/v1/google/backup-record", r, &out); err != nil {
		return 0, err
	}
	if out.LastBackupAt == nil {
		return 0, nil
	}
	return *out.LastBackupAt, nil
}
