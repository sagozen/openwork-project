package tools

// Risk is how much harm one call can do. Agents use it to decide when a person must confirm.
// It is never part of MCP tools/list; MCP keeps its own readOnlyHint.
type Risk string

const (
	RiskRead      Risk = "read"      // looks only, changes nothing
	RiskRun       Risk = "run"       // drives a device or starts a run; reversible, may cost time or money
	RiskWrite     Risk = "write"     // saves or overwrites files, flows, docs, settings or shared team data
	RiskDangerous Risk = "dangerous" // deletes data, stops everything, or pulls others' changes onto this machine
)

// riskOfTool lists every tool that is not read-only. A tool with no permission is read unless it appears here.
var riskOfTool = map[string]Risk{
	"tower_dispatch":      RiskRun,
	"tower_replay_failed": RiskRun,
	"tower_pause_all":     RiskDangerous,
	"device_tap":          RiskRun,
	"device_swipe":        RiskRun,
	"web_navigate":        RiskRun,
	"web_back":            RiskRun,
	"web_click":           RiskRun,
	"web_fill":            RiskRun,
	"web_press":           RiskRun,
	"web_select":          RiskRun,
	"web_wait":            RiskRun,
	"test_run":            RiskRun,
	"test_stop":           RiskRun,
	"test_compile":        RiskRun,
	"test_repair":         RiskRun,
	"test_compare":        RiskRun,
	"test_set_env":        RiskWrite,
	"test_save_flow":      RiskWrite,
	"test_apply_repair":   RiskWrite,
	"test_export_spec":    RiskWrite,
	"docs_update":         RiskWrite,
	"sync_push":           RiskWrite,
	"test_delete_flow":    RiskDangerous,
	"sync_pull":           RiskDangerous,
}

// RiskOf is the tool's explicit Risk, else read when it needs no permission, else the entry in riskOfTool.
// A tool that needs a permission but is in neither place counts as write, the safe side; risk_test.go fails
// until the new tool is listed.
func RiskOf(t Tool) Risk {
	if t.Risk != "" {
		return t.Risk
	}
	if t.Perm == "" {
		return RiskRead
	}
	if r, ok := riskOfTool[t.Name]; ok {
		return r
	}
	return RiskWrite
}
