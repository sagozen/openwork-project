// Package memory is the long-term QA memory of the agents, stored in agent.db: facts, fixes and session summaries
// (memories), confirmed failure causes (known_issues), which flows test which feature (feature_flow_map) and flow
// flakiness recomputed from testengine.db (flaky_stats).
//
// Service implements ADK memory.Service and memory.EventAdder. Agents reach the tables only through the tools in
// tools.go; they never get SQL. Search is keyword search over SQLite FTS5 with BM25 ranking; there are no embeddings.
package memory

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode"

	adkmemory "google.golang.org/adk/v2/memory"
	"google.golang.org/adk/v2/session"
	"google.golang.org/genai"
)

// Memory kinds stored in the memories table.
const (
	KindFact           = "fact"
	KindFix            = "fix"
	KindPreference     = "preference"
	KindSessionSummary = "session_summary"
)

// Sources of a search hit, carried in Entry.CustomMetadata["source"].
const (
	SourceMemory     = "memory"
	SourceKnownIssue = "known_issue"
	SourceFeatureMap = "feature_map"
)

// MaxText bounds one stored text (a fact, a field of a known issue, a session summary), in characters.
const MaxText = 2000

// searchLimit bounds the hits one search returns, across all sources.
const searchLimit = 10

// Options configures a Service.
type Options struct {
	// TestDB is the path of testengine.db, read (never written) by RefreshFlaky. "" = flaky stats are not refreshed.
	TestDB string
	// Redact replaces secret values in a text. Normally testengine.Redact over Registry.Secrets. nil = no values known.
	Redact func(string) string
	// SecretNames lists the names (never the values) of the Keychain secrets, so "PASSWORD=..." is refused.
	SecretNames func() []string
	// Now is the clock; tests fix it. nil = time.Now.
	Now func() time.Time
}

// Service is the SQLite memory service.
type Service struct {
	db   *sql.DB
	opts Options
}

var (
	_ adkmemory.Service    = (*Service)(nil)
	_ adkmemory.EventAdder = (*Service)(nil)
)

