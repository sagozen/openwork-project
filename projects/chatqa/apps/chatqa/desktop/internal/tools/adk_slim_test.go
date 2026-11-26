package tools

import "testing"

// The agent copy of test_flows loses hashes, the save time and an empty deps list, and keeps what picks a flow.
func TestSlimFlowListKeepsWhatAgentsNeed(t *testing.T) {
	out := map[string]any{"kind": "FlowList", "data": map[string]any{
		"app": "sixmonths",
		"flows": []any{map[string]any{
			"app": "sixmonths", "name": "01_smoke.spec.ts", "title": "smoke", "stale": false, "deps": nil,
			"hash": "h", "savedHash": "h", "sourceHash": "", "savedAt": "2026-11-25T10:21:51Z",
		}, map[string]any{"name": "02.yaml", "deps": []any{"00_common/x.yaml"}, "hash": "h"}},
	}}
	slimFlowList(out)
	flows := out["data"].(map[string]any)["flows"].([]any)
	first, second := flows[0].(map[string]any), flows[1].(map[string]any)
	for _, k := range []string{"hash", "savedHash", "sourceHash", "savedAt", "deps"} {
		if _, ok := first[k]; ok {
			t.Errorf("%s should be dropped from %v", k, first)
		}
	}
	if first["name"] != "01_smoke.spec.ts" || first["title"] != "smoke" || first["stale"] != false {
		t.Errorf("lost a field the agent needs: %v", first)
	}
	if second["deps"] == nil {
		t.Errorf("a real dependency list must stay: %v", second)
	}
	slimFlowList(map[string]any{}) // no data: must not panic
}
