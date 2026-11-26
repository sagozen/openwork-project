package testengine

import (
	"database/sql"
	"errors"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	_ "modernc.org/sqlite"

	"deskcore/apperr"
)

// Số đo các lượt chạy, trong SQLite cục bộ (<data dir>/testengine.db). Pane 4 và test_metrics chỉ đọc.

// Phân loại lỗi trong báo cáo.
const (
	FailProduct     = "product"     // app sai: assert/điều kiện không đạt
	FailAutomation  = "automation"  // flow sai: không thấy phần tử, selector hỏng
	FailEnvironment = "environment" // preflight, driver, thiết bị (luôn là môi trường)
)

// FlowRun: một lần chạy một flow trên một thiết bị.
type FlowRun struct {
	RunID           string `json:"runId"`
	DeviceID        string `json:"deviceId"`
	Platform        string `json:"platform"`
	Driver          string `json:"driver"`
	Flow            string `json:"flow"`
	Iteration       int    `json:"iteration"`
	DeviceCount     int    `json:"deviceCount"` // số thiết bị chạy song song trong lượt
	Passed          bool   `json:"passed"`
	DurationMs      int64  `json:"durationMs"`
	Cold            bool   `json:"cold"` // flow đầu tiên trên driver vừa tạo
	DriverStartMs   int64  `json:"driverStartMs,omitempty"`
	TypingFrequency int    `json:"typingFrequency,omitempty"` // phím/giây đã áp cho flow; 0 = mặc định của runner
	FailureClass    string `json:"failureClass,omitempty"`
	Error           string `json:"error,omitempty"`
	Video           string `json:"video,omitempty"`
	VideoTruncated  bool   `json:"videoTruncated,omitempty"`
	// Trace: trace.zip của flow web lỗi (đường dẫn tuyệt đối). Không lưu vào DB: Run và Report (AttachTraces) tính từ thư
	// mục lượt; file quyền 0600, bị xoá theo hạn giữ lượt và không bao giờ được xuất.
	Trace string    `json:"trace,omitempty"`
	Steps []StepRun `json:"steps,omitempty"`
}

// StepRun: một bước trong flow (bước cấp đầu; bước lồng có Depth > 0).
type StepRun struct {
	Index      int    `json:"index"`
	Depth      int    `json:"depth"`
	Command    string `json:"command"` // tapOn, inputText, assertVisible...
	Desc       string `json:"desc"`    // đã che giá trị bí mật
	Passed     bool   `json:"passed"`
	DurationMs int64  `json:"durationMs"`
	Error      string `json:"error,omitempty"`
	// Evidence lấy từ flows/<id>.json của runner sau mỗi flow (xem evidence.go); trống nếu runner không ghi.
	Label      string    `json:"label,omitempty"`      // label: trong YAML
	Yaml       string    `json:"yaml,omitempty"`       // lệnh YAML đã thay biến (đã che bí mật)
	Selector   string    `json:"selector,omitempty"`   // "kiểu=giá trị", vd text=Đăng nhập
	Element    string    `json:"element,omitempty"`    // phần tử tìm thấy: chữ/id rút gọn và khung
	ErrorType  string    `json:"errorType,omitempty"`  // assertion | timeout | element_not_found | ...
	Suggestion string    `json:"suggestion,omitempty"` // gợi ý sửa của runner
	ShotBefore string    `json:"shotBefore,omitempty"` // ảnh trước bước, đường dẫn tương đối với OutDir của lượt (dấu /)
	ShotAfter  string    `json:"shotAfter,omitempty"`  // ảnh sau bước
	Hierarchy  string    `json:"hierarchy,omitempty"`  // cây UI lúc bước lỗi
	StartedAt  time.Time `json:"startedAt,omitzero"`
}

