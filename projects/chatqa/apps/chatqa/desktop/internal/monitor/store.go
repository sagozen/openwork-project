// Package monitor: App 3 - Giám sát. Lịch chạy cục bộ, cảnh báo và webhook gửi đi (thử lại, bỏ sau số lần tối đa).
// Mọi việc chạy nền, không chặn lượt chạy. Báo cáo lượt chạy chỉ nằm trên máy; không tải lên đâu cả.
package monitor

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"

	"deskcore/apperr"
)

// Store: kho cục bộ của Giám sát (<data dir>/monitor.db).
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

func (s *Store) migrate() error {
	var v int
	if err := s.db.QueryRow(`PRAGMA user_version`).Scan(&v); err != nil {
		return err
	}
	if v >= 1 {
		return nil
	}
	_, err := s.db.Exec(`
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE schedules (id TEXT PRIMARY KEY, data TEXT NOT NULL, next_run INTEGER NOT NULL);
CREATE TABLE webhooks (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE deliveries (
  id TEXT PRIMARY KEY, webhook_id TEXT NOT NULL, target TEXT NOT NULL, event TEXT NOT NULL, payload TEXT NOT NULL,
  status TEXT NOT NULL, attempts INTEGER NOT NULL, code INTEGER NOT NULL, error TEXT NOT NULL, latency_ms INTEGER NOT NULL,
  next_at INTEGER NOT NULL, created_at INTEGER NOT NULL, done_at INTEGER NOT NULL);
CREATE INDEX deliveries_due ON deliveries(status, next_at);
CREATE INDEX deliveries_created ON deliveries(created_at);
-- uploads: của bản cũ gửi báo cáo lên Drive; giữ nguyên bảng (không xoá dữ liệu cũ), không còn dùng.
CREATE TABLE uploads (task_id TEXT PRIMARY KEY, status TEXT NOT NULL, attempts INTEGER NOT NULL, next_at INTEGER NOT NULL,
  error TEXT NOT NULL, links TEXT NOT NULL, created_at INTEGER NOT NULL, done_at INTEGER NOT NULL);
CREATE TABLE alerts_seen (key TEXT PRIMARY KEY, at INTEGER NOT NULL);
PRAGMA user_version = 1;`)
	return err
}

// --- lịch chạy ---

func (s *Store) saveSchedule(sc Schedule) error {
	b, _ := json.Marshal(sc)
	_, err := s.db.Exec(`INSERT INTO schedules VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, next_run = excluded.next_run`,
		sc.ID, string(b), sc.NextRun.UnixMilli())
	return err
}

