package testengine

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"deskcore/apperr"
)

// Nhật ký cục bộ: lời gọi tool (chat, MCP, UI) và lịch sử sử dụng app, trong cùng testengine.db với số đo lượt chạy.
// Mọi nội dung đã che bí mật và cắt ngắn trước khi ghi; ảnh base64 không bao giờ vào DB. Không gửi đi đâu.

// Trần độ dài nội dung ghi sổ.
const (
	LLMBodyCap   = 256 << 10 // yêu cầu / phản hồi LLM
	ToolBodyCap  = 64 << 10  // tham số / kết quả tool
	UsageMaxSize = 4 << 10   // chi tiết một sự kiện sử dụng (JSON)
)

// Nguồn của một lời gọi tool.
const (
	ToolSourceMCP   = "mcp"
	ToolSourceChat  = "chat"
	ToolSourceAgent = "agent"
	ToolSourceUI    = "ui"
)

// ToolCall: một lần gọi tool.
type ToolCall struct {
	ID         int64     `json:"id"`
	At         time.Time `json:"at"`
	Source     string    `json:"source"` // mcp | chat | ui | agent
	Tool       string    `json:"tool"`
	Args       string    `json:"args"`             // JSON đã che, bỏ ảnh, cắt 64 KB
	Result     string    `json:"result,omitempty"` // như Args
	ErrorCode  string    `json:"errorCode,omitempty"`
	Error      string    `json:"error,omitempty"`
	DurationMs int64     `json:"durationMs"`
}

// UsageEvent: một sự kiện sử dụng app (mở/đóng app, mở trang, hành động trên UI).
type UsageEvent struct {
	ID     int64           `json:"id"`
	At     time.Time       `json:"at"`
	Kind   string          `json:"kind"`
	Detail json.RawMessage `json:"detail,omitempty"`
}

// capText cắt s còn tối đa n byte (không cắt giữa ký tự UTF-8), đánh dấu phần bị cắt.
func capText(s string, n int) string {
	if len(s) <= n {
		return s
	}
	cut := n
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut] + fmt.Sprintf("…[đã cắt %d byte]", len(s)-cut)
}

// JournalText: chữ để ghi sổ: che bí mật rồi cắt còn max byte.
func JournalText(s string, secrets []string, max int) string {
	return capText(redact(s, secrets), max)
}

// JournalJSON: v thành JSON để ghi sổ: bỏ ảnh base64 (trường png, khối ảnh source.data), che bí mật, cắt còn max byte.
// v là json.RawMessage hoặc []byte thì dùng nguyên văn.
func JournalJSON(v any, secrets []string, max int) string {
	var raw []byte
	switch x := v.(type) {
	case nil:
		return ""
	case json.RawMessage:
		raw = x
	case []byte:
		raw = x
	default:
		b, err := json.Marshal(v)
		if err != nil {
			return JournalText(fmt.Sprintf("%v", v), secrets, max)
		}
		raw = b
	}
	var generic any
	if err := json.Unmarshal(raw, &generic); err != nil {
		return JournalText(string(raw), secrets, max)
	}
	if b, err := json.Marshal(dropImages(generic)); err == nil {
		raw = b
	}
	return JournalText(string(raw), secrets, max)
}

// dropImages thay dữ liệu ảnh base64 bằng ghi chú độ dài.
func dropImages(v any) any {
	switch x := v.(type) {
	case map[string]any:
		for k, val := range x {
			if s, ok := val.(string); ok && s != "" && (k == "png" || (k == "data" && x["type"] == "base64")) {
				x[k] = fmt.Sprintf("[ảnh %d byte, không lưu]", len(s))
				continue
			}
			x[k] = dropImages(val)
		}
	case []any:
		for i := range x {
			x[i] = dropImages(x[i])
		}
	}
	return v
}

