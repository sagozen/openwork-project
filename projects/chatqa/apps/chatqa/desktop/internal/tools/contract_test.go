package tools

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"testing"

	"chatqa/internal/components"
	"deskcore/modules"
)

func loadContract(t *testing.T) *components.Contract {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "..", "contracts", "cqs-components.json"))
	if err != nil {
		t.Fatal(err)
	}
	c, err := components.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestKindsMatchContract(t *testing.T) {
	c := loadContract(t)
	var contract []string
	for k := range c.Kinds {
		contract = append(contract, k)
	}
	sort.Strings(contract)
	kinds := slices.Clone(Kinds)
	sort.Strings(kinds)
	if !slices.Equal(contract, kinds) {
		t.Fatalf("contracts/cqs-components.json %v != tools.Kinds %v", contract, kinds)
	}
}

// Kết quả tool thật (thiết bị mock) phải khớp schema của kind khai trong danh mục, để component vẽ được.
func TestToolResultsMatchComponentSchemas(t *testing.T) {
	c := loadContract(t)
	e := newEnv(t, &fakeHost{})
	ctx := context.Background()
	call := func(name, args string) {
		t.Helper()
		res, err := e.registry.Call(ctx, name, json.RawMessage(args))
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if err := c.Validate(res.Kind, res.Data); err != nil {
			raw, _ := json.Marshal(res.Data)
			t.Errorf("%s (%s): %v\n%s", name, res.Kind, err, raw)
		}
	}
	dispatched, err := e.registry.Call(ctx, "tower_dispatch", json.RawMessage(`{"app":"demo","devices":["emu-1"]}`))
	if err != nil {
		t.Fatal(err)
	}
	if err := c.Validate(dispatched.Kind, dispatched.Data); err != nil {
		t.Errorf("tower_dispatch: %v", err)
	}
	raw, _ := json.Marshal(dispatched.Data)
	var task struct{ ID string }
	json.Unmarshal(raw, &task)
	call("tower_wait_task", `{"id":"`+task.ID+`","timeout_sec":30}`)
	call("tower_report", `{"id":"`+task.ID+`"}`)
	call("tower_fleet", `{}`)
	call("tower_tasks", `{"status":"","limit":5}`)
	call("tower_health", `{}`)
	call("tower_budget", `{}`)
	call("tower_alerts", `{}`)
	call("tower_device_report", `{"id":"emu-1"}`)
	call("device_screenshot", `{"id":"emu-1"}`)
	call("device_ui_state", `{"id":"emu-1"}`)
	call("tower_pause_all", `{}`)
	call("test_flows", `{"app":"demo"}`)
	call("test_validate", `{"app":"demo","flows":[]}`)
	call("test_metrics", `{"app":"","flow":"","device_id":"","days":0}`)
	call("test_run", `{"app":"demo","devices":["emu-1"]}`)
	call("test_stop", `{"id":"không-có"}`)
	runs, _ := e.tower.Engine.Metrics.Runs(1)
	call("test_report", `{"id":"`+runs[0].ID+`"}`)
}

// Tool tài liệu nghiệp vụ: đủ tên, chỉ docs_update cần cqs.run, kind có trong hợp đồng; test_compile nhận reqs (mảng mã).
func TestDocsToolsDeclared(t *testing.T) {
	r := Catalog(nil, nil, nil, nil)
	for name, perm := range map[string]string{"docs_list": "", "docs_get": "", "docs_update": "cqs.run", "docs_requirements": "",
		"docs_affected_cases": "", "docs_coverage": ""} {
		tl, ok := r.Get(name)
		if !ok {
			t.Errorf("thiếu tool %s", name)
			continue
		}
		if tl.Perm != perm || tl.App != "cqs.test" || !slices.Contains(Kinds, tl.Kind) {
			t.Errorf("%s: perm=%q app=%q kind=%q", name, tl.Perm, tl.App, tl.Kind)
		}
	}
	tl, ok := r.Get("test_compile")
	if !ok {
		t.Fatal("thiếu tool test_compile")
	}
	reqs, _ := tl.Schema["properties"].(map[string]any)["reqs"].(map[string]any)
	if reqs["type"] != "array" || reqs["items"].(map[string]any)["type"] != "string" {
		t.Fatalf("test_compile.reqs = %v", reqs)
	}
}

// Tool đồng bộ nhóm: sync_status chỉ đọc, sync_push/sync_pull cần cqs.run; không có tool gộp/giữ bản qua MCP.
func TestSyncToolsDeclared(t *testing.T) {
	r := Catalog(nil, nil, nil, nil)
	for name, perm := range map[string]string{"sync_status": "", "sync_push": modules.PermCQRun, "sync_pull": modules.PermCQRun} {
		tl, ok := r.Get(name)
		if !ok {
			t.Errorf("thiếu tool %s", name)
			continue
		}
		if tl.Perm != perm || tl.App != "cqs.test" || !slices.Contains(Kinds, tl.Kind) || tl.Cost != CostFree {
			t.Errorf("%s: perm=%q app=%q kind=%q cost=%q", name, tl.Perm, tl.App, tl.Kind, tl.Cost)
		}
	}
	// Không có tool gộp/giữ bản qua MCP.
	for _, tl := range r.List() {
		if strings.HasPrefix(tl.Name, "sync_") && !slices.Contains([]string{"sync_status", "sync_push", "sync_pull"}, tl.Name) {
			t.Errorf("tool đồng bộ ngoài phạm vi: %s", tl.Name)
		}
	}
}
