// Package tower: tháp điều phối. Gộp thiết bị, task, sức khoẻ và ngân sách thành vài phép đọc tổng hợp, và là nơi
// áp luật ngân sách và an toàn; chat trong app và client MCP bên ngoài đều đi qua đây.
package tower

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"

	"chatqa/internal/pw"
	"chatqa/internal/tower/pool"
	"deskcore/apperr"
	"deskcore/offline"
)

// Kho cục bộ của tower (<data dir>/tower.db): cài đặt, bộ nhớ đệm thiết bị, task, sự kiện, nhật ký thao tác.
// Sổ chi phí LLM nằm ở kho số đo của engine (llm_calls); Worker giữ ngân sách tháng.
type Store struct{ db *sql.DB }

func OpenStore(path string) (*Store, error) {
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
	s := &Store{db: db}
	if err := s.migrate(); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) Close() error { return s.db.Close() }

// migrations: bước i đưa kho từ phiên bản i lên i+1. Chỉ thêm bước mới ở cuối, không sửa bước đã phát hành.
var migrations = []string{
	`
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE device_settings (id TEXT PRIMARY KEY, driver TEXT NOT NULL);
CREATE TABLE devices (id TEXT PRIMARY KEY, data TEXT NOT NULL, last_seen INTEGER NOT NULL);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, request TEXT NOT NULL, run_id TEXT NOT NULL,
  actor TEXT NOT NULL, device_id TEXT NOT NULL, created_at INTEGER NOT NULL, finished_at INTEGER NOT NULL,
  passed INTEGER NOT NULL, failed INTEGER NOT NULL, error TEXT NOT NULL, parent TEXT NOT NULL);
CREATE INDEX tasks_created ON tasks(created_at);
CREATE TABLE events (task_id TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL, device_id TEXT NOT NULL,
  flow TEXT NOT NULL, detail TEXT NOT NULL);
CREATE INDEX events_at ON events(at);
CREATE TABLE calls (at INTEGER NOT NULL, actor TEXT NOT NULL, actor_device TEXT NOT NULL, device_id TEXT NOT NULL, tool TEXT NOT NULL,
  args TEXT NOT NULL, result TEXT NOT NULL, cost_vnd REAL NOT NULL);
CREATE INDEX calls_at ON calls(at);`,
	// v2: hồ sơ trình duyệt (thiết bị web); data là JSON của pw.Profile.
	`CREATE TABLE browser_profiles (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL);`,
}

// migrate nâng kho từng bước, mỗi bước một transaction cùng user_version: lỗi giữa chừng để kho ở phiên bản cũ.
func (s *Store) migrate() error {
	var v int
	if err := s.db.QueryRow(`PRAGMA user_version`).Scan(&v); err != nil {
		return err
	}
	for ; v < len(migrations); v++ {
		if err := s.migrateStep(v); err != nil {
			return fmt.Errorf("nâng kho điều phối lên v%d: %w", v+1, err)
		}
	}
	return nil
}

func (s *Store) migrateStep(v int) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(migrations[v]); err != nil {
		return err
	}
	if _, err := tx.Exec(fmt.Sprintf(`PRAGMA user_version = %d`, v+1)); err != nil {
		return err
	}
	return tx.Commit()
}

// --- cài đặt ---

func (s *Store) Setting(key string) string {
	var v string
	_ = s.db.QueryRow(`SELECT value FROM settings WHERE key = ?`, key).Scan(&v)
	return v
}

