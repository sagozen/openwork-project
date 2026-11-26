package memory

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	adkmemory "google.golang.org/adk/v2/memory"
	"google.golang.org/adk/v2/session"
	"google.golang.org/genai"

	"chatqa/internal/agentx/store"
)

// openDB opens (or reopens) a migrated agent.db at path.
func openDB(t *testing.T, path string) *sql.DB {
	t.Helper()
	db, _, err := store.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Migrate(sqlDB); err != nil {
		t.Fatal(err)
	}
	return sqlDB
}

func newService(t *testing.T, opts Options) (*Service, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "agent.db")
	db := openDB(t, path)
	t.Cleanup(func() { db.Close() })
	s, err := New(db, opts)
	if err != nil {
		t.Fatal(err)
	}
	return s, path
}

func remember(t *testing.T, s *Service, n Note) string {
	t.Helper()
	if n.AppName == "" {
		n.AppName = "chatqa"
	}
	if n.UserID == "" {
		n.UserID = "u1"
	}
	id, err := s.Remember(context.Background(), n)
	if err != nil {
		t.Fatalf("remember %+v: %v", n, err)
	}
	return id
}

func search(t *testing.T, s *Service, user, query string) []adkmemory.Entry {
	t.Helper()
	resp, err := s.SearchMemory(context.Background(), &adkmemory.SearchRequest{AppName: "chatqa", UserID: user, Query: query})
	if err != nil {
		t.Fatal(err)
	}
	return resp.Memories
}

func entryText(e adkmemory.Entry) string {
	if e.Content == nil || len(e.Content.Parts) == 0 {
		return ""
	}
	return e.Content.Parts[0].Text
}

func TestSQLiteHasFTS5(t *testing.T) {
	s, _ := newService(t, Options{})
	if _, err := s.db.Exec(`CREATE VIRTUAL TABLE probe USING fts5(x)`); err != nil {
		t.Fatalf("modernc.org/sqlite must ship FTS5: %v", err)
	}
}

func TestSearchRanksBestMatchFirstAcrossSources(t *testing.T) {
	s, _ := newService(t, Options{})
	remember(t, s, Note{Kind: KindFact, Text: "Flow thanh toán android chạy chậm vào buổi sáng"})
	best := remember(t, s, Note{Kind: KindFix, Text: "Flow login trên iOS hay lỗi vì bàn phím che nút Đăng nhập; thêm hideKeyboard"})
	remember(t, s, Note{Kind: KindFact, Text: "Máy iOS sim-1 cần sạc"})
	remember(t, s, Note{Kind: SourceKnownIssue, Symptom: "Không thấy nút Thanh toán", Cause: "nút bị đổi tên", Fix: "sửa selector", Category: "selector",
		App: "mexpress", Flow: "02_cart.yaml", Platform: "android", Author: "triage"})
	remember(t, s, Note{Kind: SourceFeatureMap, Feature: "Giỏ hàng", App: "mexpress", Flow: "02_cart.yaml", Text: "thêm và thanh toán"})
	remember(t, s, Note{Kind: KindFact, Text: "Flow login iOS lỗi của người khác", UserID: "u2"})

	// Diacritics are ignored: "loi" finds "lỗi", "dang nhap" finds "Đăng nhập".
	got := search(t, s, "u1", "login ios loi dang nhap")
	if len(got) == 0 || got[0].CustomMetadata["id"] != best || got[0].CustomMetadata["source"] != SourceMemory || got[0].CustomMetadata["kind"] != KindFix {
		t.Fatalf("best hit = %+v", got)
	}
	for _, e := range got {
		if strings.Contains(entryText(e), "người khác") {
			t.Fatal("another user's memory must not be returned")
		}
	}

	got = search(t, s, "u1", "Không thấy nút Thanh toán")
	if len(got) == 0 || got[0].CustomMetadata["source"] != SourceKnownIssue || !strings.Contains(entryText(got[0]), "sửa selector") {
		t.Fatalf("known issue hit = %+v", got)
	}
	got = search(t, s, "u1", "giỏ hàng")
	if len(got) == 0 || got[0].CustomMetadata["source"] != SourceFeatureMap || got[0].CustomMetadata["id"] != "Giỏ hàng|mexpress|02_cart.yaml" {
		t.Fatalf("feature hit = %+v", got)
	}
	// FTS syntax in the query is never interpreted.
	if got := search(t, s, "u1", `login" OR NEAR(* ) -`); len(got) == 0 {
		t.Fatal("a query with FTS syntax must still search its words")
	}
	if got := search(t, s, "u1", "!!!"); len(got) != 0 {
		t.Fatalf("a query without words finds nothing: %+v", got)
	}
}

