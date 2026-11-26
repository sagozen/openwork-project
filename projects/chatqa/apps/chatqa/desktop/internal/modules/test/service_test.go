package test

import (
	"context"
	"path/filepath"
	"slices"
	"testing"

	cqmod "chatqa/internal/modules"
	"chatqa/internal/testengine"
	"deskcore/apperr"
	"deskcore/modules"
	"deskcore/offline"
)

type fakeHost struct {
	apps  []modules.Code
	perms []string // quyền của vai; nil = đủ quyền
}

func (h *fakeHost) Context() context.Context { return context.Background() }
func (h *fakeHost) WorkingActor() (offline.Actor, error) {
	return offline.Actor{UserID: "u1", DeviceID: "D1"}, nil
}
func (h *fakeHost) RequirePerm(perm string) error {
	if h.perms == nil || slices.Contains(h.perms, perm) {
		return nil
	}
	return apperr.New(apperr.CodePermissionDenied, perm)
}
func (h *fakeHost) RequireApp(c modules.Code) error {
	if slices.Contains(h.apps, c) {
		return nil
	}
	return apperr.New(apperr.CodeModuleLocked, string(c))
}

func newEngine(t *testing.T) *testengine.Engine {
	dir := t.TempDir()
	m, err := testengine.OpenMetrics(filepath.Join(dir, "testengine.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { m.Close() })
	return testengine.NewEngine(dir, testengine.NewPool(), m, testengine.NewSecrets(dir, "ChatQASoftware-test"))
}

func TestLockedAppRefusesEverything(t *testing.T) {
	s := New(&fakeHost{}, newEngine(t), SyncDeps{})
	if _, err := s.Flows("demo"); apperr.CodeOf(err) != apperr.CodeModuleLocked {
		t.Fatalf("Flows: %v", err)
	}
	if _, err := s.Run(testengine.RunRequest{App: "demo"}); apperr.CodeOf(err) != apperr.CodeModuleLocked {
		t.Fatalf("Run: %v", err)
	}
}

func TestStaffCanReadButNotWithoutRunPermission(t *testing.T) {
	host := &fakeHost{apps: []modules.Code{cqmod.Test}, perms: []string{}}
	s := New(host, newEngine(t), SyncDeps{})
	if apps, err := s.Apps(); err != nil || len(apps) != 0 {
		t.Fatalf("Apps: %v %v", apps, err)
	}
	if _, err := s.Metrics(testengine.MetricsQuery{}); err != nil {
		t.Fatalf("Metrics: %v", err)
	}
	if _, err := s.Runs(10); err != nil {
		t.Fatalf("Runs: %v", err)
	}
	for name, call := range map[string]func() error{
		"Run":          func() error { _, err := s.Run(testengine.RunRequest{App: "demo"}); return err },
		"StopAll":      func() error { _, err := s.StopAll(); return err },
		"ImportFlows":  func() error { _, err := s.ImportFlows(t.TempDir(), "demo"); return err },
		"SaveFlow":     func() error { _, err := s.SaveFlow("demo", "a.yaml", "x"); return err },
		"Compile":      func() error { _, err := s.Compile(testengine.CompileRequest{}); return err },
		"Repair":       func() error { _, err := s.Repair(testengine.RepairRequest{}); return err },
		"Compare":      func() error { _, err := s.Compare(testengine.CompareRequest{}); return err },
		"ExportSpec":   func() error { _, err := s.ExportSpec("demo", "a.spec.ts", ""); return err },
		"SetSecret":    func() error { return s.SetSecret("PASSWORD", "x") },
		"DeleteSecret": func() error { return s.DeleteSecret("PASSWORD") },
	} {
		if err := call(); apperr.CodeOf(err) != apperr.CodePermissionDenied {
			t.Errorf("%s: err = %v, muốn permission_denied", name, err)
		}
	}
}

func TestMissingEngineReportsUnavailable(t *testing.T) {
	s := New(&fakeHost{apps: []modules.Code{cqmod.Test}}, nil, SyncDeps{})
	if _, err := s.Flows("demo"); apperr.CodeOf(err) != "test_engine_unavailable" {
		t.Fatalf("err = %v", err)
	}
	if _, err := s.Status(); err != nil {
		t.Fatalf("Status vẫn phải trả được khi engine hỏng: %v", err)
	}
}

func TestReportUnknownRun(t *testing.T) {
	s := New(&fakeHost{apps: []modules.Code{cqmod.Test}}, newEngine(t), SyncDeps{})
	if _, err := s.Report("không-có"); apperr.CodeOf(err) != apperr.CodeNotFound {
		t.Fatalf("err = %v", err)
	}
}
