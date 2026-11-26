package test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	cqmod "chatqa/internal/modules"
	"chatqa/internal/testengine"
	"deskcore/apperr"
	"deskcore/modules"
)

func TestTrackRetentionAndJournalReads(t *testing.T) {
	staff := &fakeHost{apps: []modules.Code{cqmod.Test}, perms: []string{modules.PermCQRun}}
	s := New(staff, newEngine(t), SyncDeps{})
	if err := s.Track("page_view", map[string]any{"page": "testing"}); err != nil {
		t.Fatal(err)
	}
	if err := s.Track("Bad Kind", nil); apperr.CodeOf(err) != apperr.CodeInvalid {
		t.Fatalf("kind sai: %v", err)
	}
	evs, err := s.UsageEvents(0)
	if err != nil || len(evs) != 1 || evs[0].Kind != "page_view" {
		t.Fatalf("usage = %+v %v", evs, err)
	}
	if calls, err := s.ToolCalls(5); err != nil || len(calls) != 0 {
		t.Fatalf("tool calls = %+v %v", calls, err)
	}
	if d, err := s.Retention(); err != nil || d != testengine.DefaultRetentionDays {
		t.Fatalf("retention = %d %v", d, err)
	}
	if err := s.SetRetention(30); apperr.CodeOf(err) != apperr.CodePermissionDenied {
		t.Fatalf("staff không có quyền lịch vẫn đổi được số ngày giữ: %v", err)
	}
	if _, err := s.ExportHistory(7); err != nil {
		t.Fatalf("nhân viên chỉ có Kiểm thử phải xuất được để xem báo cáo: %v", err)
	}
	if err := New(&fakeHost{}, newEngine(t), SyncDeps{}).Track("page_view", nil); err == nil {
		t.Fatal("app bị khoá vẫn ghi được")
	}
}

func TestExportWritesIntoExportsDirAndStepShotGuards(t *testing.T) {
	e := newEngine(t)
	s := New(&fakeHost{apps: []modules.Code{cqmod.Test}}, e, SyncDeps{})
	if err := s.SetRetention(45); err != nil {
		t.Fatal(err)
	}
	if d, _ := s.Retention(); d != 45 {
		t.Fatalf("retention = %d", d)
	}
	id := time.Now().Format("060102-150405")
	out := filepath.Join(e.RunsDir, id)
	if err := os.MkdirAll(out, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := e.Metrics.Save(testengine.RunRecord{ID: id, App: "demo", StartedAt: time.Now(), FinishedAt: time.Now(), OutDir: out}, nil); err != nil {
		t.Fatal(err)
	}
	path, err := s.ExportRun(id)
	if err != nil || !strings.HasPrefix(path, e.ExportsDir) {
		t.Fatalf("ExportRun = %q %v", path, err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatal(err)
	}
	if filepath.Dir(path) != e.ExportsDir || filepath.Base(path) != "chatqa-run-"+id+".zip" {
		t.Fatalf("gói lượt phải nằm thẳng trong thư mục xuất: %q", path)
	}
	hist, err := s.ExportHistory(7)
	if err != nil || filepath.Dir(hist) != e.ExportsDir || !strings.HasSuffix(hist, ".json") {
		t.Fatalf("ExportHistory = %q %v", hist, err)
	}
	if _, err := os.Stat(hist); err != nil {
		t.Fatal(err)
	}
	for _, bad := range [][2]string{{"../x", "a.png"}, {id, "../../secrets.bin.png"}, {id, "/etc/x.png"}} {
		if _, err := s.StepShot(bad[0], bad[1]); err == nil {
			t.Errorf("StepShot(%q, %q) phải bị từ chối", bad[0], bad[1])
		}
	}
	if _, err := s.ExportRun("../../etc"); apperr.CodeOf(err) != apperr.CodeInvalid {
		t.Fatalf("mã lượt sai: %v", err)
	}
}