func (s *Store) SetSetting(key, value string) error {
	_, err := s.db.Exec(`INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, value)
	return err
}

func (s *Store) DeviceDriver(id string) string {
	var v string
	_ = s.db.QueryRow(`SELECT driver FROM device_settings WHERE id = ?`, id).Scan(&v)
	return v
}

func (s *Store) SetDeviceDriver(id, driver string) error {
	_, err := s.db.Exec(`INSERT INTO device_settings VALUES (?,?) ON CONFLICT(id) DO UPDATE SET driver = excluded.driver`, id, driver)
	return err
}

const (
	settingTeamID = "ios.team_id"
	settingAppID  = "app.id" // app đang thử, để đọc phiên bản đã cài trên máy
)

func (s *Store) TeamID() string { return s.Setting(settingTeamID) }
func (s *Store) AppID() string  { return s.Setting(settingAppID) }

// --- bộ nhớ đệm thiết bị ---

// SaveDevices ghi danh sách thiết bị hiện tại (để lần mở sau vẫn thấy máy đã biết là "disconnected").
func (s *Store) SaveDevices(devs []pool.Device) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, d := range devs {
		b, _ := json.Marshal(d)
		if _, err := tx.Exec(`INSERT INTO devices VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data = excluded.data,
  last_seen = excluded.last_seen`, d.ID, string(b), d.LastSeen.UnixMilli()); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *Store) CachedDevices() ([]pool.Device, error) {
	rows, err := s.db.Query(`SELECT data FROM devices ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []pool.Device
	for rows.Next() {
		var raw string
		if err := rows.Scan(&raw); err != nil {
			return nil, err
		}
		var d pool.Device
		if json.Unmarshal([]byte(raw), &d) == nil {
			out = append(out, d)
		}
	}
	return out, rows.Err()
}

// --- hồ sơ trình duyệt ---

// BrowserProfiles: mọi hồ sơ trình duyệt, theo mã. Dòng hỏng (JSON lạ) bị bỏ qua.
func (s *Store) BrowserProfiles() ([]pw.Profile, error) {
	rows, err := s.db.Query(`SELECT data FROM browser_profiles ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []pw.Profile{}
	for rows.Next() {
		var raw string
		if err := rows.Scan(&raw); err != nil {
			return nil, err
		}
		var p pw.Profile
		if json.Unmarshal([]byte(raw), &p) == nil {
			out = append(out, p)
		}
	}
	return out, rows.Err()
}

// BrowserProfile: một hồ sơ theo mã; not_found nếu không có.
func (s *Store) BrowserProfile(id string) (pw.Profile, error) {
	var raw string
	err := s.db.QueryRow(`SELECT data FROM browser_profiles WHERE id = ?`, id).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return pw.Profile{}, apperr.New(apperr.CodeNotFound, "hồ sơ trình duyệt "+id)
	}
	if err != nil {
		return pw.Profile{}, err
	}
	var p pw.Profile
	if err := json.Unmarshal([]byte(raw), &p); err != nil {
		return pw.Profile{}, fmt.Errorf("hồ sơ trình duyệt %s hỏng: %w", id, err)
	}
	return p, nil
}

// SaveBrowserProfile kiểm tra, chuẩn hoá rồi ghi (thêm hoặc sửa) hồ sơ; trả hồ sơ đã chuẩn hoá.
func (s *Store) SaveBrowserProfile(p pw.Profile, at time.Time) (pw.Profile, error) {
	if err := p.Validate(); err != nil {
		return pw.Profile{}, err
	}
	b, err := json.Marshal(p)
	if err != nil {
		return pw.Profile{}, err
	}
	_, err = s.db.Exec(`INSERT INTO browser_profiles VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data = excluded.data,
  updated_at = excluded.updated_at`, p.ID, string(b), at.UnixMilli())
	return p, err
}

// DeleteBrowserProfile xoá hồ sơ; not_found nếu không có.
func (s *Store) DeleteBrowserProfile(id string) error {
	res, err := s.db.Exec(`DELETE FROM browser_profiles WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return apperr.New(apperr.CodeNotFound, "hồ sơ trình duyệt "+id)
	}
	return nil
}

// --- task ---

// Trạng thái task.
const (
	TaskRunning  = "running"
	TaskPassed   = "passed"
	TaskFailed   = "failed"
	TaskCanceled = "canceled"
	TaskError    = "error" // không chạy được (flow sai, thiếu bí mật, không có máy)
)

// UserStopMessage: lý do ghi trên task bị người dùng dừng bằng Esc (Dừng tất cả). Nói rõ đây là ý người dùng, không phải
// lỗi máy hay app, để agent (Claude qua MCP) không coi là lỗi chạm đúng một lần rồi chạy lại.
const UserStopMessage = "Người dùng đã nhấn Esc (Dừng tất cả) để dừng lượt chạy này; đây là yêu cầu của người dùng, không phải lỗi máy hay app."

// UserStopInstruction: lệnh gửi kèm cho agent khi task bị người dùng dừng.
const UserStopInstruction = "DỪNG NGAY theo yêu cầu của người dùng: không chạy lại, không gọi tower_dispatch, test_run hay tower_replay_failed, " +
	"không thử lại trên máy khác, không coi đây là lỗi cần sửa. Báo người dùng là lượt đã dừng và chờ họ yêu cầu tiếp."

// UserStopped: task đã bị người dùng dừng (Esc), khác với huỷ do tắt app hay test_stop.
func (t Task) UserStopped() bool { return t.Status == TaskCanceled && t.Error == UserStopMessage }

// Task: một lần điều phối (chạy flow trên một nhóm thiết bị), theo dõi đến khi xong.
type Task struct {
	ID         string          `json:"id"`
	Kind       string          `json:"kind"` // dispatch | replay
	Status     string          `json:"status"`
	Request    json.RawMessage `json:"request"` // DispatchRequest đã chọn máy; chỉ tên biến bí mật
	RunID      string          `json:"runId,omitempty"`
	Actor      string          `json:"actor"`
	DeviceID   string          `json:"deviceId"` // máy tính của người ra lệnh
	CreatedAt  time.Time       `json:"createdAt"`
	FinishedAt time.Time       `json:"finishedAt,omitzero"`
	Passed     int             `json:"passed"`
	Failed     int             `json:"failed"`
	Error      string          `json:"error,omitempty"`
	Parent     string          `json:"parent,omitempty"` // task gốc khi chạy lại lượt lỗi
}

func (s *Store) InsertTask(t Task) error {
	_, err := s.db.Exec(`INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, t.ID, t.Kind, t.Status, string(t.Request), t.RunID,
		t.Actor, t.DeviceID, t.CreatedAt.UnixMilli(), 0, 0, 0, t.Error, t.Parent)
	return err
}

func (s *Store) FinishTask(id, status, runID string, passed, failed int, errMsg string, at time.Time) error {
	_, err := s.db.Exec(`UPDATE tasks SET status = ?, run_id = ?, passed = ?, failed = ?, error = ?, finished_at = ? WHERE id = ?`,
		status, runID, passed, failed, errMsg, at.UnixMilli(), id)
	return err
}

// TaskFilter: lọc task; trống = tất cả.
type TaskFilter struct {
	Status string    `json:"status"`
	Since  time.Time `json:"since"`
	Limit  int       `json:"limit"`
}

func (s *Store) Tasks(f TaskFilter) ([]Task, error) {
	q, args := `SELECT id, kind, status, request, run_id, actor, device_id, created_at, finished_at, passed, failed, error, parent
  FROM tasks WHERE 1=1`, []any{}
	if f.Status != "" {
		q, args = q+` AND status = ?`, append(args, f.Status)
	}
	if !f.Since.IsZero() {
		q, args = q+` AND created_at >= ?`, append(args, f.Since.UnixMilli())
	}
	if f.Limit <= 0 || f.Limit > 500 {
		f.Limit = 50
	}
	q, args = q+` ORDER BY created_at DESC LIMIT ?`, append(args, f.Limit)
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Task{}
	for rows.Next() {
		var t Task
		var req string
		var c, fin int64
		if err := rows.Scan(&t.ID, &t.Kind, &t.Status, &req, &t.RunID, &t.Actor, &t.DeviceID, &c, &fin, &t.Passed, &t.Failed,
			&t.Error, &t.Parent); err != nil {
			return nil, err
		}
		t.Request, t.CreatedAt = json.RawMessage(req), time.UnixMilli(c)
		if fin > 0 {
			t.FinishedAt = time.UnixMilli(fin)
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func (s *Store) Task(id string) (Task, error) {
	var t Task
	var req string
	var c, fin int64
	err := s.db.QueryRow(`SELECT id, kind, status, request, run_id, actor, device_id, created_at, finished_at, passed, failed, error,
  parent FROM tasks WHERE id = ?`, id).Scan(&t.ID, &t.Kind, &t.Status, &req, &t.RunID, &t.Actor, &t.DeviceID, &c, &fin, &t.Passed,
		&t.Failed, &t.Error, &t.Parent)
	if errors.Is(err, sql.ErrNoRows) {
		return t, apperr.New(apperr.CodeNotFound, "task "+id)
	}
	t.Request, t.CreatedAt = json.RawMessage(req), time.UnixMilli(c)
	if fin > 0 {
		t.FinishedAt = time.UnixMilli(fin)
	}
	return t, err
}

// MarkRunningCanceled: task còn "running" (vd app tắt giữa chừng) chuyển thành canceled.
func (s *Store) MarkRunningCanceled(at time.Time) error {
	_, err := s.db.Exec(`UPDATE tasks SET status = ?, finished_at = ? WHERE status = ?`, TaskCanceled, at.UnixMilli(), TaskRunning)
	return err
}

// --- sự kiện và nhật ký thao tác ---

// Event: một mốc trong vòng đời task hoặc thiết bị (dùng cho Health 7 ngày và cảnh báo).
type Event struct {
	TaskID   string    `json:"taskId"`
	At       time.Time `json:"at"`
	Kind     string    `json:"kind"` // device_error | device_disconnected | flow_failed | task_done ...
	DeviceID string    `json:"deviceId"`
	Flow     string    `json:"flow"`
	Detail   string    `json:"detail"`
}

func (s *Store) AddEvent(e Event) error {
	_, err := s.db.Exec(`INSERT INTO events VALUES (?,?,?,?,?,?)`, e.TaskID, e.At.UnixMilli(), e.Kind, e.DeviceID, e.Flow, e.Detail)
	return err
}

func (s *Store) Events(since time.Time, limit int) ([]Event, error) {
	rows, err := s.db.Query(`SELECT task_id, at, kind, device_id, flow, detail FROM events WHERE at >= ? ORDER BY at DESC LIMIT ?`,
		since.UnixMilli(), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Event{}
	for rows.Next() {
		var e Event
		var at int64
		if err := rows.Scan(&e.TaskID, &at, &e.Kind, &e.DeviceID, &e.Flow, &e.Detail); err != nil {
			return nil, err
		}
		e.At = time.UnixMilli(at)
		out = append(out, e)
	}
	return out, rows.Err()
}

// Call: một lệnh gọi công cụ của tower (từ UI, chat hay MCP), kèm người làm, máy, giờ tin cậy và chi phí.
type Call struct {
	At          time.Time `json:"at"`
	Actor       string    `json:"actor"`
	ActorDevice string    `json:"actorDevice"` // máy tính của người ra lệnh
	DeviceID    string    `json:"deviceId"`    // thiết bị đích; trống nếu lệnh không nhắm một máy
	Tool        string    `json:"tool"`
	Args        string    `json:"args"` // JSON, đã che giá trị bí mật
	Result      string    `json:"result"`
	CostVnd     float64   `json:"costVnd"`
}

// LogCall ghi một lệnh gọi; args được che mọi giá trị trong secrets trước khi ghi.
func (s *Store) LogCall(actor offline.Actor, tool, device string, args any, result string, cost float64, secrets []string) error {
	b, _ := json.Marshal(args)
	text := string(b)
	for _, v := range secrets {
		if v != "" {
			text = strings.ReplaceAll(text, v, "***")
		}
	}
	at := time.Unix(actor.At, 0) // giờ tin cậy, giây
	if actor.At == 0 {
		at = time.Now()
	}
	_, err := s.db.Exec(`INSERT INTO calls VALUES (?,?,?,?,?,?,?,?)`, at.UnixMilli(), actor.UserID, actor.DeviceID, device, tool, text, result, cost)
	return err
}

func (s *Store) Calls(since time.Time, limit int) ([]Call, error) {
	rows, err := s.db.Query(`SELECT at, actor, actor_device, device_id, tool, args, result, cost_vnd FROM calls WHERE at >= ? ORDER BY at DESC LIMIT ?`,
		since.UnixMilli(), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Call{}
	for rows.Next() {
		var c Call
		var at int64
		if err := rows.Scan(&at, &c.Actor, &c.ActorDevice, &c.DeviceID, &c.Tool, &c.Args, &c.Result, &c.CostVnd); err != nil {
			return nil, err
		}
		c.At = time.UnixMilli(at)
		out = append(out, c)
	}
	return out, rows.Err()
}
