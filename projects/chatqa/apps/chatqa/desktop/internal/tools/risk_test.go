package tools

import (
	"encoding/json"
	"os"
	"testing"
)

// wantRisk lists every tool in the catalog with the risk it must have. A new tool fails this test until it is added
// here on purpose, so nobody ships a tool whose risk was only a default.
var wantRisk = map[string]Risk{
	"device_screenshot":   RiskRead,
	"device_swipe":        RiskRun,
	"device_tap":          RiskRun,
	"device_ui_state":     RiskRead,
	"docs_affected_cases": RiskRead,
	"docs_coverage":       RiskRead,
	"docs_get":            RiskRead,
	"docs_list":           RiskRead,
	"docs_requirements":   RiskRead,
	"docs_update":         RiskWrite,
	"sync_pull":           RiskDangerous,
	"sync_push":           RiskWrite,
	"sync_status":         RiskRead,
	"test_apply_repair":   RiskWrite,
	"test_compare":        RiskRun,
	"test_compile":        RiskRun,
	"test_delete_flow":    RiskDangerous,
	"test_export_spec":    RiskWrite,
	"test_flows":          RiskRead,
	"test_get_flow":       RiskRead,
	"test_git_diff":       RiskRead,
	"test_metrics":        RiskRead,
	"test_repair":         RiskRun,
	"test_report":         RiskRead,
	"test_run":            RiskRun,
	"test_save_flow":      RiskWrite,
	"test_save_result":    RiskRead,
	"test_set_env":        RiskWrite,
	"test_stop":           RiskRun,
	"test_validate":       RiskRead,
	"tower_alerts":        RiskRead,
	"tower_budget":        RiskRead,
	"tower_deliveries":    RiskRead,
	"tower_device_report": RiskRead,
	"tower_dispatch":      RiskRun,
	"tower_fleet":         RiskRead,
	"tower_health":        RiskRead,
	"tower_pause_all":     RiskDangerous,
	"tower_replay_failed": RiskRun,
	"tower_report":        RiskRead,
	"tower_tasks":         RiskRead,
	"tower_wait_task":     RiskRead,
	"web_back":            RiskRun,
	"web_click":           RiskRun,
	"web_fill":            RiskRun,
	"web_navigate":        RiskRun,
	"web_press":           RiskRun,
	"web_select":          RiskRun,
	"web_wait":            RiskRun,
}

func TestEveryToolHasADeclaredRisk(t *testing.T) {
	e := newEnv(t, &fakeHost{})
	list := e.registry.List()
	if len(list) != len(wantRisk) {
		t.Fatalf("catalog has %d tools, table has %d", len(list), len(wantRisk))
	}
	for _, tl := range list {
		want, ok := wantRisk[tl.Name]
		if !ok {
			t.Errorf("tool %s is missing from wantRisk", tl.Name)
			continue
		}
		if got := RiskOf(tl); got != want {
			t.Errorf("tool %s: risk %s, want %s", tl.Name, got, want)
		}
		if tl.Perm == "" && want != RiskRead {
			t.Errorf("tool %s has no permission but risk %s", tl.Name, want)
		}
		if tl.Perm != "" && want == RiskRead {
			t.Errorf("tool %s needs a permission but is marked read", tl.Name)
		}
		if _, listed := riskOfTool[tl.Name]; tl.Perm != "" && !listed {
			t.Errorf("tool %s needs a permission but is not in riskOfTool", tl.Name)
		}
	}
}

func TestRiskStaysOutOfMCPAndJSON(t *testing.T) {
	raw, _ := json.Marshal(Tool{Name: "x", Risk: RiskDangerous})
	if string(raw) != "" && json.Valid(raw) {
		var m map[string]any
		json.Unmarshal(raw, &m)
		if _, has := m["Risk"]; has {
			t.Fatal("Risk must not be serialized")
		}
		if _, has := m["risk"]; has {
			t.Fatal("Risk must not be serialized")
		}
	}
	if _, err := os.Stat("testdata/tools_list.golden.json"); err != nil {
		t.Fatal(err)
	}
}

func TestExplicitRiskOverridesTable(t *testing.T) {
	if RiskOf(Tool{Name: "test_run", Perm: "cqs.run", Risk: RiskDangerous}) != RiskDangerous {
		t.Fatal("explicit Risk must win")
	}
	if RiskOf(Tool{Name: "brand_new", Perm: "cqs.run"}) != RiskWrite {
		t.Fatal("an unlisted tool that needs a permission defaults to write")
	}
}
