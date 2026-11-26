package agents

import (
	"slices"
	"testing"
)

// The Author only adds flows: it never deletes, overwrites through a repair, runs the whole suite or stops runs.
func TestAuthorToolsOnlyAddFlows(t *testing.T) {
	for _, banned := range []string{"test_delete_flow", "test_apply_repair", "test_repair", "test_run", "test_stop", "tower_dispatch", "tower_pause_all", "docs_update", "test_set_env", "sync_push", "sync_pull"} {
		if slices.Contains(AuthorTools, banned) {
			t.Errorf("Author must not have %s", banned)
		}
	}
	for _, need := range []string{"test_compile", "test_save_flow", "test_flows", "device_ui_state", "web_click", "web_back"} {
		if !slices.Contains(AuthorTools, need) {
			t.Errorf("Author needs %s", need)
		}
	}
}