func TestRememberRejectsSecretsAndLongText(t *testing.T) {
	s, _ := newService(t, Options{
		Redact:      func(x string) string { return strings.ReplaceAll(x, "hunter2-real", "***") },
		SecretNames: func() []string { return []string{"PASSWORD", "MEXPRESS_APP_ID"} },
	})
	bad := []Note{
		{Kind: KindFact, Text: "mật khẩu test là hunter2-real"},                       // a stored secret value
		{Kind: KindFact, Text: "đăng nhập bằng PASSWORD=abc123"},                      // a Keychain name with a value
		{Kind: KindFact, Text: "mexpress_app_id: 998877"},                             // names match without case
		{Kind: KindFact, Text: "token: sk-abcdefghijklmnopqrstuvwxyz"},                // credential shape
		{Kind: KindFact, Text: "Authorization: Bearer abcdefghijklmnop.qrstuvwxyz12"}, // bearer token
		{Kind: SourceKnownIssue, Symptom: "login lỗi", Cause: "password=hunter3"},     // any field is checked
		{Kind: KindFact, Text: strings.Repeat("a", MaxText+1)},
		{Kind: "secret_dump", Text: "x"},
		{Kind: SourceKnownIssue, Symptom: "chỉ có triệu chứng"},
		{Kind: SourceFeatureMap, Feature: "Giỏ hàng"},
	}
	for _, n := range bad {
		n.AppName, n.UserID = "chatqa", "u1"
		_, err := s.Remember(context.Background(), n)
		if !errors.Is(err, ErrRejected) {
			t.Fatalf("%+v: err = %v, want ErrRejected", n, err)
		}
		if strings.Contains(err.Error(), "hunter") || strings.Contains(err.Error(), "abc123") {
			t.Fatalf("the refusal must not echo the secret: %v", err)
		}
	}
	var n int
	if err := s.db.QueryRow(`SELECT (SELECT COUNT(*) FROM memories) + (SELECT COUNT(*) FROM known_issues) + (SELECT COUNT(*) FROM feature_flow_map)`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("rows stored after refusals = %d %v", n, err)
	}
	// References and redacted values are fine.
	remember(t, s, Note{Kind: KindFact, Text: "flow login đọc PASSWORD=${PASSWORD} và USER: *** từ kho bí mật"})
	remember(t, s, Note{Kind: KindFact, Text: strings.Repeat("a", MaxText)})
}

func TestMemorySurvivesReopen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.db")
	db := openDB(t, path)
	s, err := New(db, Options{})
	if err != nil {
		t.Fatal(err)
	}
	remember(t, s, Note{Kind: KindFact, Text: "Bản build 5.2 đổi màn hình đăng nhập"})
	remember(t, s, Note{Kind: SourceKnownIssue, Symptom: "Timeout khi mở app", Fix: "khởi động lại simulator", Category: "environment"})
	db.Close()

	db = openDB(t, path) // migrating again is a no-op
	defer db.Close()
	s, err = New(db, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if got := search(t, s, "u1", "build đăng nhập"); len(got) != 1 || !strings.Contains(entryText(got[0]), "5.2") {
		t.Fatalf("after reopen = %+v", got)
	}
	issues, err := s.KnownIssues(context.Background(), "timeout mở app", 5)
	if err != nil || len(issues) != 1 || issues[0].Hits != 1 {
		t.Fatalf("known issues = %+v %v", issues, err)
	}
	if issues, _ := s.KnownIssues(context.Background(), "timeout", 5); issues[0].Hits != 2 {
		t.Fatalf("hits must count each lookup: %+v", issues)
	}
}

func TestFeatureFlowsListAndFilter(t *testing.T) {
	s, _ := newService(t, Options{})
	remember(t, s, Note{Kind: SourceFeatureMap, Feature: "Đăng nhập", App: "mexpress", Flow: "01_login.yaml"})
	remember(t, s, Note{Kind: SourceFeatureMap, Feature: "Giỏ hàng", App: "mexpress", Flow: "02_cart.yaml", Author: "planner"})
	remember(t, s, Note{Kind: SourceFeatureMap, Feature: "Giỏ hàng", App: "mexpress", Flow: "02_cart.yaml", Text: "ghi chú mới"}) // upsert

	all, err := s.FeatureFlows(context.Background(), "")
	if err != nil || len(all) != 2 {
		t.Fatalf("all = %+v %v", all, err)
	}
	got, err := s.FeatureFlows(context.Background(), "gio hang")
	if err != nil || len(got) != 1 || got[0].Flow != "02_cart.yaml" || got[0].Note != "ghi chú mới" || got[0].Source != "manual" {
		t.Fatalf("filtered = %+v %v", got, err)
	}
	// The filter looks at the feature only, not at flow names.
	if got, _ := s.FeatureFlows(context.Background(), "mexpress"); len(got) != 0 {
		t.Fatalf("feature filter matched another column: %+v", got)
	}
}

