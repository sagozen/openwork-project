package memory

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"time"
	"unicode"

	_ "modernc.org/sqlite" // the "sqlite" driver for the read-only testengine.db connection
)

// FlakyWindow is how far back RefreshFlaky reads flow results.
const FlakyWindow = 30 * 24 * time.Hour

// flakyGap is how soon after a failure a pass of the same flow on the same platform counts as a flaky pass (a
// re-run that passed), when it is not in the same run. A pass days later is a fix, not flakiness.
const flakyGap = time.Hour

// candidatePrefix marks a confirmation run of a candidate flow; it counts for the flow it would replace.
const candidatePrefix = ".candidate-"

// FlakyStat is one row of flaky_stats.
type FlakyStat struct {
	App         string  `json:"app"`
	Flow        string  `json:"flow"`
	Platform    string  `json:"platform"`
	Runs        int     `json:"runs"`
	Fails       int     `json:"fails"`
	FlakyPasses int     `json:"flakyPasses"`
	LastFailAt  int64   `json:"lastFailAt,omitempty"`
	TopCauses   []Cause `json:"topCauses,omitempty"`
	UpdatedAt   int64   `json:"updatedAt"`
}

// Cause is a failure class with how often it occurred and one example message.
type Cause struct {
	Class   string `json:"class"`
	Count   int    `json:"count"`
	Example string `json:"example,omitempty"`
}

// maxCauses is how many failure classes a flaky_stats row keeps; maxExample bounds the example message.
const (
	maxCauses  = 3
	maxExample = 200
)

// openTestDB opens testengine.db read-only. ok is false when the file does not exist yet (nothing has run).
func openTestDB(p string) (*sql.DB, bool, error) {
	if _, err := os.Stat(p); errors.Is(err, os.ErrNotExist) {
		return nil, false, nil
	}
	q := url.Values{}
	q.Set("mode", "ro")
	for _, pr := range []string{"busy_timeout(5000)", "query_only(1)"} {
		q.Add("_pragma", pr)
	}
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(p)+"?"+q.Encode())
	if err != nil {
		return nil, false, err
	}
	db.SetMaxOpenConns(1)
	return db, true, nil
}

type flowResult struct {
	app, flow, platform, runID string
	at                         int64
	passed                     bool
	class, err                 string
}