// New returns a Service over agent.db. The tables must exist (store.Migrate).
func New(db *sql.DB, opts Options) (*Service, error) {
	if db == nil {
		return nil, errors.New("memory service needs the agent.db connection")
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	return &Service{db: db, opts: opts}, nil
}

func (s *Service) now() time.Time { return s.opts.Now() }

func (s *Service) redact(text string) string {
	if s.opts.Redact == nil {
		return text
	}
	return s.opts.Redact(text)
}

func newID() string {
	var b [12]byte
	_, _ = rand.Read(b[:]) // crypto/rand.Read never fails on supported platforms
	return hex.EncodeToString(b[:])
}

// clip shortens text to MaxText characters.
func clip(text string) string {
	r := []rune(strings.TrimSpace(text))
	if len(r) <= MaxText {
		return string(r)
	}
	return string(r[:MaxText-1]) + "…"
}

// AddSessionToMemory stores one compact summary of the session as a session_summary: the request that opened it and
// the latest compaction summary, or else the Reporter's report, or else the last agent answer. A session added again
// replaces its earlier summary. Secret values are redacted before storing.
func (s *Service) AddSessionToMemory(ctx context.Context, sess session.Session) error {
	if sess == nil {
		return errors.New("memory needs a session")
	}
	summary := SessionSummary(sess)
	if summary == "" {
		return nil
	}
	meta, err := json.Marshal(map[string]any{"session_id": sess.ID()})
	if err != nil {
		return err
	}
	at := sess.LastUpdateTime()
	if at.IsZero() {
		at = s.now()
	}
	_, err = s.db.ExecContext(ctx, `INSERT INTO memories (id, user_id, app_name, kind, text, metadata_json, created_at)
  VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET text = excluded.text, metadata_json = excluded.metadata_json,
  created_at = excluded.created_at`,
		"session:"+sess.ID(), sess.UserID(), sess.AppName(), KindSessionSummary, clip(s.redact(summary)), string(meta), at.UnixMilli())
	return err
}

// AddEventsToMemory stores the final agent answers of the batch as session summaries, one row per event. Events
// already stored are kept; an event whose ID was stored before is ignored.
func (s *Service) AddEventsToMemory(ctx context.Context, req *adkmemory.AddEventsRequest) error {
	if req == nil {
		return errors.New("memory needs an AddEventsRequest")
	}
	for _, ev := range req.Events {
		text := finalText(ev)
		if text == "" || ev.ID == "" {
			continue
		}
		meta, err := json.Marshal(map[string]any{"session_id": req.SessionID, "event_id": ev.ID, "author": ev.Author})
		if err != nil {
			return err
		}
		at := ev.Timestamp
		if at.IsZero() {
			at = s.now()
		}
		if _, err := s.db.ExecContext(ctx, `INSERT INTO memories (id, user_id, app_name, kind, text, metadata_json, created_at)
  VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
			"event:"+ev.ID, req.UserID, req.AppName, KindSessionSummary, clip(s.redact(text)), string(meta), at.UnixMilli()); err != nil {
			return err
		}
	}
	return nil
}

// SessionSummary is the text AddSessionToMemory stores for a session, "" when the session has no agent answer.
func SessionSummary(sess session.Session) string {
	var request, compacted, report, last string
	for ev := range sess.Events().All() {
		if ev == nil {
			continue
		}
		// Checked before the author: ADK may store a summary under any author, the user's included.
		if c := ev.Actions.Compaction; c != nil {
			if t := contentText(c.CompactedContent); t != "" {
				compacted = t
			}
			continue
		}
		if ev.Author == "user" {
			if request == "" && ev.Content != nil {
				for _, p := range ev.Content.Parts {
					if p != nil && strings.TrimSpace(p.Text) != "" {
						request = strings.TrimSpace(p.Text)
						break
					}
				}
			}
			continue
		}
		if t := finalText(ev); t != "" {
			last = t
			if ev.Author == "reporter" {
				report = t
			}
		}
	}
	body := compacted
	if body == "" {
		body = report
	}
	if body == "" {
		body = last
	}
	if body == "" {
		return ""
	}
	if request == "" {
		return body
	}
	return "Yêu cầu: " + request + "\n" + body
}

// finalText is the visible text of a stored, final agent event; "" for user, partial, thought or tool events.
func finalText(ev *session.Event) string {
	if ev == nil || ev.Partial || ev.Author == "user" || ev.Content == nil {
		return ""
	}
	for _, p := range ev.Content.Parts {
		if p != nil && (p.FunctionCall != nil || p.FunctionResponse != nil) {
			return ""
		}
	}
	return contentText(ev.Content)
}

func contentText(c *genai.Content) string {
	if c == nil {
		return ""
	}
	var b strings.Builder
	for _, p := range c.Parts {
		if p == nil || p.Thought || strings.TrimSpace(p.Text) == "" {
			continue
		}
		if b.Len() > 0 {
			b.WriteByte('\n')
		}
		b.WriteString(strings.TrimSpace(p.Text))
	}
	return b.String()
}

// hit is one search result before it becomes an Entry.
type hit struct {
	source string
	id     string
	kind   string
	text   string
	author string
	at     int64
	score  float64 // bm25: lower is better
}

// SearchMemory finds memories of the user, known issues and feature-to-flow links matching the query's words, best
// first (BM25), at most 10. Each Entry carries CustomMetadata{source, id} and, for memories, kind.
func (s *Service) SearchMemory(ctx context.Context, req *adkmemory.SearchRequest) (*adkmemory.SearchResponse, error) {
	if req == nil {
		return nil, errors.New("memory needs a SearchRequest")
	}
	hits, err := s.search(ctx, req.AppName, req.UserID, req.Query, nil)
	if err != nil {
		return nil, err
	}
	out := &adkmemory.SearchResponse{Memories: []adkmemory.Entry{}}
	for _, h := range hits {
		meta := map[string]any{"source": h.source, "id": h.id}
		if h.kind != "" {
			meta["kind"] = h.kind
		}
		out.Memories = append(out.Memories, adkmemory.Entry{
			ID: h.source + ":" + h.id, Content: genai.NewContentFromText(h.text, genai.RoleModel), Author: h.author,
			Timestamp: time.UnixMilli(h.at), CustomMetadata: meta,
		})
	}
	return out, nil
}

// kinds filter for search: memory kinds plus "known_issue" and "feature_map". Empty = everything.
func wants(kinds []string, k string) bool { return len(kinds) == 0 || slices.Contains(kinds, k) }

func (s *Service) search(ctx context.Context, appName, userID, query string, kinds []string) ([]hit, error) {
	match := ftsQuery(query)
	if match == "" {
		return nil, nil
	}
	var memKinds, sources []string
	for _, k := range []string{KindFact, KindFix, KindPreference, KindSessionSummary} {
		if wants(kinds, k) {
			memKinds = append(memKinds, k)
		}
	}
	if len(memKinds) > 0 {
		sources = append(sources, SourceMemory)
	}
	for _, src := range []string{SourceKnownIssue, SourceFeatureMap} {
		if wants(kinds, src) {
			sources = append(sources, src)
		}
	}
	if len(sources) == 0 {
		return nil, nil
	}
	refs, err := s.match(ctx, match, sources, memKinds, appName, userID, searchLimit)
	if err != nil {
		return nil, err
	}
	out := make([]hit, 0, len(refs))
	for _, r := range refs {
		h, ok, err := s.load(ctx, r)
		if err != nil {
			return nil, err
		}
		if ok {
			out = append(out, h)
		}
	}
	return out, nil
}

// ref is one row of the full-text index: which table, which row, and its BM25 score (lower is better).
type ref struct {
	source, id string
	score      float64
}

// match runs one FTS5 query over memories_fts, best first. Memory rows are limited to the user, app and kinds given
// ("" user or app = any); known issues and the feature map are shared by everyone on this machine.
func (s *Service) match(ctx context.Context, match string, sources, memKinds []string, appName, userID string, limit int) ([]ref, error) {
	q := `SELECT memories_fts.source, memories_fts.ref, bm25(memories_fts) FROM memories_fts
  LEFT JOIN memories m ON memories_fts.source = 'memory' AND m.id = memories_fts.ref
  WHERE memories_fts MATCH ? AND memories_fts.source IN (` + placeholders(len(sources)) + `)`
	args := []any{match}
	for _, src := range sources {
		args = append(args, src)
	}
	if slices.Contains(sources, SourceMemory) {
		cond := `m.kind IN (` + placeholders(len(memKinds)) + `)`
		for _, k := range memKinds {
			args = append(args, k)
		}
		if appName != "" {
			cond += ` AND m.app_name = ?`
			args = append(args, appName)
		}
		if userID != "" {
			cond += ` AND m.user_id = ?`
			args = append(args, userID)
		}
		q += ` AND (memories_fts.source <> 'memory' OR (` + cond + `))`
	}
	q += ` ORDER BY bm25(memories_fts) LIMIT ?`
	args = append(args, limit)
	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ref
	for rows.Next() {
		var r ref
		if err := rows.Scan(&r.source, &r.id, &r.score); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// load reads the row a search hit points at. ok is false when the row is gone.
func (s *Service) load(ctx context.Context, r ref) (hit, bool, error) {
	h := hit{source: r.source, id: r.id, score: r.score}
	var err error
	switch r.source {
	case SourceMemory:
		h.author = "memory"
		err = s.db.QueryRowContext(ctx, `SELECT kind, text, created_at FROM memories WHERE id = ?`, r.id).Scan(&h.kind, &h.text, &h.at)
	case SourceKnownIssue:
		var k KnownIssue
		k, err = scanKnownIssue(s.db.QueryRowContext(ctx, `SELECT `+knownIssueCols+` FROM known_issues WHERE id = ?`, r.id))
		h.text, h.author, h.at = k.String(), k.CreatedBy, k.CreatedAt
	case SourceFeatureMap:
		var f FeatureFlow
		f, err = s.featureFlow(ctx, r.id)
		h.text, h.author, h.at = f.String(), f.Source, f.UpdatedAt
	default:
		return h, false, nil
	}
	if errors.Is(err, sql.ErrNoRows) {
		return h, false, nil
	}
	return h, err == nil, err
}

func placeholders(n int) string {
	return strings.TrimSuffix(strings.Repeat("?,", n), ",")
}

// maxQueryTerms bounds the words of one FTS query.
const maxQueryTerms = 24

// ftsQuery turns free text into an FTS5 query: every word quoted (so FTS syntax in the text is never interpreted)
// and joined with OR, so BM25 ranks rows that share more words higher. "" when the text has no word.
func ftsQuery(text string) string {
	seen := map[string]bool{}
	var terms []string
	for _, w := range strings.FieldsFunc(strings.ToLower(text), func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) }) {
		if seen[w] {
			continue
		}
		seen[w] = true
		terms = append(terms, `"`+w+`"`)
		if len(terms) == maxQueryTerms {
			break
		}
	}
	return strings.Join(terms, " OR ")
}

// KnownIssue is one confirmed failure cause.
type KnownIssue struct {
	ID        int64  `json:"id"`
	Symptom   string `json:"symptom"`
	Cause     string `json:"cause"`
	Fix       string `json:"fix"`
	Category  string `json:"category"`
	App       string `json:"app,omitempty"`
	Flow      string `json:"flow,omitempty"`
	Platform  string `json:"platform,omitempty"`
	CreatedBy string `json:"createdBy"`
	CreatedAt int64  `json:"createdAt"`
	Hits      int    `json:"hits"`
}

func (k KnownIssue) String() string {
	where := strings.TrimSpace(strings.Join([]string{k.App, k.Flow, k.Platform}, " "))
	s := fmt.Sprintf("Lỗi đã biết: %s. Nguyên nhân: %s. Cách sửa: %s. Loại: %s.", k.Symptom, orDash(k.Cause), orDash(k.Fix), orDash(k.Category))
	if where != "" {
		s += " (" + where + ")"
	}
	return s
}

func orDash(s string) string {
	if strings.TrimSpace(s) == "" {
		return "-"
	}
	return s
}

const knownIssueCols = `id, symptom, cause, fix, category, app, flow, platform, created_by, created_at, hits`

func scanKnownIssue(sc interface{ Scan(...any) error }) (KnownIssue, error) {
	var k KnownIssue
	err := sc.Scan(&k.ID, &k.Symptom, &k.Cause, &k.Fix, &k.Category, &k.App, &k.Flow, &k.Platform, &k.CreatedBy, &k.CreatedAt, &k.Hits)
	return k, err
}

// KnownIssues returns the known issues matching the query, best first, and counts a hit on each.
func (s *Service) KnownIssues(ctx context.Context, query string, limit int) ([]KnownIssue, error) {
	out := []KnownIssue{}
	match := ftsQuery(query)
	if match == "" {
		return out, nil
	}
	refs, err := s.match(ctx, match, []string{SourceKnownIssue}, nil, "", "", limit)
	if err != nil {
		return nil, err
	}
	for _, r := range refs {
		res, err := s.db.ExecContext(ctx, `UPDATE known_issues SET hits = hits + 1 WHERE id = ?`, r.id)
		if err != nil {
			return nil, err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			continue
		}
		k, err := scanKnownIssue(s.db.QueryRowContext(ctx, `SELECT `+knownIssueCols+` FROM known_issues WHERE id = ?`, r.id))
		if err != nil {
			return nil, err
		}
		out = append(out, k)
	}
	return out, nil
}

// FeatureFlow links a feature to a flow that tests it.
type FeatureFlow struct {
	Feature   string `json:"feature"`
	App       string `json:"app"`
	Flow      string `json:"flow"`
	Note      string `json:"note,omitempty"`
	Source    string `json:"source"` // manual | planner
	UpdatedAt int64  `json:"updatedAt"`
}

func (f FeatureFlow) String() string {
	s := fmt.Sprintf("Tính năng %q được kiểm bởi flow %s/%s", f.Feature, f.App, f.Flow)
	if f.Note != "" {
		s += ": " + f.Note
	}
	return s
}

const featureCols = `feature, app, flow, note, source, updated_at`

func scanFeatureFlow(sc interface{ Scan(...any) error }) (FeatureFlow, error) {
	var f FeatureFlow
	err := sc.Scan(&f.Feature, &f.App, &f.Flow, &f.Note, &f.Source, &f.UpdatedAt)
	return f, err
}

// featureFlow reads a link by its index ref "feature|app|flow".
func (s *Service) featureFlow(ctx context.Context, id string) (FeatureFlow, error) {
	return scanFeatureFlow(s.db.QueryRowContext(ctx, `SELECT `+featureCols+` FROM feature_flow_map
  WHERE feature || '|' || app || '|' || flow = ?`, id))
}

// maxFeatureRows bounds a feature map listing.
const maxFeatureRows = 100

// FeatureFlows lists the feature-to-flow links: all of them (up to 100), or those whose feature name matches feature,
// best first.
func (s *Service) FeatureFlows(ctx context.Context, feature string) ([]FeatureFlow, error) {
	out := []FeatureFlow{}
	match := ftsQuery(feature)
	if match == "" {
		rows, err := s.db.QueryContext(ctx, `SELECT `+featureCols+` FROM feature_flow_map ORDER BY feature, app, flow LIMIT ?`, maxFeatureRows)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		for rows.Next() {
			f, err := scanFeatureFlow(rows)
			if err != nil {
				return nil, err
			}
			out = append(out, f)
		}
		return out, rows.Err()
	}
	refs, err := s.match(ctx, "{title} : ("+match+")", []string{SourceFeatureMap}, nil, "", "", maxFeatureRows)
	if err != nil {
		return nil, err
	}
	for _, r := range refs {
		f, err := s.featureFlow(ctx, r.id)
		if errors.Is(err, sql.ErrNoRows) {
			continue
		}
		if err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, nil
}

// Note is a write request: a memory, a known issue or a feature-to-flow link. Kind picks which.
type Note struct {
	Kind string `json:"kind"`           // fact | fix | preference | known_issue | feature_map
	Text string `json:"text,omitempty"` // the fact; for a known issue the symptom when Symptom is empty

	// known_issue
	Symptom  string `json:"symptom,omitempty"`
	Cause    string `json:"cause,omitempty"`
	Fix      string `json:"fix,omitempty"`
	Category string `json:"category,omitempty"`
	// known_issue and feature_map
	App      string `json:"app,omitempty"`
	Flow     string `json:"flow,omitempty"`
	Platform string `json:"platform,omitempty"`
	// feature_map
	Feature string `json:"feature,omitempty"`

	AppName string `json:"appName,omitempty"`
	UserID  string `json:"userId,omitempty"`
	Author  string `json:"author,omitempty"`
}

// String is the note in words, for an approval list.
func (n Note) String() string {
	switch n.Kind {
	case SourceKnownIssue:
		symptom := n.Symptom
		if symptom == "" {
			symptom = n.Text
		}
		return KnownIssue{Symptom: symptom, Cause: n.Cause, Fix: n.Fix, Category: n.Category, App: n.App, Flow: n.Flow, Platform: n.Platform}.String()
	case SourceFeatureMap:
		return FeatureFlow{Feature: n.Feature, App: n.App, Flow: n.Flow, Note: n.Text}.String()
	}
	return n.Kind + ": " + n.Text
}

// Remember kinds.
var RememberKinds = []string{KindFact, KindFix, KindPreference, SourceKnownIssue, SourceFeatureMap}

// ErrRejected marks a write refused because its text may hold a secret or breaks a limit. The message says which
// rule, never the text.
var ErrRejected = errors.New("không lưu vào trí nhớ")

func rejected(reason string) error { return fmt.Errorf("%w: %s", ErrRejected, reason) }

// Remember validates and stores a note. Every text field is at most MaxText characters and is refused when it
// contains a known secret value, a "NAME=value" for a Keychain secret name, or something shaped like a credential.
// It returns the id of the stored row.
func (s *Service) Remember(ctx context.Context, n Note) (string, error) {
	if err := s.Check(&n); err != nil {
		return "", err
	}
	at := s.now().UnixMilli()
	switch n.Kind {
	case KindFact, KindFix, KindPreference:
		meta := map[string]any{}
		for k, v := range map[string]string{"app": n.App, "flow": n.Flow, "platform": n.Platform, "author": n.Author} {
			if v != "" {
				meta[k] = v
			}
		}
		raw, err := json.Marshal(meta)
		if err != nil {
			return "", err
		}
		id := newID()
		_, err = s.db.ExecContext(ctx, `INSERT INTO memories (id, user_id, app_name, kind, text, metadata_json, created_at) VALUES (?,?,?,?,?,?,?)`,
			id, n.UserID, n.AppName, n.Kind, n.Text, string(raw), at)
		return id, err
	case SourceKnownIssue:
		res, err := s.db.ExecContext(ctx, `INSERT INTO known_issues (symptom, cause, fix, category, app, flow, platform, created_by, created_at)
  VALUES (?,?,?,?,?,?,?,?,?)`, n.Symptom, n.Cause, n.Fix, n.Category, n.App, n.Flow, n.Platform, n.Author, at)
		if err != nil {
			return "", err
		}
		id, err := res.LastInsertId()
		return fmt.Sprint(id), err
	}
	// feature_map (Check allows nothing else)
	source := "manual"
	if n.Author == "planner" {
		source = "planner"
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO feature_flow_map (feature, app, flow, note, source, updated_at) VALUES (?,?,?,?,?,?)
  ON CONFLICT(feature, app, flow) DO UPDATE SET note = excluded.note, source = excluded.source, updated_at = excluded.updated_at`,
		n.Feature, n.App, n.Flow, n.Text, source, at)
	return n.Feature + "|" + n.App + "|" + n.Flow, err
}

// Check validates a note as Remember does, without storing it, and normalizes it (trimmed fields; a known issue
// without a symptom takes the fact as its symptom). Errors wrap ErrRejected.
func (s *Service) Check(n *Note) error {
	n.Kind = strings.TrimSpace(n.Kind)
	fields := []struct {
		name string
		p    *string
	}{{"fact", &n.Text}, {"symptom", &n.Symptom}, {"cause", &n.Cause}, {"fix", &n.Fix}, {"category", &n.Category},
		{"app", &n.App}, {"flow", &n.Flow}, {"platform", &n.Platform}, {"feature", &n.Feature}}
	for _, f := range fields {
		*f.p = strings.TrimSpace(*f.p)
		if len([]rune(*f.p)) > MaxText {
			return rejected(fmt.Sprintf("%s dài quá %d ký tự", f.name, MaxText))
		}
		if err := s.checkSecret(f.name, *f.p); err != nil {
			return err
		}
	}
	switch n.Kind {
	case KindFact, KindFix, KindPreference:
		if n.Text == "" {
			return rejected("fact trống")
		}
	case SourceKnownIssue:
		if n.Symptom == "" {
			n.Symptom = n.Text
		}
		if n.Symptom == "" || (n.Cause == "" && n.Fix == "") {
			return rejected("lỗi đã biết cần triệu chứng và nguyên nhân hoặc cách sửa")
		}
		if n.Category != "" && !validCategory(n.Category) {
			return rejected("category phải là app, selector, data hoặc environment")
		}
	case SourceFeatureMap:
		if n.Feature == "" || n.App == "" || n.Flow == "" {
			return rejected("liên kết tính năng cần feature, app và flow")
		}
	default:
		return rejected("kind phải là một trong " + strings.Join(RememberKinds, ", "))
	}
	return nil
}

func validCategory(c string) bool {
	switch c {
	case "app", "selector", "data", "environment":
		return true
	}
	return false
}

// secretShapes are texts that look like credentials whatever the secret store holds.
var secretShapes = []*regexp.Regexp{
	regexp.MustCompile(`(?i)\b(password|passwd|pwd|passcode|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|otp|mật\s*khẩu)\s*[:=]\s*[^\s*$]\S*`),
	regexp.MustCompile(`-----BEGIN [A-Z ]*PRIVATE KEY-----`),
	regexp.MustCompile(`\bsk-[A-Za-z0-9_-]{16,}`),
	regexp.MustCompile(`\bAKIA[0-9A-Z]{16}\b`),
	regexp.MustCompile(`\bgh[pousr]_[A-Za-z0-9]{20,}`),
	regexp.MustCompile(`\bxox[abprs]-[A-Za-z0-9-]{10,}`),
	regexp.MustCompile(`(?i)\bbearer\s+[A-Za-z0-9._~+/=-]{16,}`),
	regexp.MustCompile(`\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`),
}

// checkSecret refuses a text that holds a stored secret value (the redactor changes it), assigns a value to a
// Keychain secret name ("PASSWORD=..."; a reference like ${PASSWORD} or a redacted *** is fine), or looks like a
// credential.
func (s *Service) checkSecret(field, text string) error {
	if text == "" {
		return nil
	}
	if s.redact(text) != text {
		return rejected(field + " chứa giá trị bí mật")
	}
	if s.opts.SecretNames != nil {
		for _, name := range s.opts.SecretNames() {
			if strings.TrimSpace(name) == "" {
				continue
			}
			re, err := regexp.Compile(`(?i)\b` + regexp.QuoteMeta(name) + `\s*[:=]\s*[^\s*$]`)
			if err != nil {
				continue
			}
			if re.MatchString(text) {
				return rejected(field + " gán giá trị cho biến bí mật " + name)
			}
		}
	}
	for _, re := range secretShapes {
		if re.MatchString(text) {
			return rejected(field + " có dạng mật khẩu, token hoặc khoá")
		}
	}
	return nil
}