func (s *Store) schedules() ([]Schedule, error) {
	rows, err := s.db.Query(`SELECT data FROM schedules ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Schedule{}
	for rows.Next() {
		var raw string
		if err := rows.Scan(&raw); err != nil {
			return nil, err
		}
		var sc Schedule
		if err := json.Unmarshal([]byte(raw), &sc); err == nil {
			out = append(out, sc)
		}
	}
	return out, rows.Err()
}

func (s *Store) schedule(id string) (Schedule, error) {
	var raw string
	if err := s.db.QueryRow(`SELECT data FROM schedules WHERE id = ?`, id).Scan(&raw); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Schedule{}, apperr.New(apperr.CodeNotFound, "lịch "+id)
		}
		return Schedule{}, err
	}
	var sc Schedule
	return sc, json.Unmarshal([]byte(raw), &sc)
}

func (s *Store) deleteSchedule(id string) error {
	_, err := s.db.Exec(`DELETE FROM schedules WHERE id = ?`, id)
	return err
}

// --- webhook ---

func (s *Store) saveWebhook(w Webhook) error {
	b, _ := json.Marshal(w)
	_, err := s.db.Exec(`INSERT INTO webhooks VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`, w.ID, string(b))
	return err
}

func (s *Store) webhooks() ([]Webhook, error) {
	rows, err := s.db.Query(`SELECT data FROM webhooks ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Webhook{}
	for rows.Next() {
		var raw string
		if err := rows.Scan(&raw); err != nil {
			return nil, err
		}
		var w Webhook
		if err := json.Unmarshal([]byte(raw), &w); err == nil {
			out = append(out, w)
		}
	}
	return out, rows.Err()
}

func (s *Store) deleteWebhook(id string) error {
	_, err := s.db.Exec(`DELETE FROM webhooks WHERE id = ?`, id)
	return err
}

// --- lượt gửi ---

func (s *Store) insertDelivery(d Delivery, payload []byte) error {
	_, err := s.db.Exec(`INSERT INTO deliveries VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, d.ID, d.WebhookID, d.Target, d.Event, string(payload),
		d.Status, d.Attempts, d.Code, d.Error, d.LatencyMs, d.nextAt.UnixMilli(), d.At.UnixMilli(), 0)
	return err
}

func (s *Store) dueDeliveries(now time.Time, limit int) ([]pendingDelivery, error) {
	rows, err := s.db.Query(`SELECT id, webhook_id, target, event, payload, attempts, created_at FROM deliveries
		WHERE status = ? AND next_at <= ? ORDER BY next_at LIMIT ?`, StatusPending, now.UnixMilli(), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []pendingDelivery
	for rows.Next() {
		var p pendingDelivery
		var created int64
		if err := rows.Scan(&p.ID, &p.WebhookID, &p.Target, &p.Event, &p.Payload, &p.Attempts, &created); err != nil {
			return nil, err
		}
		p.At = time.UnixMilli(created)
		out = append(out, p)
	}
	return out, rows.Err()
}

func (s *Store) finishAttempt(id, status string, attempts, code int, errMsg string, latency int64, next, done time.Time) error {
	var doneMs int64
	if !done.IsZero() {
		doneMs = done.UnixMilli()
	}
	_, err := s.db.Exec(`UPDATE deliveries SET status = ?, attempts = ?, code = ?, error = ?, latency_ms = ?, next_at = ?, done_at = ? WHERE id = ?`,
		status, attempts, code, errMsg, latency, next.UnixMilli(), doneMs, id)
	return err
}

// Deliveries: lượt gửi gần nhất, mới trước.
func (s *Store) Deliveries(limit int) ([]Delivery, error) {
	rows, err := s.db.Query(`SELECT id, webhook_id, target, event, status, attempts, code, error, latency_ms, next_at, created_at
		FROM deliveries ORDER BY created_at DESC, id DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Delivery{}
	for rows.Next() {
		var d Delivery
		var next, created int64
		if err := rows.Scan(&d.ID, &d.WebhookID, &d.Target, &d.Event, &d.Status, &d.Attempts, &d.Code, &d.Error, &d.LatencyMs, &next, &created); err != nil {
			return nil, err
		}
		d.At = time.UnixMilli(created)
		if d.Status == StatusPending {
			t := time.UnixMilli(next)
			d.NextAt = &t
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

func (s *Store) deadSince(since time.Time) (int, error) {
	var n int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM deliveries WHERE status = ? AND done_at >= ?`, StatusDead, since.UnixMilli()).Scan(&n)
	return n, err
}

// --- cảnh báo đã báo qua webhook (không báo lặp) ---

func (s *Store) markAlert(key string, now time.Time) (fresh bool, err error) {
	res, err := s.db.Exec(`INSERT INTO alerts_seen VALUES (?,?) ON CONFLICT(key) DO NOTHING`, key, now.UnixMilli())
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n == 1, nil
}

// forgetAlerts: cảnh báo đã hết thì quên, lần sau xuất hiện lại sẽ báo lại.
func (s *Store) forgetAlerts(keep map[string]bool) error {
	rows, err := s.db.Query(`SELECT key FROM alerts_seen`)
	if err != nil {
		return err
	}
	var gone []string
	for rows.Next() {
		var k string
		if rows.Scan(&k) == nil && !keep[k] {
			gone = append(gone, k)
		}
	}
	rows.Close()
	for _, k := range gone {
		if _, err := s.db.Exec(`DELETE FROM alerts_seen WHERE key = ?`, k); err != nil {
			return err
		}
	}
	return nil
}