// RunRecord: một lượt chạy (nhiều flow × thiết bị × lặp).
type RunRecord struct {
	ID         string    `json:"id"`
	App        string    `json:"app"`
	StartedAt  time.Time `json:"startedAt"`
	FinishedAt time.Time `json:"finishedAt"`
	Devices    int       `json:"devices"`
	Repeat     int       `json:"repeat"`
	Passed     int       `json:"passed"`
	Failed     int       `json:"failed"`
	Canceled   bool      `json:"canceled"`
	OutDir     string    `json:"outDir"`
	MaxRSSMB   float64   `json:"maxRssMB"`
	CPUMs      int64     `json:"cpuMs"`
	Label      string    `json:"label,omitempty"`     // bản app (so sánh), trống nếu không ghi
	Artifacts  string    `json:"artifacts,omitempty"` // mức ảnh theo bước: always | on-failure | never (trống: lượt cũ)
}

type Metrics struct{ db *sql.DB }

func OpenMetrics(path string) (*Metrics, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	q := url.Values{}
	for _, p := range []string{"busy_timeout(5000)", "journal_mode(WAL)", "synchronous(NORMAL)", "foreign_keys(1)"} {
		q.Add("_pragma", p)
	}
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(path)+"?"+q.Encode())
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	m := &Metrics{db: db}
	if err := m.migrate(); err != nil {
		db.Close()
		return nil, err
	}
	return m, nil
}

func (m *Metrics) Close() error { return m.db.Close() }

