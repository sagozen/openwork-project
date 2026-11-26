package test

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	cqmod "chatqa/internal/modules"
	"chatqa/internal/testengine"
	"deskcore/apperr"
	"deskcore/modules"
)

// launched ghi lại lệnh mở thư mục/file thay vì bật Finder/Explorer thật.
func launched(e *testengine.Engine) *[][]string {
	var got [][]string
	e.Launch = func(c *exec.Cmd) error {
		got = append(got, c.Args)
		return nil
	}
	return &got
}

func saveRun(t *testing.T, e *testengine.Engine, id, outDir string) {
	t.Helper()
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	if err := e.Metrics.Save(testengine.RunRecord{ID: id, App: "demo", StartedAt: now, FinishedAt: now, OutDir: outDir}, nil); err != nil {
		t.Fatal(err)
	}
}

func resolved(t *testing.T, p string) string {
	t.Helper()
	r, err := filepath.EvalSymlinks(p)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func TestOpenRunFolderAndReport(t *testing.T) {
	e := newEngine(t)
	got := launched(e)
	s := New(&fakeHost{apps: []modules.Code{cqmod.Test}}, e, SyncDeps{})
	id := time.Now().Format("060102-150405")
	dir := filepath.Join(e.RunsDir, id)
	saveRun(t, e, id, dir)

	if err := s.OpenRunFolder(id); err != nil {
		t.Fatal(err)
	}
	if len(*got) != 1 || (*got)[0][len((*got)[0])-1] != resolved(t, dir) {
		t.Fatalf("lệnh mở = %v", *got)
	}
	// Lượt cũ chưa có evidence.html: sinh từ DB rồi mở.
	if err := s.OpenRunReport(id); err != nil {
		t.Fatal(err)
	}
	report := filepath.Join(resolved(t, dir), testengine.ReportHTMLFile)
	if (*got)[1][len((*got)[1])-1] != report {
		t.Fatalf("lệnh mở báo cáo = %v", (*got)[1])
	}
	for _, f := range []string{testengine.ReportHTMLFile, testengine.ReportSummaryFile} {
		if _, err := os.Stat(filepath.Join(dir, f)); err != nil {
			t.Fatalf("thiếu %s: %v", f, err)
		}
	}
	// Lượt có dấu che bí mật hỏng: không sinh báo cáo.
	id2 := time.Now().Add(time.Second).Format("060102-150405")
	dir2 := filepath.Join(e.RunsDir, id2)
	saveRun(t, e, id2, dir2)
	os.WriteFile(filepath.Join(dir2, testengine.RedactionFailedMark), []byte("x"), 0o644)
	if err := s.OpenRunReport(id2); apperr.CodeOf(err) != testengine.CodeRedactionFailed {
		t.Fatalf("lượt che hỏng: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir2, testengine.ReportHTMLFile)); !os.IsNotExist(err) {
		t.Fatal("lượt che hỏng vẫn có evidence.html")
	}

	if err := New(&fakeHost{}, e, SyncDeps{}).OpenRunFolder(id); apperr.CodeOf(err) != apperr.CodeModuleLocked {
		t.Fatalf("app bị khoá: %v", err)
	}
}

func TestOpenRunFolderRejectsBadRuns(t *testing.T) {
	e := newEngine(t)
	got := launched(e)
	s := New(&fakeHost{apps: []modules.Code{cqmod.Test}}, e, SyncDeps{})
	if err := os.MkdirAll(e.RunsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"../../etc", "261118-090000/../..", "", "abc"} {
		if err := s.OpenRunFolder(id); apperr.CodeOf(err) != apperr.CodeInvalid {
			t.Errorf("OpenRunFolder(%q) = %v, muốn invalid", id, err)
		}
	}
	if err := s.OpenRunFolder("261118-090000"); apperr.CodeOf(err) != apperr.CodeNotFound {
		t.Errorf("lượt không có: %v", err)
	}
	// Lượt có OutDir trỏ ra ngoài thư mục runs (DB bị sửa tay) không được mở.
	outside := filepath.Join(t.TempDir(), "x")
	saveRun(t, e, "261118-090001", outside)
	if err := s.OpenRunFolder("261118-090001"); apperr.CodeOf(err) != apperr.CodeInvalid {
		t.Errorf("OutDir ngoài runs: %v", err)
	}
	// Liên kết tượng trưng trong runs trỏ ra ngoài cũng bị chặn.
	link := filepath.Join(e.RunsDir, "261118-090002")
	if err := os.Symlink(outside, link); err != nil {
		t.Fatal(err)
	}
	saveRun(t, e, "261118-090002", link)
	if err := s.OpenRunReport("261118-090002"); apperr.CodeOf(err) != apperr.CodeInvalid {
		t.Errorf("symlink ra ngoài runs: %v", err)
	}
	if len(*got) != 0 {
		t.Fatalf("không được mở gì: %v", *got)
	}
}

func TestRevealFileOnlyInsideExports(t *testing.T) {
	e := newEngine(t)
	got := launched(e)
	s := New(&fakeHost{apps: []modules.Code{cqmod.Test}}, e, SyncDeps{})
	id := time.Now().Format("060102-150405")
	saveRun(t, e, id, filepath.Join(e.RunsDir, id))
	zip, err := s.ExportRun(id)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.RevealFile(zip); err != nil {
		t.Fatal(err)
	}
	want := resolved(t, zip) // macOS: open -R <file>
	if runtime.GOOS != "darwin" && runtime.GOOS != "windows" {
		want = filepath.Dir(want) // Linux: mở thư mục cha
	}
	if args := (*got)[0]; runtime.GOOS != "windows" && args[len(args)-1] != want {
		t.Fatalf("lệnh = %v", args)
	}

	secret := filepath.Join(t.TempDir(), "id_rsa")
	os.WriteFile(secret, []byte("x"), 0o600)
	for _, p := range []string{secret, filepath.Join(e.ExportsDir, "..", "testengine.db"), e.ExportsDir, "chatqa-run.zip",
		filepath.Join(e.ExportsDir, "khong-co.zip"), ""} {
		if err := s.RevealFile(p); err == nil {
			t.Errorf("RevealFile(%q) phải bị từ chối", p)
		}
	}
	if err := s.OpenExportsFolder(); err != nil {
		t.Fatal(err)
	}
	if last := (*got)[len(*got)-1]; last[len(last)-1] != e.ExportsDir {
		t.Fatalf("mở thư mục xuất = %v", last)
	}
	if len(*got) != 2 {
		t.Fatalf("số lệnh mở = %d, muốn 2: %v", len(*got), *got)
	}
}