// RecordToolCall ghi một lần gọi tool (đã che và cắt ở phía gọi, xem tools.Registry).
func (m *Metrics) RecordToolCall(c ToolCall) error {
	_, err := m.db.Exec(`INSERT INTO tool_calls (at, source, tool, args, result, error_code, error, duration_ms)
  VALUES (?,?,?,?,?,?,?,?)`, c.At.UnixMilli(), c.Source, c.Tool, c.Args, c.Result, c.ErrorCode, c.Error, c.DurationMs)
	return err
}

// ToolCalls: các lần gọi tool từ since (mới trước), tối đa limit.
func (m *Metrics) ToolCalls(since time.Time, limit int) ([]ToolCall, error) {
	return m.queryToolCalls(`WHERE at >= ? ORDER BY at DESC, id DESC LIMIT ?`, since.UnixMilli(), limit)
}

func (m *Metrics) toolCallsBetween(from, to time.Time) ([]ToolCall, error) {
	return m.queryToolCalls(`WHERE at >= ? AND at <= ? ORDER BY at, id`, from.UnixMilli(), to.UnixMilli())
}

func (m *Metrics) queryToolCalls(tail string, args ...any) ([]ToolCall, error) {
	rows, err := m.db.Query(`SELECT id, at, source, tool, args, result, error_code, error, duration_ms FROM tool_calls `+tail, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ToolCall{}
	for rows.Next() {
		var c ToolCall
		var at int64
		if err := rows.Scan(&c.ID, &at, &c.Source, &c.Tool, &c.Args, &c.Result, &c.ErrorCode, &c.Error, &c.DurationMs); err != nil {
			return nil, err
		}
		c.At = time.UnixMilli(at)
		out = append(out, c)
	}
	return out, rows.Err()
}

var usageKindRe = regexp.MustCompile(`^[a-z][a-z0-9_.:-]{0,63}$`)

// RecordUsage ghi một sự kiện sử dụng. kind: chữ thường, số, _ . : - (tối đa 64); detail tối đa 4 KB JSON, đã che bí mật.
func (m *Metrics) RecordUsage(at time.Time, kind string, detail map[string]any, secrets []string) error {
	if !usageKindRe.MatchString(kind) {
		return apperr.New(apperr.CodeInvalid, "loại sự kiện chỉ gồm chữ thường, số, _ . : - (tối đa 64 ký tự)")
	}
	body := ""
	if len(detail) > 0 {
		raw, err := json.Marshal(detail)
		if err != nil {
			return apperr.Wrap(apperr.CodeInvalid, err)
		}
		if len(raw) > UsageMaxSize {
			return apperr.New(apperr.CodeInvalid, fmt.Sprintf("chi tiết sự kiện quá %d byte", UsageMaxSize))
		}
		body = redact(string(raw), secrets)
	}
	_, err := m.db.Exec(`INSERT INTO usage_events (at, kind, detail) VALUES (?,?,?)`, at.UnixMilli(), kind, body)
	return err
}

// UsageEvents: các sự kiện sử dụng từ since (mới trước), tối đa limit.
func (m *Metrics) UsageEvents(since time.Time, limit int) ([]UsageEvent, error) {
	rows, err := m.db.Query(`SELECT id, at, kind, detail FROM usage_events WHERE at >= ? ORDER BY at DESC, id DESC LIMIT ?`,
		since.UnixMilli(), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []UsageEvent{}
	for rows.Next() {
		var e UsageEvent
		var at int64
		var detail string
		if err := rows.Scan(&e.ID, &at, &e.Kind, &detail); err != nil {
			return nil, err
		}
		e.At = time.UnixMilli(at)
		if strings.TrimSpace(detail) != "" {
			e.Detail = json.RawMessage(detail)
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// Setting / SetSetting: cài đặt cục bộ của engine (vd retention_days); "" nếu chưa đặt.
func (m *Metrics) Setting(key string) (string, error) {
	var v string
	err := m.db.QueryRow(`SELECT value FROM settings WHERE key = ?`, key).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return v, err
}

func (m *Metrics) SetSetting(key, value string) error {
	_, err := m.db.Exec(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, value)
	return err
}