func (m *Metrics) migrate() error {
	var v int
	if err := m.db.QueryRow(`PRAGMA user_version`).Scan(&v); err != nil {
		return err
	}
	for i, schema := range []string{schemaV1, schemaV2, schemaV3, schemaV4, schemaV5} {
		if v >= i+1 {
			continue
		}
		// Mỗi bản nâng cấp trong một giao dịch: hỏng giữa chừng thì cơ sở dữ liệu giữ nguyên bản cũ.
		tx, err := m.db.Begin()
		if err != nil {
			return err
		}
		if _, err := tx.Exec(schema); err != nil {
			tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}

const schemaV1 = `
CREATE TABLE runs (
  id TEXT PRIMARY KEY, app TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER NOT NULL,
  devices INTEGER NOT NULL, repeat INTEGER NOT NULL, passed INTEGER NOT NULL, failed INTEGER NOT NULL,
  canceled INTEGER NOT NULL, out_dir TEXT NOT NULL, max_rss_mb REAL NOT NULL, cpu_ms INTEGER NOT NULL);
CREATE TABLE flow_runs (
  id INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL, platform TEXT NOT NULL, driver TEXT NOT NULL, flow TEXT NOT NULL,
  iteration INTEGER NOT NULL, device_count INTEGER NOT NULL, passed INTEGER NOT NULL, duration_ms INTEGER NOT NULL,
  cold INTEGER NOT NULL, driver_start_ms INTEGER NOT NULL, failure_class TEXT NOT NULL, error TEXT NOT NULL,
  video TEXT NOT NULL, video_truncated INTEGER NOT NULL);
CREATE INDEX flow_runs_flow ON flow_runs(flow, device_id);
CREATE TABLE steps (
  flow_run_id INTEGER NOT NULL REFERENCES flow_runs(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL, depth INTEGER NOT NULL, command TEXT NOT NULL, descr TEXT NOT NULL,
  passed INTEGER NOT NULL, duration_ms INTEGER NOT NULL, error TEXT NOT NULL);
PRAGMA user_version = 1;`

// v2: nhãn bản app của lượt chạy (so sánh bản cũ/mới) và sổ gọi LLM.
const schemaV2 = `
ALTER TABLE runs ADD COLUMN label TEXT NOT NULL DEFAULT '';
CREATE TABLE llm_calls (
  at INTEGER NOT NULL, app TEXT NOT NULL, flow TEXT NOT NULL, purpose TEXT NOT NULL, effort TEXT NOT NULL,
  model TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cache_tokens INTEGER NOT NULL,
  cost_vnd REAL NOT NULL, stop_reason TEXT NOT NULL);
CREATE INDEX llm_calls_at ON llm_calls(at);
PRAGMA user_version = 2;`

// v3: chỉ mục cho báo cáo và số đo theo thời gian; ngân sách còn lại theo Worker sau mỗi lần gọi LLM.
const schemaV3 = `
CREATE INDEX steps_flow_run ON steps(flow_run_id);
CREATE INDEX runs_started ON runs(started_at);
CREATE INDEX flow_runs_run ON flow_runs(run_id);
ALTER TABLE llm_calls ADD COLUMN budget_left_vnd REAL NOT NULL DEFAULT -1;
PRAGMA user_version = 3;`

// v4: tốc độ gõ (phím/giây) đã áp cho từng flow, để kiểm tra lỗi rơi phím trên báo cáo lượt chạy.
const schemaV4 = `
ALTER TABLE flow_runs ADD COLUMN typing_frequency INTEGER NOT NULL DEFAULT 0;
PRAGMA user_version = 4;`

// v5: evidence theo bước (YAML, selector, phần tử, loại lỗi, gợi ý, ảnh trước/sau, cây UI, giờ bắt đầu), mức ảnh của
// lượt; sổ LLM đủ nội dung (độ trễ, yêu cầu, phản hồi, lỗi, cuộc chat); sổ tool, lịch sử sử dụng và cài đặt cục bộ.
const schemaV5 = `
ALTER TABLE steps ADD COLUMN label TEXT NOT NULL DEFAULT '';
ALTER TABLE steps ADD COLUMN yaml TEXT NOT NULL DEFAULT '';
ALTER TABLE steps ADD COLUMN selector TEXT NOT NULL DEFAULT '';
ALTER TABLE steps ADD COLUMN element TEXT NOT NULL DEFAULT '';
ALTER TABLE steps ADD COLUMN error_type TEXT NOT NULL DEFAULT '';
ALTER TABLE steps ADD COLUMN suggestion TEXT NOT NULL DEFAULT '';
ALTER TABLE steps ADD COLUMN shot_before TEXT NOT NULL DEFAULT '';
ALTER TABLE steps ADD COLUMN shot_after TEXT NOT NULL DEFAULT '';
ALTER TABLE steps ADD COLUMN hierarchy TEXT NOT NULL DEFAULT '';
ALTER TABLE steps ADD COLUMN started_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN artifacts TEXT NOT NULL DEFAULT '';
ALTER TABLE llm_calls ADD COLUMN latency_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE llm_calls ADD COLUMN request TEXT NOT NULL DEFAULT '';
ALTER TABLE llm_calls ADD COLUMN response TEXT NOT NULL DEFAULT '';
ALTER TABLE llm_calls ADD COLUMN error TEXT NOT NULL DEFAULT '';
ALTER TABLE llm_calls ADD COLUMN conv_id TEXT NOT NULL DEFAULT '';
CREATE TABLE tool_calls (
  id INTEGER PRIMARY KEY, at INTEGER NOT NULL, source TEXT NOT NULL, tool TEXT NOT NULL, args TEXT NOT NULL,
  result TEXT NOT NULL, error_code TEXT NOT NULL, error TEXT NOT NULL, duration_ms INTEGER NOT NULL);
CREATE INDEX tool_calls_at ON tool_calls(at);
CREATE TABLE usage_events (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL);
CREATE INDEX usage_events_at ON usage_events(at);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
PRAGMA user_version = 5;`

// RecordLLM ghi một lần gọi LLM vào sổ. Request/Response/Error phải đã che bí mật và cắt (xem JournalText).
func (m *Metrics) RecordLLM(e LedgerEntry) error {
	_, err := m.db.Exec(`INSERT INTO llm_calls (at, app, flow, purpose, effort, model, input_tokens, output_tokens, cache_tokens,
  cost_vnd, stop_reason, budget_left_vnd, latency_ms, request, response, error, conv_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		e.At.UnixMilli(), e.App, e.Flow, e.Purpose, e.Effort, e.Model, e.InputTokens, e.OutputTokens, e.CacheTokens, e.CostVnd,
		e.StopReason, e.BudgetLeftVnd, e.LatencyMs, e.Request, e.Response, e.Error, e.ConvID)
	return err
}

const ledgerCols = `rowid, at, app, flow, purpose, effort, model, input_tokens, output_tokens, cache_tokens, cost_vnd,
  stop_reason, budget_left_vnd, latency_ms, error, conv_id`

func scanLedger(sc interface{ Scan(...any) error }, extra ...any) (LedgerEntry, error) {
	var e LedgerEntry
	var at int64
	dest := append([]any{&e.ID, &at, &e.App, &e.Flow, &e.Purpose, &e.Effort, &e.Model, &e.InputTokens, &e.OutputTokens,
		&e.CacheTokens, &e.CostVnd, &e.StopReason, &e.BudgetLeftVnd, &e.LatencyMs, &e.Error, &e.ConvID}, extra...)
	if err := sc.Scan(dest...); err != nil {
		return e, err
	}
	e.At = time.UnixMilli(at)
	return e, nil
}

// Ledger: các lần gọi LLM từ since (mới trước), tối đa limit. Không kèm nội dung yêu cầu/phản hồi (xem LLMCall).
func (m *Metrics) Ledger(since time.Time, limit int) ([]LedgerEntry, error) {
	rows, err := m.db.Query(`SELECT `+ledgerCols+` FROM llm_calls WHERE at >= ? ORDER BY at DESC, rowid DESC LIMIT ?`,
		since.UnixMilli(), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []LedgerEntry{}
	for rows.Next() {
		e, err := scanLedger(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// LLMCall: một lần gọi LLM theo ID, kèm nội dung yêu cầu và phản hồi (đã che); not_found nếu không có.
func (m *Metrics) LLMCall(id int64) (LedgerEntry, error) {
	var req, res string
	e, err := scanLedger(m.db.QueryRow(`SELECT `+ledgerCols+`, request, response FROM llm_calls WHERE rowid = ?`, id), &req, &res)
	if errors.Is(err, sql.ErrNoRows) {
		return LedgerEntry{}, apperr.New(apperr.CodeNotFound, "lần gọi LLM "+strconv.FormatInt(id, 10))
	}
	e.Request, e.Response = req, res
	return e, err
}

// llmCallsBetween: các lần gọi LLM trong [from, to] kèm nội dung (cũ trước), cho gói xuất.
func (m *Metrics) llmCallsBetween(from, to time.Time) ([]LedgerEntry, error) {
	rows, err := m.db.Query(`SELECT `+ledgerCols+`, request, response FROM llm_calls WHERE at >= ? AND at <= ?
  ORDER BY at, rowid`, from.UnixMilli(), to.UnixMilli())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []LedgerEntry{}
	for rows.Next() {
		var req, res string
		e, err := scanLedger(rows, &req, &res)
		if err != nil {
			return nil, err
		}
		e.Request, e.Response = req, res
		out = append(out, e)
	}
	return out, rows.Err()
}

// Save ghi một lượt chạy cùng mọi flow và bước của nó trong một giao dịch.
func (m *Metrics) Save(r RunRecord, flows []FlowRun) error {
	tx, err := m.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`INSERT INTO runs (id, app, started_at, finished_at, devices, repeat, passed, failed, canceled, out_dir,
  max_rss_mb, cpu_ms, label, artifacts) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, r.ID, r.App, r.StartedAt.UnixMilli(),
		r.FinishedAt.UnixMilli(), r.Devices, r.Repeat, r.Passed, r.Failed, r.Canceled, r.OutDir, r.MaxRSSMB, r.CPUMs, r.Label,
		r.Artifacts); err != nil {
		return err
	}
	for _, f := range flows {
		res, err := tx.Exec(`INSERT INTO flow_runs (run_id, device_id, platform, driver, flow, iteration, device_count, passed,
  duration_ms, cold, driver_start_ms, failure_class, error, video, video_truncated, typing_frequency)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			r.ID, f.DeviceID, f.Platform, f.Driver, f.Flow, f.Iteration, f.DeviceCount, f.Passed, f.DurationMs, f.Cold,
			f.DriverStartMs, f.FailureClass, f.Error, f.Video, f.VideoTruncated, f.TypingFrequency)
		if err != nil {
			return err
		}
		id, _ := res.LastInsertId()
		for _, s := range f.Steps {
			var started int64
			if !s.StartedAt.IsZero() {
				started = s.StartedAt.UnixMilli()
			}
			if _, err := tx.Exec(`INSERT INTO steps (flow_run_id, idx, depth, command, descr, passed, duration_ms, error, label,
  yaml, selector, element, error_type, suggestion, shot_before, shot_after, hierarchy, started_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, s.Index, s.Depth, s.Command, s.Desc, s.Passed, s.DurationMs, s.Error,
				s.Label, s.Yaml, s.Selector, s.Element, s.ErrorType, s.Suggestion, s.ShotBefore, s.ShotAfter, s.Hierarchy,
				started); err != nil {
				return err
			}
		}
	}
	return tx.Commit()
}

// Runs: các lượt gần nhất, mới trước.
func (m *Metrics) Runs(limit int) ([]RunRecord, error) {
	return m.queryRuns(`SELECT `+runCols+` FROM runs ORDER BY started_at DESC LIMIT ?`, limit)
}

const runCols = `id, app, started_at, finished_at, devices, repeat, passed, failed, canceled, out_dir, max_rss_mb, cpu_ms, label,
  artifacts`

func scanRun(sc interface{ Scan(...any) error }) (RunRecord, error) {
	var r RunRecord
	var s, f int64
	if err := sc.Scan(&r.ID, &r.App, &s, &f, &r.Devices, &r.Repeat, &r.Passed, &r.Failed, &r.Canceled, &r.OutDir,
		&r.MaxRSSMB, &r.CPUMs, &r.Label, &r.Artifacts); err != nil {
		return r, err
	}
	r.StartedAt, r.FinishedAt = time.UnixMilli(s), time.UnixMilli(f)
	return r, nil
}

func (m *Metrics) queryRuns(query string, args ...any) ([]RunRecord, error) {
	rows, err := m.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []RunRecord{}
	for rows.Next() {
		r, err := scanRun(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// MetricsQuery lọc số đo; trống = tất cả.
type MetricsQuery struct {
	App    string    `json:"app"`
	Flow   string    `json:"flow"`
	Device string    `json:"device"`
	Since  time.Time `json:"since"`
}

// Stat: thống kê thời gian của một nhóm.
type Stat struct {
	Key    string  `json:"key"`
	Count  int     `json:"count"`
	Passed int     `json:"passed"`
	P50Ms  int64   `json:"p50Ms"`
	P95Ms  int64   `json:"p95Ms"`
	Rate   float64 `json:"passRate"`
}

// Summary: số đo cho pane 4 và test_metrics.
type Summary struct {
	ByDevice      []Stat  `json:"byDevice"`      // thời gian flow theo thiết bị
	ByDeviceCount []Stat  `json:"byDeviceCount"` // theo số thiết bị song song
	ColdVsWarm    []Stat  `json:"coldVsWarm"`    // flow đầu trên driver mới vs dùng lại
	DriverStart   Stat    `json:"driverStart"`   // thời gian tạo driver
	TapSteps      Stat    `json:"tapSteps"`      // bước tapOn: thay cho độ trễ chạm trong M1
	StepFailures  []Stat  `json:"stepFailures"`  // bước hay hỏng nhất (Key = lệnh + mô tả)
	MaxParallelOK int     `json:"maxParallelOk"` // số thiết bị song song lớn nhất mà mọi flow đều đạt
	MaxRSSMB      float64 `json:"maxRssMB"`
	CPUMsPerRun   int64   `json:"cpuMsPerRun"`
}

func (m *Metrics) Summary(q MetricsQuery) (Summary, error) {
	where, args := q.where()
	type row struct {
		device, flow string
		count, start int64
		dur          int64
		passed, cold bool
	}
	rows, err := m.db.Query(`SELECT f.device_id, f.flow, f.device_count, f.driver_start_ms, f.duration_ms, f.passed, f.cold
  FROM flow_runs f JOIN runs r ON r.id = f.run_id`+where, args...)
	if err != nil {
		return Summary{}, err
	}
	var all []row
	for rows.Next() {
		var x row
		if err := rows.Scan(&x.device, &x.flow, &x.count, &x.start, &x.dur, &x.passed, &x.cold); err != nil {
			rows.Close()
			return Summary{}, err
		}
		all = append(all, x)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return Summary{}, err
	}
	rows.Close()

	var s Summary
	group := func(key func(row) string) []Stat {
		g := map[string][]sample{}
		for _, x := range all {
			g[key(x)] = append(g[key(x)], sample{x.dur, x.passed})
		}
		return stats(g)
	}
	s.ByDevice = group(func(x row) string { return x.device })
	s.ByDeviceCount = group(func(x row) string { return strconv.Itoa(int(x.count)) })
	s.ColdVsWarm = group(func(x row) string {
		if x.cold {
			return "cold"
		}
		return "warm"
	})
	var starts []sample
	okByCount := map[int64]bool{}
	for _, x := range all {
		if x.cold && x.start > 0 {
			starts = append(starts, sample{x.start, true})
		}
		if _, seen := okByCount[x.count]; !seen {
			okByCount[x.count] = true
		}
		okByCount[x.count] = okByCount[x.count] && x.passed
	}
	s.DriverStart = statOf("driverStart", starts)
	for n, ok := range okByCount {
		if ok && int(n) > s.MaxParallelOK {
			s.MaxParallelOK = int(n)
		}
	}

	stepRows, err := m.db.Query(`SELECT s.command, s.descr, s.duration_ms, s.passed FROM steps s
  JOIN flow_runs f ON f.id = s.flow_run_id JOIN runs r ON r.id = f.run_id`+where, args...)
	if err != nil {
		return Summary{}, err
	}
	var taps []sample
	fails := map[string][]sample{}
	for stepRows.Next() {
		var cmd, desc string
		var d int64
		var passed bool
		if err := stepRows.Scan(&cmd, &desc, &d, &passed); err != nil {
			stepRows.Close()
			return Summary{}, err
		}
		if cmd == "tapOn" {
			taps = append(taps, sample{d, passed})
		}
		fails[desc] = append(fails[desc], sample{d, passed})
	}
	if err := stepRows.Err(); err != nil {
		stepRows.Close()
		return Summary{}, err
	}
	stepRows.Close()
	s.TapSteps = statOf("tapOn", taps)
	for _, st := range stats(fails) {
		if st.Passed < st.Count {
			s.StepFailures = append(s.StepFailures, st)
		}
	}
	sort.SliceStable(s.StepFailures, func(i, j int) bool {
		return s.StepFailures[i].Count-s.StepFailures[i].Passed > s.StepFailures[j].Count-s.StepFailures[j].Passed
	})
	if len(s.StepFailures) > 10 {
		s.StepFailures = s.StepFailures[:10]
	}

	// RAM/CPU đo theo lượt chạy nên chỉ lọc theo app và thời gian (bỏ lọc flow, thiết bị).
	rw, ra := MetricsQuery{App: q.App, Since: q.Since}.where()
	_ = m.db.QueryRow(`SELECT COALESCE(MAX(max_rss_mb),0), COALESCE(AVG(cpu_ms),0) FROM runs r`+rw, ra...).Scan(&s.MaxRSSMB, &s.CPUMsPerRun)
	return s, nil
}

func (q MetricsQuery) where() (string, []any) {
	var conds []string
	var args []any
	if q.App != "" {
		conds, args = append(conds, "r.app = ?"), append(args, q.App)
	}
	if q.Flow != "" {
		conds, args = append(conds, "f.flow = ?"), append(args, q.Flow)
	}
	if q.Device != "" {
		conds, args = append(conds, "f.device_id = ?"), append(args, q.Device)
	}
	if !q.Since.IsZero() {
		conds, args = append(conds, "r.started_at >= ?"), append(args, q.Since.UnixMilli())
	}
	if len(conds) == 0 {
		return "", nil
	}
	return " WHERE " + strings.Join(conds, " AND "), args
}

type sample struct {
	ms     int64
	passed bool
}

func stats(g map[string][]sample) []Stat {
	out := make([]Stat, 0, len(g))
	for k, v := range g {
		out = append(out, statOf(k, v))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Key < out[j].Key })
	return out
}

func statOf(key string, v []sample) Stat {
	st := Stat{Key: key, Count: len(v)}
	if len(v) == 0 {
		return st
	}
	ms := make([]int64, len(v))
	for i, x := range v {
		ms[i] = x.ms
		if x.passed {
			st.Passed++
		}
	}
	sort.Slice(ms, func(i, j int) bool { return ms[i] < ms[j] })
	st.P50Ms, st.P95Ms = percentile(ms, 0.50), percentile(ms, 0.95)
	st.Rate = float64(st.Passed) / float64(st.Count)
	return st
}

// percentile theo thứ hạng gần nhất trên dãy đã sắp xếp.
func percentile(sorted []int64, q float64) int64 {
	idx := int(q*float64(len(sorted)) + 0.999999) // ceil(q*n)
	if idx < 1 {
		idx = 1
	}
	if idx > len(sorted) {
		idx = len(sorted)
	}
	return sorted[idx-1]
}

// FlowRuns: mọi flow của một lượt chạy (kèm bước), theo thiết bị, lần lặp, flow. Một truy vấn nối bảng bước.
func (m *Metrics) FlowRuns(runID string) ([]FlowRun, error) {
	rows, err := m.db.Query(`SELECT f.id, f.device_id, f.platform, f.driver, f.flow, f.iteration, f.device_count, f.passed,
  f.duration_ms, f.cold, f.driver_start_ms, f.failure_class, f.error, f.video, f.video_truncated, f.typing_frequency,
  s.idx, s.depth, s.command, s.descr, s.passed, s.duration_ms, s.error, s.label, s.yaml, s.selector, s.element,
  s.error_type, s.suggestion, s.shot_before, s.shot_after, s.hierarchy, s.started_at
  FROM flow_runs f LEFT JOIN steps s ON s.flow_run_id = f.id
  WHERE f.run_id = ? ORDER BY f.device_id, f.iteration, f.flow, f.id, s.rowid`, runID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []FlowRun
	lastID := int64(-1)
	for rows.Next() {
		f := FlowRun{RunID: runID}
		var id int64
		var idx, depth sql.NullInt64
		var cmd, desc, serr sql.NullString
		var spassed sql.NullBool
		var sdur, sstart sql.NullInt64
		var ev [9]sql.NullString // label, yaml, selector, element, error_type, suggestion, shot_before, shot_after, hierarchy
		if err := rows.Scan(&id, &f.DeviceID, &f.Platform, &f.Driver, &f.Flow, &f.Iteration, &f.DeviceCount, &f.Passed, &f.DurationMs,
			&f.Cold, &f.DriverStartMs, &f.FailureClass, &f.Error, &f.Video, &f.VideoTruncated, &f.TypingFrequency,
			&idx, &depth, &cmd, &desc, &spassed, &sdur, &serr, &ev[0], &ev[1], &ev[2], &ev[3], &ev[4], &ev[5], &ev[6], &ev[7],
			&ev[8], &sstart); err != nil {
			return nil, err
		}
		if id != lastID {
			out = append(out, f)
			lastID = id
		}
		if idx.Valid {
			cur := &out[len(out)-1]
			st := StepRun{Index: int(idx.Int64), Depth: int(depth.Int64), Command: cmd.String, Desc: desc.String,
				Passed: spassed.Bool, DurationMs: sdur.Int64, Error: serr.String, Label: ev[0].String, Yaml: ev[1].String,
				Selector: ev[2].String, Element: ev[3].String, ErrorType: ev[4].String, Suggestion: ev[5].String,
				ShotBefore: ev[6].String, ShotAfter: ev[7].String, Hierarchy: ev[8].String}
			if sstart.Int64 > 0 {
				st.StartedAt = time.UnixMilli(sstart.Int64)
			}
			cur.Steps = append(cur.Steps, st)
		}
	}
	return out, rows.Err()
}

// FlowOutcomes: số lượt flow, số đạt và số lỗi theo loại từ since (Health, Alerts của tháp).
func (m *Metrics) FlowOutcomes(since time.Time) (total, passed int, byClass map[string]int, err error) {
	byClass = map[string]int{}
	rows, err := m.db.Query(`SELECT f.passed, f.failure_class, COUNT(*) FROM flow_runs f JOIN runs r ON r.id = f.run_id
  WHERE r.started_at >= ? GROUP BY f.passed, f.failure_class`, since.UnixMilli())
	if err != nil {
		return 0, 0, nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var ok bool
		var class string
		var n int
		if err := rows.Scan(&ok, &class, &n); err != nil {
			return 0, 0, nil, err
		}
		total += n
		if ok {
			passed += n
		} else {
			byClass[class] += n
		}
	}
	return total, passed, byClass, rows.Err()
}

// StatsByDevice: p50/p95 và tỉ lệ đạt theo thiết bị cho một danh sách lượt flow (thẻ báo cáo).
func StatsByDevice(runs []FlowRun) []Stat {
	g := map[string][]sample{}
	for _, r := range runs {
		g[r.DeviceID] = append(g[r.DeviceID], sample{r.DurationMs, r.Passed})
	}
	return stats(g)
}

// Run: một lượt theo ID; not_found nếu không có.
func (m *Metrics) Run(id string) (RunRecord, error) {
	r, err := scanRun(m.db.QueryRow(`SELECT `+runCols+` FROM runs WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return r, apperr.New(apperr.CodeNotFound, "lượt chạy "+id)
	}
	return r, err
}

// Kết quả chạy gần nhất của một flow.
const (
	FlowPassed = "passed"
	FlowFailed = "failed"
)

// FlowResult: lượt chạy gần nhất có flow; Status = failed nếu flow lỗi ở bất kỳ thiết bị/lần lặp nào của lượt đó.
type FlowResult struct {
	Status string    `json:"status"`
	RunID  string    `json:"runId"`
	At     time.Time `json:"at"`
}

// LastFlowResults: kết quả gần nhất theo tên flow của app. Lượt chạy xác nhận ứng viên (.candidate-<tên>) tính cho flow
// <tên>, vì nó chạy đúng nội dung được lưu. Flow chưa chạy lần nào không có trong map.
func (m *Metrics) LastFlowResults(app string) (map[string]FlowResult, error) {
	rows, err := m.db.Query(`SELECT f.flow, r.id, r.started_at, MIN(f.passed) FROM flow_runs f JOIN runs r ON r.id = f.run_id
  WHERE r.app = ? GROUP BY r.id, f.flow ORDER BY r.started_at, r.rowid`, app)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]FlowResult{}
	for rows.Next() {
		var name, runID string
		var at int64
		var passed bool
		if err := rows.Scan(&name, &runID, &at, &passed); err != nil {
			return nil, err
		}
		dir, base := path.Split(name)
		name = dir + strings.TrimPrefix(base, candidatePrefix)
		res := FlowResult{Status: FlowFailed, RunID: runID, At: time.UnixMilli(at)}
		if passed {
			res.Status = FlowPassed
		}
		out[name] = res // sắp theo giờ bắt đầu: lượt sau đè lượt trước
	}
	return out, rows.Err()
}

// MachineMs: tổng thời gian máy (mọi lượt flow trên mọi thiết bị) từ since, để báo cáo phút máy.
func (m *Metrics) MachineMs(since time.Time) (int64, error) {
	var ms int64
	err := m.db.QueryRow(`SELECT COALESCE(SUM(f.duration_ms), 0) FROM flow_runs f JOIN runs r ON r.id = f.run_id WHERE r.started_at >= ?`,
		since.UnixMilli()).Scan(&ms)
	return ms, err
}
