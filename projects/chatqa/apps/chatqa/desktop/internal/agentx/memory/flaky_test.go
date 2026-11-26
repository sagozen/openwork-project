package memory

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"chatqa/internal/testengine"
)

// result is one flow result of the fixture testengine.db.
type result struct {
	run      string
	app      string
	ago      time.Duration
	flow     string
	platform string
	passed   bool
	class    string
	err      string
}

// writeTestDB creates a testengine.db with the given flow results, through the engine's own schema and Save.
func writeTestDB(t *testing.T, path string, now time.Time, results []result) {
	t.Helper()
	m, err := testengine.OpenMetrics(path)
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	byRun := map[string][]testengine.FlowRun{}
	runOf := map[string]result{}
	var order []string
	for _, r := range results {
		if _, ok := runOf[r.run]; !ok {
			order = append(order, r.run)
			runOf[r.run] = r
		}
		byRun[r.run] = append(byRun[r.run], testengine.FlowRun{DeviceID: "dev-" + r.platform, Platform: r.platform, Driver: "maestro",
			Flow: r.flow, Passed: r.passed, FailureClass: r.class, Error: r.err})
	}
	for _, id := range order {
		r := runOf[id]
		at := now.Add(-r.ago)
		if err := m.Save(testengine.RunRecord{ID: id, App: r.app, StartedAt: at, FinishedAt: at.Add(time.Minute), Devices: 1, Repeat: 1}, byRun[id]); err != nil {
			t.Fatal(err)
		}
	}
}

func TestRefreshFlakyFromFlowRuns(t *testing.T) {
	now := time.Now()
	testDB := filepath.Join(t.TempDir(), "testengine.db")
	writeTestDB(t, testDB, now, []result{
		{run: "old", app: "mexpress", ago: 40 * 24 * time.Hour, flow: "01_login.yaml", platform: "ios", class: "timeout", err: "quá hạn"}, // outside the window
		{run: "r1", app: "mexpress", ago: 3 * 24 * time.Hour, flow: "01_login.yaml", platform: "ios", class: "element_not_found", err: "không thấy nút Đăng nhập, PASSWORD hunter2-real"},
		{run: "r1", app: "mexpress", ago: 3 * 24 * time.Hour, flow: "01_login.yaml", platform: "android", passed: true},
		{run: "r2", app: "mexpress", ago: 3*24*time.Hour - 10*time.Minute, flow: "01_login.yaml", platform: "ios", passed: true}, // re-run passed: flaky
		{run: "r3", app: "mexpress", ago: 2 * 24 * time.Hour, flow: "01_login.yaml", platform: "ios", class: "element_not_found", err: "không thấy nút"},
		{run: "r3", app: "mexpress", ago: 2 * 24 * time.Hour, flow: "01_login.yaml", platform: "ios", class: "timeout", err: "quá hạn"},
		{run: "r4", app: "mexpress", ago: 24 * time.Hour, flow: "01_login.yaml", platform: "ios", passed: true}, // a day later: a fix, not flaky
		{run: "r5", app: "mexpress", ago: time.Hour, flow: "02_order/.candidate-01_create.yaml", platform: "android", class: "assertion", err: "sai tổng"},
	})
	before, err := os.ReadFile(testDB)
	if err != nil {
		t.Fatal(err)
	}

	s, _ := newService(t, Options{TestDB: testDB, Now: func() time.Time { return now },
		Redact: func(x string) string { return strings.ReplaceAll(x, "hunter2-real", "***") }})
	ctx := context.Background()
	if err := s.RefreshFlaky(ctx, FlakyWindow); err != nil {
		t.Fatal(err)
	}
	if err := s.RefreshFlaky(ctx, FlakyWindow); err != nil { // idempotent
		t.Fatal(err)
	}
	after, err := os.ReadFile(testDB)
	if err != nil {
		t.Fatal(err)
	}
	if string(before) != string(after) {
		t.Fatal("RefreshFlaky must not write testengine.db")
	}

	top, err := s.TopFlaky(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(top) != 2 {
		t.Fatalf("flaky rows = %+v", top)
	}
	ios := top[0]
	if ios.App != "mexpress" || ios.Flow != "01_login.yaml" || ios.Platform != "ios" || ios.Runs != 5 || ios.Fails != 3 || ios.FlakyPasses != 1 {
		t.Fatalf("ios login = %+v", ios)
	}
	if ios.LastFailAt != now.Add(-2*24*time.Hour).UnixMilli() {
		t.Fatalf("last fail = %d", ios.LastFailAt)
	}
	if len(ios.TopCauses) != 2 || ios.TopCauses[0].Class != "element_not_found" || ios.TopCauses[0].Count != 2 || ios.TopCauses[1].Class != "timeout" {
		t.Fatalf("causes = %+v", ios.TopCauses)
	}
	for _, c := range ios.TopCauses {
		if strings.Contains(c.Example, "hunter2") {
			t.Fatalf("example not redacted: %q", c.Example)
		}
	}
	if top[1].Flow != "02_order/01_create.yaml" || top[1].Fails != 1 {
		t.Fatalf("a candidate run counts for its flow: %+v", top[1])
	}

	// The android row (no failure) exists but is not listed as flaky.
	got, err := s.FlakyFor(ctx, "Flow login sao hay lỗi?")
	if err != nil || len(got) != 2 {
		t.Fatalf("login rows = %+v %v", got, err)
	}
	got, err = s.FlakyFor(ctx, "Flow login iOS sao hay lỗi?")
	if err != nil || len(got) != 1 || got[0].Platform != "ios" {
		t.Fatalf("login ios = %+v %v", got, err)
	}
	if got, _ := s.FlakyFor(ctx, "flow 01_create.yaml"); len(got) != 1 {
		t.Fatalf("by file name = %+v", got)
	}
	if got, _ := s.FlakyFor(ctx, "flow đăng ký"); len(got) != 0 {
		t.Fatalf("no flow named = %+v", got)
	}

	brief := s.Brief(ctx)
	if !strings.Contains(brief, "<memory>") || !strings.Contains(brief, "mexpress/01_login.yaml ios: lỗi 3/5 lượt, 1 lần đạt khi chạy lại") {
		t.Fatalf("brief = %q", brief)
	}
}

func TestRefreshFlakyWithoutTestDBDoesNothing(t *testing.T) {
	s, _ := newService(t, Options{TestDB: filepath.Join(t.TempDir(), "missing.db")})
	if err := s.RefreshFlaky(context.Background(), FlakyWindow); err != nil {
		t.Fatal(err)
	}
	if b := s.Brief(context.Background()); b != "" {
		t.Fatalf("empty memory has no brief: %q", b)
	}
}

func TestFlowShortName(t *testing.T) {
	for in, want := range map[string]string{"01_login.yaml": "login", "02_order/003_dong_tai.yaml": "dong_tai", "checkout.spec.ts": "checkout", "2fa.yaml": "2fa"} {
		if got := FlowShortName(in); got != want {
			t.Fatalf("%s -> %q, want %q", in, got, want)
		}
	}
}
