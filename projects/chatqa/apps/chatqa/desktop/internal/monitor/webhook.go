package monitor

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"syscall"
	"time"

	"deskcore/apperr"
)

// Sự kiện webhook gửi đi.
const (
	EventTaskFinished = "task_finished" // task xong, mọi trạng thái
	EventTaskFailed   = "task_failed"   // task có flow lỗi hoặc không chạy được
	EventAlert        = "alert"         // cảnh báo mới (máy mất kết nối, ngân sách thấp, lượt gửi bị bỏ...)
)

// knownEvents: sự kiện tạo webhook được chọn. Webhook cũ đã đăng ký "report" (bản gửi báo cáo lên Drive) vẫn đọc được,
// chỉ không còn nhận sự kiện đó.
var knownEvents = map[string]bool{EventTaskFinished: true, EventTaskFailed: true, EventAlert: true}

// Trạng thái lượt gửi.
const (
	StatusPending = "pending" // chờ gửi hoặc chờ thử lại
	StatusOK      = "ok"
	StatusDead    = "dead" // hết số lần thử, bỏ (dead-letter)
)

// Webhook: nơi nhận sự kiện. Khoá ký nằm trong kho bí mật của hệ điều hành (tên WebhookSecretName(ID)), chỉ hiện một lần lúc tạo.
type Webhook struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	URL       string    `json:"url"`
	Events    []string  `json:"events"`
	Enabled   bool      `json:"enabled"`
	CreatedAt time.Time `json:"createdAt"`
	CreatedBy string    `json:"createdBy"`
}

func (w Webhook) wants(event string) bool {
	for _, e := range w.Events {
		if e == event {
			return true
		}
	}
	return false
}

// WebhookSecretName: tên khoá ký của webhook trong kho bí mật (chữ hoa, theo luật tên biến bí mật của engine).
func WebhookSecretName(id string) string {
	return "WEBHOOK_" + strings.ToUpper(strings.ReplaceAll(id, "-", "_"))
}

// Delivery: một lượt gửi (đọc cho DeliveryLog và tool tower_deliveries).
type Delivery struct {
	ID        string     `json:"id"`
	WebhookID string     `json:"webhookId"`
	Target    string     `json:"target"` // tên webhook · sự kiện
	Event     string     `json:"event"`
	At        time.Time  `json:"at"`
	Status    string     `json:"status"`
	Attempts  int        `json:"attempts"`
	Code      int        `json:"code,omitempty"` // mã HTTP lần gửi cuối
	Error     string     `json:"error,omitempty"`
	LatencyMs int64      `json:"latencyMs"`
	NextAt    *time.Time `json:"nextAt,omitempty"`
	nextAt    time.Time
}

type pendingDelivery struct {
	ID, WebhookID, Target, Event, Payload string
	Attempts                              int
	At                                    time.Time
}

// Thử lại sau các khoảng này; hết danh sách thì bỏ (dead-letter) và báo cảnh báo.
var retryAfter = []time.Duration{30 * time.Second, 2 * time.Minute, 10 * time.Minute, time.Hour}

// MaxAttempts: số lần gửi tối đa của một lượt.
var MaxAttempts = len(retryAfter) + 1

// validateURL: chỉ https (http chỉ cho máy này, để thử), không kèm tên/mật khẩu trong URL.
func validateURL(raw string) error {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Host == "" {
		return apperr.New(apperr.CodeInvalid, "địa chỉ webhook không hợp lệ")
	}
	if u.User != nil {
		return apperr.New(apperr.CodeInvalid, "không đặt tên, mật khẩu trong địa chỉ webhook; dùng khoá ký")
	}
	switch u.Scheme {
	case "https":
		return nil
	case "http":
		if h := u.Hostname(); h == "localhost" || net.ParseIP(h).IsLoopback() {
			return nil
		}
	}
	return apperr.New(apperr.CodeInvalid, "webhook phải dùng https")
}

func validateEvents(events []string) error {
	if len(events) == 0 {
		return apperr.New(apperr.CodeInvalid, "chọn ít nhất một sự kiện")
	}
	for _, e := range events {
		if !knownEvents[e] {
			return apperr.New(apperr.CodeInvalid, "sự kiện lạ: "+e)
		}
	}
	return nil
}

// newSecret: khoá ký ngẫu nhiên 32 byte, dạng hex.
func newSecret() string {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// Sign: chữ ký gửi kèm ở header X-CQS-Signature = "sha256=" + HMAC-SHA256(khoá, X-CQS-Timestamp + "." + thân).
// Bên nhận tính lại để kiểm và từ chối thời điểm quá cũ (chống gửi lại một yêu cầu đã bắt được).
func Sign(secret, timestamp string, body []byte) string {
	m := hmac.New(sha256.New, []byte(secret))
	m.Write([]byte(timestamp + "."))
	m.Write(body)
	return "sha256=" + hex.EncodeToString(m.Sum(nil))
}

// newHookClient: không đi theo chuyển hướng (3xx là gửi lỗi) và không nối tới địa chỉ link-local, multicast, không xác định
// (vd dịch vụ metadata 169.254.169.254). Địa chỉ mạng nội bộ của khách (10.x, 192.168.x) vẫn được: webhook nội bộ là bình thường.
func newHookClient() *http.Client {
	dialer := &net.Dialer{Timeout: 5 * time.Second, Control: func(_, address string, _ syscall.RawConn) error {
		host, _, err := net.SplitHostPort(address)
		if err != nil {
			return err
		}
		if ip := net.ParseIP(host); ip == nil || blockedIP(ip) {
			return fmt.Errorf("địa chỉ %s không được dùng cho webhook", host)
		}
		return nil
	}}
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.DialContext = dialer.DialContext
	tr.Proxy = nil // gửi thẳng, không qua proxy của hệ thống (proxy có thể dẫn tới nơi khác)
	return &http.Client{Timeout: 10 * time.Second, Transport: tr,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

func blockedIP(ip net.IP) bool {
	return ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsInterfaceLocalMulticast() || ip.IsMulticast() || ip.IsUnspecified()
}

// cleanErr bỏ địa chỉ webhook khỏi lỗi trước khi lưu (địa chỉ kiểu Slack là bí mật, nhật ký gửi đi tới Claude qua tool).
func cleanErr(err error) string {
	var ue *url.Error
	if errors.As(err, &ue) {
		err = ue.Err
	}
	return err.Error()
}

// send gửi một lần. ok = mã 2xx.
func send(ctx context.Context, client *http.Client, rawURL, event, deliveryID, secret string, body []byte) (code int, err error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, rawURL, bytes.NewReader(body))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "ChatQASoftware-Webhook/1")
	req.Header.Set("X-CQS-Event", event)
	req.Header.Set("X-CQS-Delivery", deliveryID)
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	req.Header.Set("X-CQS-Timestamp", ts)
	req.Header.Set("X-CQS-Signature", Sign(secret, ts, body))
	res, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	defer res.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 64<<10))
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return res.StatusCode, fmt.Errorf("HTTP %d", res.StatusCode)
	}
	return res.StatusCode, nil
}