// RefreshFlaky recomputes flaky_stats from the flow results of the last window in testengine.db (flow_runs joined
// with runs, read-only). A flow's row counts its runs and failures, the passes that came right after a failure
// (same run, or within an hour: a re-run that passed), its last failure and its most common failure classes. Rows of
// flows with no result in the window are dropped. Without a testengine.db it does nothing.
func (s *Service) RefreshFlaky(ctx context.Context, window time.Duration) error {
	if s.opts.TestDB == "" {
		return nil
	}
	src, ok, err := openTestDB(s.opts.TestDB)
	if err != nil || !ok {
		return err
	}
	defer src.Close()
	now := s.now()
	rows, err := src.QueryContext(ctx, `SELECT r.app, f.flow, f.platform, r.id, r.started_at, f.passed, f.failure_class, f.error
  FROM flow_runs f JOIN runs r ON r.id = f.run_id WHERE r.started_at >= ? ORDER BY r.started_at, r.rowid, f.id`,
		now.Add(-window).UnixMilli())
	if err != nil {
		return err
	}
	var results []flowResult
	for rows.Next() {
		var fr flowResult
		if err := rows.Scan(&fr.app, &fr.flow, &fr.platform, &fr.runID, &fr.at, &fr.passed, &fr.class, &fr.err); err != nil {
			rows.Close()
			return err
		}
		dir, base := path.Split(fr.flow)
		fr.flow = dir + strings.TrimPrefix(base, candidatePrefix)
		results = append(results, fr)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	stats := s.flakyStats(results, now)

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `DELETE FROM flaky_stats`); err != nil {
		return err
	}
	for _, st := range stats {
		causes, err := json.Marshal(st.TopCauses)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO flaky_stats (app, flow, platform, runs, fails, flaky_passes, last_fail_at,
  top_causes_json, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`, st.App, st.Flow, st.Platform, st.Runs, st.Fails, st.FlakyPasses,
			st.LastFailAt, string(causes), st.UpdatedAt); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *Service) flakyStats(results []flowResult, now time.Time) []FlakyStat {
	type acc struct {
		st      FlakyStat
		causes  map[string]*Cause
		lastErr *flowResult // the latest failure not yet followed by a pass
	}
	byKey := map[string]*acc{}
	var order []string
	for i := range results {
		fr := &results[i]
		key := fr.app + "\x00" + fr.flow + "\x00" + fr.platform
		a := byKey[key]
		if a == nil {
			a = &acc{st: FlakyStat{App: fr.app, Flow: fr.flow, Platform: fr.platform, UpdatedAt: now.UnixMilli()}, causes: map[string]*Cause{}}
			byKey[key] = a
			order = append(order, key)
		}
		a.st.Runs++
		if !fr.passed {
			a.st.Fails++
			a.st.LastFailAt = max(a.st.LastFailAt, fr.at)
			class := fr.class
			if class == "" {
				class = "unknown"
			}
			c := a.causes[class]
			if c == nil {
				c = &Cause{Class: class}
				a.causes[class] = c
			}
			c.Count++
			if msg := strings.TrimSpace(fr.err); msg != "" {
				c.Example = clipTo(s.redact(msg), maxExample)
			}
			a.lastErr = fr
			continue
		}
		if f := a.lastErr; f != nil && (f.runID == fr.runID || time.Duration(fr.at-f.at)*time.Millisecond <= flakyGap) {
			a.st.FlakyPasses++
		}
		a.lastErr = nil
	}
	out := make([]FlakyStat, 0, len(order))
	for _, key := range order {
		a := byKey[key]
		for _, c := range a.causes {
			a.st.TopCauses = append(a.st.TopCauses, *c)
		}
		sort.Slice(a.st.TopCauses, func(i, j int) bool {
			ci, cj := a.st.TopCauses[i], a.st.TopCauses[j]
			if ci.Count != cj.Count {
				return ci.Count > cj.Count
			}
			return ci.Class < cj.Class
		})
		if len(a.st.TopCauses) > maxCauses {
			a.st.TopCauses = a.st.TopCauses[:maxCauses]
		}
		out = append(out, a.st)
	}
	return out
}

func clipTo(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n-1]) + "…"
}

const flakyCols = `app, flow, platform, runs, fails, flaky_passes, last_fail_at, top_causes_json, updated_at`

func scanFlaky(rows *sql.Rows) ([]FlakyStat, error) {
	defer rows.Close()
	out := []FlakyStat{}
	for rows.Next() {
		var st FlakyStat
		var causes string
		if err := rows.Scan(&st.App, &st.Flow, &st.Platform, &st.Runs, &st.Fails, &st.FlakyPasses, &st.LastFailAt, &causes, &st.UpdatedAt); err != nil {
			return nil, err
		}
		_ = json.Unmarshal([]byte(causes), &st.TopCauses) // written by RefreshFlaky; a bad value only loses the causes
		out = append(out, st)
	}
	return out, rows.Err()
}

// TopFlaky lists the flows that failed in the window, most failures (then flaky passes) first, at most limit.
func (s *Service) TopFlaky(ctx context.Context, limit int) ([]FlakyStat, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+flakyCols+` FROM flaky_stats WHERE fails > 0 OR flaky_passes > 0
  ORDER BY fails DESC, flaky_passes DESC, app, flow, platform LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	return scanFlaky(rows)
}

// FlakyFor returns the flaky_stats rows of the flows the text names: a flow matches when its name without folder,
// numeric prefix and extension ("02_order/01_login.yaml" -> "login") is a word of the text, or the text holds its
// file name. When the text names a platform (ios, android, web), only that platform's rows are kept.
func (s *Service) FlakyFor(ctx context.Context, text string) ([]FlakyStat, error) {
	words := map[string]bool{}
	lower := strings.ToLower(text)
	for _, w := range strings.FieldsFunc(lower, func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) && r != '_' && r != '-' }) {
		words[w] = true
	}
	var platforms []string
	for _, p := range []string{"ios", "android", "web"} {
		if words[p] {
			platforms = append(platforms, p)
		}
	}
	rows, err := s.db.QueryContext(ctx, `SELECT `+flakyCols+` FROM flaky_stats ORDER BY app, flow, platform`)
	if err != nil {
		return nil, err
	}
	all, err := scanFlaky(rows)
	if err != nil {
		return nil, err
	}
	out := []FlakyStat{}
	for _, st := range all {
		if len(platforms) > 0 && !slices.Contains(platforms, strings.ToLower(st.Platform)) {
			continue
		}
		base := strings.ToLower(path.Base(st.Flow))
		short := FlowShortName(st.Flow)
		if (short != "" && words[short]) || strings.Contains(lower, base) {
			out = append(out, st)
		}
	}
	return out, nil
}

// FlowShortName is the name a tester types for a flow: "02_order/01_login.yaml" -> "login".
func FlowShortName(flow string) string {
	base := strings.ToLower(path.Base(flow))
	if i := strings.Index(base, "."); i > 0 {
		base = base[:i]
	}
	if i := strings.IndexFunc(base, func(r rune) bool { return !unicode.IsDigit(r) }); i > 0 && (base[i] == '_' || base[i] == '-') {
		base = base[i+1:]
	}
	return base
}
