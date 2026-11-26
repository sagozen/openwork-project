package agent

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"

	"deskcore/apperr"
)

// Lịch sử chat theo người dùng (<data dir>/chat.db): chỉ thứ người dùng đã thấy (câu hỏi, chữ trả lời, component),
// không có khối thinking, không có giá trị bí mật, không giữ ảnh màn hình.
type History struct{ db *sql.DB }

func OpenHistory(path string) (*History, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	q := url.Values{}
	for _, p := range []string{"busy_timeout(5000)", "journal_mode(WAL)", "synchronous(NORMAL)"} {
		q.Add("_pragma", p)
	}
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(path)+"?"+q.Encode())
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	var v int
	if err := db.QueryRow(`PRAGMA user_version`).Scan(&v); err != nil {
		db.Close()
		return nil, err
	}
	if v < 1 {
		if _, err := db.Exec(`
CREATE TABLE conversations (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL, created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL);
CREATE INDEX conversations_user ON conversations(user_id, updated_at);
CREATE TABLE items (conv_id TEXT NOT NULL REFERENCES conversations(id), at INTEGER NOT NULL, role TEXT NOT NULL,
  text TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL);
CREATE INDEX items_conv ON items(conv_id);
PRAGMA user_version = 1;`); err != nil {
			db.Close()
			return nil, err
		}
	}
	return &History{db: db}, nil
}

func (h *History) Close() error { return h.db.Close() }

// Conversation: một cuộc chat.
type Conversation struct {
	ID        string    `json:"id"`
	Title     string    `json:"title"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// Item: một mục người dùng đã thấy.
type Item struct {
	At   time.Time       `json:"at"`
	Role string          `json:"role"` // user | assistant | component
	Text string          `json:"text,omitempty"`
	Kind string          `json:"kind,omitempty"`
	Data json.RawMessage `json:"data,omitempty"`
}

func (h *History) Create(userID, title string, now time.Time) (Conversation, error) {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	c := Conversation{ID: "c-" + hex.EncodeToString(b), Title: title, CreatedAt: now, UpdatedAt: now}
	_, err := h.db.Exec(`INSERT INTO conversations VALUES (?,?,?,?,?)`, c.ID, userID, c.Title, now.UnixMilli(), now.UnixMilli())
	return c, err
}

// Owned: cuộc chat thuộc người dùng này (không đọc được chat của người khác trên cùng máy).
func (h *History) Owned(userID, convID string) error {
	var owner string
	err := h.db.QueryRow(`SELECT user_id FROM conversations WHERE id = ?`, convID).Scan(&owner)
	if errors.Is(err, sql.ErrNoRows) || owner != userID {
		return apperr.New(apperr.CodeNotFound, "cuộc chat "+convID)
	}
	return err
}

func (h *History) List(userID string, limit int) ([]Conversation, error) {
	rows, err := h.db.Query(`SELECT id, title, created_at, updated_at FROM conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?`,
		userID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Conversation{}
	for rows.Next() {
		var c Conversation
		var cr, up int64
		if err := rows.Scan(&c.ID, &c.Title, &cr, &up); err != nil {
			return nil, err
		}
		c.CreatedAt, c.UpdatedAt = time.UnixMilli(cr), time.UnixMilli(up)
		out = append(out, c)
	}
	return out, rows.Err()
}

func (h *History) Items(convID string) ([]Item, error) {
	rows, err := h.db.Query(`SELECT at, role, text, kind, data FROM items WHERE conv_id = ? ORDER BY rowid`, convID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Item{}
	for rows.Next() {
		var it Item
		var at int64
		var data string
		if err := rows.Scan(&at, &it.Role, &it.Text, &it.Kind, &data); err != nil {
			return nil, err
		}
		it.At = time.UnixMilli(at)
		if data != "" {
			it.Data = json.RawMessage(data)
		}
		out = append(out, it)
	}
	return out, rows.Err()
}

// Add ghi một mục, đã che giá trị bí mật; ảnh màn hình (png) không được lưu.
func (h *History) Add(convID string, it Item, secrets []string) error {
	text := redact(it.Text, secrets)
	data := ""
	if len(it.Data) > 0 {
		var generic any
		if json.Unmarshal(it.Data, &generic) == nil {
			if m, ok := generic.(map[string]any); ok {
				delete(m, "png")
			}
			b, _ := json.Marshal(generic)
			data = redact(string(b), secrets)
		}
	}
	if _, err := h.db.Exec(`INSERT INTO items VALUES (?,?,?,?,?,?)`, convID, it.At.UnixMilli(), it.Role, text, it.Kind, data); err != nil {
		return err
	}
	_, err := h.db.Exec(`UPDATE conversations SET updated_at = ? WHERE id = ?`, it.At.UnixMilli(), convID)
	return err
}

// Hub chuyển sự kiện chat tới giao diện; hàm phát được gắn sau khi cửa sổ mở (Wails OnStartup).
type Hub struct {
	mu sync.Mutex
	fn func(Event)
}

func (h *Hub) Set(fn func(Event)) { h.mu.Lock(); h.fn = fn; h.mu.Unlock() }

func (h *Hub) Emit(e Event) {
	h.mu.Lock()
	fn := h.fn
	h.mu.Unlock()
	if fn != nil {
		fn(e)
	}
}

// Recorder gom sự kiện của một lượt thành các mục lịch sử: chữ liền nhau thành một mục trả lời, mỗi component một mục.
type Recorder struct {
	text  strings.Builder
	items []Item
	now   func() time.Time
}

func NewRecorder(now func() time.Time) *Recorder { return &Recorder{now: now} }

func (r *Recorder) Add(e Event) {
	switch e.Type {
	case "text":
		r.text.WriteString(e.Text)
	case "component":
		r.flush()
		data, _ := json.Marshal(e.Data)
		r.items = append(r.items, Item{At: r.now(), Role: "component", Kind: e.Kind, Data: data})
	case "done":
		r.flush()
	}
}

// Items: các mục đã gom (gọi sau sự kiện done).
func (r *Recorder) Items() []Item {
	r.flush()
	return r.items
}

func (r *Recorder) flush() {
	if t := strings.TrimSpace(r.text.String()); t != "" {
		r.items = append(r.items, Item{At: r.now(), Role: "assistant", Text: t})
	}
	r.text.Reset()
}