func newSession(t *testing.T, events ...*session.Event) session.Session {
	t.Helper()
	svc := session.InMemoryService()
	ctx := context.Background()
	created, err := svc.Create(ctx, &session.CreateRequest{AppName: "chatqa", UserID: "u1", SessionID: "s1"})
	if err != nil {
		t.Fatal(err)
	}
	for _, ev := range events {
		if err := svc.AppendEvent(ctx, created.Session, ev); err != nil {
			t.Fatal(err)
		}
	}
	got, err := svc.Get(ctx, &session.GetRequest{AppName: "chatqa", UserID: "u1", SessionID: "s1"})
	if err != nil {
		t.Fatal(err)
	}
	return got.Session
}

func textEvent(author, text string) *session.Event {
	ev := session.NewEvent(context.Background(), "inv")
	ev.Author = author
	role := genai.RoleModel
	if author == "user" {
		role = genai.RoleUser
	}
	ev.Content = genai.NewContentFromText(text, genai.Role(role))
	return ev
}

func TestAddSessionStoresOneSummaryPerSession(t *testing.T) {
	s, _ := newService(t, Options{Redact: func(x string) string { return strings.ReplaceAll(x, "hunter2-real", "***") }})
	ctx := context.Background()

	// Without a compaction summary the Reporter's text is the summary, redacted.
	sess := newSession(t, textEvent("user", "chạy pipeline abc..def"), textEvent("pipeline", "Bắt đầu"),
		textEvent("reporter", "Báo cáo: giỏ hàng lỗi selector trên android, mật khẩu hunter2-real"), textEvent("pipeline", "Pipeline xong."))
	if err := s.AddSessionToMemory(ctx, sess); err != nil {
		t.Fatal(err)
	}
	got := search(t, s, "u1", "giỏ hàng selector")
	if len(got) != 1 || got[0].CustomMetadata["kind"] != KindSessionSummary || got[0].CustomMetadata["id"] != "session:s1" {
		t.Fatalf("summary = %+v", got)
	}
	if txt := entryText(got[0]); !strings.HasPrefix(txt, "Yêu cầu: chạy pipeline abc..def\n") || strings.Contains(txt, "hunter2") || !strings.Contains(txt, "***") {
		t.Fatalf("summary text = %q", txt)
	}

	// With a compaction summary, that summary wins; adding the session again replaces its row.
	comp := session.NewEvent(ctx, "inv")
	comp.Actions.Compaction = &session.EventCompaction{StartTimestamp: time.Now().Add(-time.Hour), EndTimestamp: time.Now(),
		CompactedContent: genai.NewContentFromText("TÓM TẮT: người dùng hỏi về flow thanh toán", genai.RoleModel)}
	comp.Author = "coordinator"
	sess = newSession(t, textEvent("user", "chào"), comp, textEvent("coordinator", "xin chào"))
	if err := s.AddSessionToMemory(ctx, sess); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM memories WHERE kind = 'session_summary'`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("summaries = %d %v", n, err)
	}
	if got := search(t, s, "u1", "thanh toán"); len(got) != 1 || !strings.Contains(entryText(got[0]), "TÓM TẮT") {
		t.Fatalf("compaction summary = %+v", got)
	}
	if got := search(t, s, "u1", "selector"); len(got) != 0 {
		t.Fatalf("the old summary must be replaced: %+v", got)
	}
	// A session with no agent answer stores nothing.
	if err := s.AddSessionToMemory(ctx, newSession(t, textEvent("user", "alo"))); err != nil {
		t.Fatal(err)
	}
}

func TestAddEventsKeepsEarlierEventsAndIgnoresRepeats(t *testing.T) {
	s, _ := newService(t, Options{})
	ctx := context.Background()
	a, b := textEvent("coordinator", "flow login cần thêm bước chờ"), textEvent("user", "ok")
	req := &adkmemory.AddEventsRequest{AppName: "chatqa", UserID: "u1", SessionID: "s1", Events: []*session.Event{a, b}}
	if err := adkmemory.AddEventsToMemory(ctx, s, req); err != nil {
		t.Fatal(err)
	}
	if err := adkmemory.AddEventsToMemory(ctx, s, req); err != nil {
		t.Fatal(err)
	}
	c := textEvent("coordinator", "flow login đã ổn")
	if err := s.AddEventsToMemory(ctx, &adkmemory.AddEventsRequest{AppName: "chatqa", UserID: "u1", SessionID: "s1", Events: []*session.Event{c}}); err != nil {
		t.Fatal(err)
	}
	if got := search(t, s, "u1", "flow login"); len(got) != 2 {
		t.Fatalf("events = %+v", got)
	}
}
