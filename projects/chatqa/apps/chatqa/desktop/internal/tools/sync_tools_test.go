package tools

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	cqtest "chatqa/internal/modules/test"
	"chatqa/internal/teamsync"
	"chatqa/internal/testengine"
	"deskcore/apperr"
	"deskcore/offline"
)

const (
	syncToolAccess = "AKIA-TOOL-ACCESS-4c2e"
	syncToolSecret = "tool-secret-9d0f1a77"
)

// syncToolHost: mỗi máy một mã máy.
type syncToolHost struct {
	fakeHost
	device string
}

func (h *syncToolHost) WorkingActor() (offline.Actor, error) {
	return offline.Actor{UserID: "u-" + h.device, Name: "Người " + h.device, DeviceID: h.device}, nil
}

type syncToolMachine struct {
	e        *testengine.Engine
	svc      *cqtest.Service
	registry *Registry
	journal  []testengine.ToolCall
}

// newSyncToolMachine: engine riêng, Service đã cấu hình đồng bộ với kho chung store, danh mục tool trên Service đó.
func newSyncToolMachine(t *testing.T, store teamsync.ObjectStore, device string, perms []string) *syncToolMachine {
	t.Helper()
	dir := t.TempDir()
	met, err := testengine.OpenMetrics(filepath.Join(dir, "testengine.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { met.Close() })
	m := &syncToolMachine{e: testengine.NewEngine(dir, testengine.NewPool(), met, &memSecrets{m: map[string]string{}})}
	deps := cqtest.SyncDeps{Tenant: func() string { return "t1" }, OpenStore: func(teamsync.MinioConfig) (teamsync.ObjectStore, error) { return store, nil }}
	admin := cqtest.New(&syncToolHost{device: device}, m.e, deps)
	if _, err := admin.SetSyncConfig(cqtest.SyncConfig{Endpoint: "minio.local:9000", Bucket: "chatqa-team", UseTLS: true}); err != nil {
		t.Fatal(err)
	}
	if err := admin.SetSyncCredentials(syncToolAccess, syncToolSecret); err != nil {
		t.Fatal(err)
	}
	m.svc = cqtest.New(&syncToolHost{fakeHost: fakeHost{perms: perms}, device: device}, m.e, deps)
	m.registry = Catalog(nil, m.svc, nil, nil)
	m.registry.Secrets = m.e.SecretValues
	m.registry.Journal = func(c testengine.ToolCall) { m.journal = append(m.journal, c) }
	return m
}

func syncDoc(extra string) string {
	return "---\ntype: PRD\ntitle: Checkout\n---\n# Checkout\n\n## Đăng nhập {#REQ-012}\nĐăng nhập rồi thấy Trang chủ.\n" + extra
}

// Tệp xung đột bị bỏ qua và liệt kê kèm câu "gộp trong trang Đồng bộ"; các tệp khác vẫn đẩy. Không phản hồi hay sổ
// tool nào chứa khoá S3.
func TestSyncToolsSkipConflictsAndNeverLeakKeys(t *testing.T) {
	store := teamsync.NewMemStore()
	a, b := newSyncToolMachine(t, store, "PC-A", nil), newSyncToolMachine(t, store, "PC-B", nil)
	var replies []any
	call := func(m *syncToolMachine, name string, args any) map[string]any {
		t.Helper()
		res, err := callTool(t, env{registry: m.registry}, name, args)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		replies = append(replies, res)
		return asJSON[map[string]any](t, res.Data)
	}

	if _, err := a.e.Docs.Save("demo", "prd-checkout", syncDoc("")); err != nil {
		t.Fatal(err)
	}
	if out := call(a, "sync_push", map[string]any{"apps": []string{}, "run_id": ""}); len(out["pushed"].([]any)) != 1 {
		t.Fatalf("A đẩy: %v", out)
	}
	if out := call(b, "sync_pull", map[string]any{"apps": []string{"demo"}}); len(out["pulled"].([]any)) != 1 {
		t.Fatalf("B kéo: %v", out)
	}
	if _, err := a.e.Docs.Save("demo", "prd-checkout", syncDoc("\nA sửa.\n")); err != nil {
		t.Fatal(err)
	}
	call(a, "sync_push", map[string]any{"apps": []string{}, "run_id": ""})
	if _, err := b.e.Docs.Save("demo", "prd-checkout", syncDoc("\nB sửa.\n")); err != nil {
		t.Fatal(err)
	}
	if _, err := b.e.Docs.Save("demo", "srs-other", "---\ntype: SRS\ntitle: Khác\n---\n# Khác\n\n## Đăng xuất {#REQ-020}\nĐăng xuất về trang đăng nhập.\n"); err != nil {
		t.Fatal(err)
	}

	out := call(b, "sync_push", map[string]any{"apps": []string{"demo"}, "run_id": ""})
	conflicts, _ := out["conflicts"].([]any)
	pushed, _ := out["pushed"].([]any)
	note, _ := out["conflictNote"].(string)
	if len(conflicts) != 1 || len(pushed) != 1 || !strings.Contains(pushed[0].(string), "srs-other") || !strings.Contains(note, "gộp trong trang Đồng bộ") {
		t.Fatalf("sync_push phải bỏ qua tệp xung đột, đẩy tệp khác và nói gộp ở đâu: %v", out)
	}
	st := call(b, "sync_status", map[string]any{"apps": []string{}})
	counts, _ := st["counts"].(map[string]any)
	listed, _ := st["conflicts"].([]any)
	if counts[teamsync.StateConflict] != float64(1) || len(listed) != 1 || !strings.Contains(st["conflictNote"].(string), "gộp trong trang Đồng bộ") || st["lastPush"] == nil {
		t.Fatalf("sync_status: %v", st)
	}
	pull := call(b, "sync_pull", map[string]any{"apps": []string{}})
	if c, _ := pull["conflicts"].([]any); len(c) != 1 || !strings.Contains(pull["conflictNote"].(string), "gộp trong trang Đồng bộ") {
		t.Fatalf("sync_pull phải liệt kê xung đột: %v", pull)
	}

	// Evidence qua MCP: lượt thường đẩy được; gói > 200 MB trả evidence_confirm_required và không tải gì.
	id := time.Now().Format("060102-150405")
	runDir := filepath.Join(a.e.RunsDir, id)
	os.MkdirAll(runDir, 0o755)
	now := time.Now()
	if err := a.e.Metrics.Save(testengine.RunRecord{ID: id, App: "demo", StartedAt: now, FinishedAt: now, OutDir: runDir}, nil); err != nil {
		t.Fatal(err)
	}
	f, err := os.Create(filepath.Join(runDir, "video.mp4"))
	if err != nil {
		t.Fatal(err)
	}
	f.Truncate(teamsync.EvidenceConfirmBytes + 1)
	f.Close()
	_, err = callTool(t, env{registry: a.registry}, "sync_push", map[string]any{"apps": []string{}, "run_id": id})
	if apperr.CodeOf(err) != teamsync.CodeConfirmRequired || apperr.CodeOf(err) != "evidence_confirm_required" {
		t.Fatalf("gói lớn qua MCP: %v", err)
	}
	if objs, _ := store.List(context.Background(), "tenants/t1/chatqa/evidence/", 10); len(objs) != 0 {
		t.Fatalf("MCP không được tự đẩy gói lớn: %v", objs)
	}
	os.Truncate(filepath.Join(runDir, "video.mp4"), 4)
	if out := call(a, "sync_push", map[string]any{"apps": []string{}, "run_id": id}); out["runId"] != id || out["uploaded"].(float64) == 0 {
		t.Fatalf("chia sẻ evidence qua MCP: %v", out)
	}

	raw, _ := json.Marshal(replies)
	journal, _ := json.Marshal(append(a.journal, b.journal...))
	for _, v := range []string{syncToolAccess, syncToolSecret} {
		if strings.Contains(string(raw), v) || strings.Contains(string(journal), v) {
			t.Fatalf("phản hồi MCP hoặc sổ tool chứa khoá S3")
		}
	}
}

// Thiếu cqs.run: sync_push, sync_pull bị từ chối; sync_status chỉ đọc vẫn chạy.
func TestSyncToolsPermission(t *testing.T) {
	store := teamsync.NewMemStore()
	m := newSyncToolMachine(t, store, "PC-A", []string{})
	e := env{registry: m.registry}
	for _, tc := range []struct {
		name string
		args any
	}{{"sync_push", map[string]any{"apps": []string{}, "run_id": ""}}, {"sync_pull", map[string]any{"apps": []string{}}},
		{"sync_push", map[string]any{"apps": []string{}, "run_id": "261120-090000"}}} {
		if _, err := callTool(t, e, tc.name, tc.args); apperr.CodeOf(err) != apperr.CodePermissionDenied {
			t.Errorf("%s %v: %v", tc.name, tc.args, err)
		}
	}
	if _, err := callTool(t, e, "sync_status", map[string]any{"apps": []string{}}); err != nil {
		t.Fatalf("sync_status chỉ đọc: %v", err)
	}
}
