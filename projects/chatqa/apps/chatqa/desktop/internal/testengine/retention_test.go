package testengine

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"deskcore/apperr"
)

func TestPruneWithFakeClockKeepsNonRunDirs(t *testing.T) {
	e, _ := newTestEngine(t)
	now := time.Date(2026, 11, 18, 12, 0, 0, 0, time.Local)
	e.now = func() time.Time { return now }
	old, recent := now.AddDate(0, 0, -100), now.AddDate(0, 0, -10)

	mkdir := func(name string) string {
		p := filepath.Join(e.RunsDir, name)
		if err := os.MkdirAll(p, 0o755); err != nil {
			t.Fatal(err)
		}
		return p
	}
	oldID, oldDup, recentID := old.Format("060102-150405"), old.Format("060102-150405")+"-1", recent.Format("060102-150405")
	for _, id := range []string{oldID, oldDup, recentID} {
		mkdir(id)
	}
	keep := []string{mkdir("notes"), mkdir(old.Format("060102") + "-backup"), mkdir("2025-01-01")}
	file := filepath.Join(e.RunsDir, old.Format("060102-150405")+"-2")
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil { // file đúng dạng tên nhưng không phải thư mục
		t.Fatal(err)
	}

	for _, r := range []RunRecord{
		{ID: oldID, App: "demo", StartedAt: old, FinishedAt: old, OutDir: filepath.Join(e.RunsDir, oldID)},
		{ID: recentID, App: "demo", StartedAt: recent, FinishedAt: recent, OutDir: filepath.Join(e.RunsDir, recentID)},
	} {
		if err := e.Metrics.Save(r, []FlowRun{{DeviceID: "emu-1", Flow: "a.yaml", Steps: []StepRun{{Desc: "tapOn"}}}}); err != nil {
			t.Fatal(err)
		}
	}
	for _, at := range []time.Time{old, recent} {
		_ = e.Metrics.RecordLLM(LedgerEntry{At: at, Purpose: "repair", BudgetLeftVnd: -1})
		_ = e.Metrics.RecordToolCall(ToolCall{At: at, Source: "ui", Tool: "t"})
		_ = e.Metrics.RecordUsage(at, "page_view", nil, nil)
	}

	if _, err := e.Prune(3); apperr.CodeOf(err) != apperr.CodeInvalid {
		t.Fatalf("days < 7: %v", err)
	}
	res, err := e.Prune(90)
	if err != nil {
		t.Fatal(err)
	}
	if res != (PruneResult{Runs: 1, LLMCalls: 1, ToolCalls: 1, UsageEvents: 1, Dirs: 2}) {
		t.Fatalf("prune = %+v", res)
	}
	for _, id := range []string{oldID, oldDup} {
		if _, err := os.Stat(filepath.Join(e.RunsDir, id)); !os.IsNotExist(err) {
			t.Errorf("%s vẫn còn", id)
		}
	}
	for _, p := range append(keep, filepath.Join(e.RunsDir, recentID), file) {
		if _, err := os.Stat(p); err != nil {
			t.Errorf("%s bị xoá nhầm: %v", p, err)
		}
	}
	runs, _ := e.Metrics.Runs(10)
	if len(runs) != 1 || runs[0].ID != recentID {
		t.Fatalf("runs = %+v", runs)
	}
	var steps int
	if err := e.Metrics.db.QueryRow(`SELECT COUNT(*) FROM steps`).Scan(&steps); err != nil || steps != 1 {
		t.Fatalf("bước của lượt cũ không bị xoá theo: %d %v", steps, err)
	}
}

// Evidence nhóm đã tải về: xoá theo mtime thư mục lượt với cùng mốc giữ, thư mục máy trống xoá theo; symlink, tệp
// thường và lượt mới giữ nguyên.
func TestPruneTeamRunsByDirMtime(t *testing.T) {
	e, _ := newTestEngine(t)
	now := time.Date(2026, 11, 18, 12, 0, 0, 0, time.Local)
	e.now = func() time.Time { return now }
	root := filepath.Join(filepath.Dir(e.RunsDir), TeamRunsDirName)
	old, recent := now.AddDate(0, 0, -40), now.AddDate(0, 0, -5)
	mk := func(rel string, at time.Time) string {
		p := filepath.Join(root, rel)
		if err := os.MkdirAll(p, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(p, "evidence.html"), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(p, at, at); err != nil {
			t.Fatal(err)
		}
		return p
	}
	oldOnly := mk("may-a/261001-090000", old)
	oldB := mk("may-b/261001-090000", old)
	partial := mk("may-b/.261002-090000.part-1", old)
	keepB := mk("may-b/261113-090000", recent)
	outside := t.TempDir()
	if err := os.Chtimes(outside, old, old); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "may-b", "261001-100000")); err != nil {
		t.Fatal(err)
	}
	stray := filepath.Join(root, "notes.txt")
	if err := os.WriteFile(stray, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	res, err := e.Prune(30)
	if err != nil {
		t.Fatal(err)
	}
	if res.TeamRuns != 3 {
		t.Fatalf("teamRuns = %d, muốn 3 (%+v)", res.TeamRuns, res)
	}
	for _, p := range []string{oldOnly, oldB, partial, filepath.Dir(oldOnly)} {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Errorf("%s vẫn còn", p)
		}
	}
	for _, p := range []string{keepB, outside, stray, filepath.Join(root, "may-b", "261001-100000")} {
		if _, err := os.Lstat(p); err != nil {
			t.Errorf("%s bị xoá nhầm: %v", p, err)
		}
	}
	// Không có thư mục team-runs: không lỗi.
	if err := os.RemoveAll(root); err != nil {
		t.Fatal(err)
	}
	if _, err := e.Prune(30); err != nil {
		t.Fatal(err)
	}
}

func TestRetentionSetting(t *testing.T) {
	m := newTestMetrics(t)
	if d, err := m.RetentionDays(); err != nil || d != DefaultRetentionDays {
		t.Fatalf("mặc định = %d %v", d, err)
	}
	for _, bad := range []int{0, 6, 3651} {
		if err := m.SetRetentionDays(bad); apperr.CodeOf(err) != apperr.CodeInvalid {
			t.Errorf("%d: %v", bad, err)
		}
	}
	if err := m.SetRetentionDays(30); err != nil {
		t.Fatal(err)
	}
	if d, _ := m.RetentionDays(); d != 30 {
		t.Fatalf("đọc lại = %d", d)
	}
}
