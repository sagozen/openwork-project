package guard

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"chatqa/internal/agentx/config"
	"chatqa/internal/testengine"
	"chatqa/internal/tools"
	"deskcore/apperr"
)

const app = "mexpress"

// newStore writes a small flow repo shaped like the QA order flows into a temp dir.
func newStore(t *testing.T, defaults map[string]string) *testengine.FlowStore {
	t.Helper()
	root := t.TempDir()
	files := map[string]string{
		"01_login.yaml":         "appId: x\n---\n- launchApp\n",
		"01_auth/01_login.yaml": "appId: x\n---\n- launchApp\n",
		"02_order/001_tao.yaml": "appId: x\n---\n- runFlow:\n    file: ../01_auth/01_login.yaml\n- tapOn: \"Tạo đơn\"\n",
		"02_order/005_nhan.yaml": "appId: x\n---\n- runFlow:\n    file: ../01_auth/01_login.yaml\n    env:\n      BRANCH: \"GLOBAL5 - Test BAT\"\n" +
			"- runFlow:\n    file: ../00_common/doi.yaml\n",
		"00_common/doi.yaml":    "appId: x\n---\n- runFlow:\n    file: ../01_auth/01_login.yaml\n    env:\n      BRANCH: \"GLOBAL7 - Test\"\n",
		"02_order/007_hcm.yaml": "appId: x\n---\n- runFlow:\n    file: ../01_auth/01_login.yaml\n    env:\n      BRANCH: \"HCM01 - Quan 1\"\n",
		"02_order/008_var.yaml": "appId: x\nenv:\n  BRANCH: \"${DEST}\"\n---\n- launchApp\n",
		"02_order/009_sub.yaml": "appId: x\n---\n- runFlow:\n    file: ../00_common/hcm.yaml\n",
		"00_common/hcm.yaml":    "appId: x\n---\n- runFlow:\n    file: ../01_auth/01_login.yaml\n    env:\n      BRANCH: \"HCM02 - Quan 2\"\n",
	}
	for name, body := range files {
		p := filepath.Join(root, app, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	s := testengine.NewFlowStore(root)
	if len(defaults) > 0 {
		if _, err := s.SetEnv(app, "all", defaults); err != nil {
			t.Fatal(err)
		}
	}
	return s
}

func safety() config.Safety {
	s := config.Defaults().Safety
	s.ProductionEnvNames = []string{"prod", "production"}
	return s
}

func TestDecideConfirmationPolicy(t *testing.T) {
	g := New(safety(), newStore(t, map[string]string{"BRANCH": "GLOBAL0 - Test"}))
	noStore := New(safety(), nil)
	run := func(extra map[string]any) map[string]any {
		a := map[string]any{"app": app, "flows": []any{"01_login.yaml"}, "devices": []any{"emu-1"}}
		for k, v := range extra {
			a[k] = v
		}
		return a
	}
	cases := []struct {
		name string
		g    *Guard
		tool string
		args map[string]any
		risk tools.Risk
		want bool
		why  string
	}{
		{"read tool", g, "test_flows", map[string]any{}, tools.RiskRead, false, ""},
		{"write tool", g, "test_save_flow", map[string]any{"app": app}, tools.RiskWrite, true, "ghi đè"},
		{"compile saves a new flow", g, "test_compile", map[string]any{}, tools.RiskRun, true, "soạn và lưu flow mới"},
		{"dangerous tool", g, "test_delete_flow", map[string]any{}, tools.RiskDangerous, true, "khó hoàn tác"},
		{"run tool other than test_run", g, "device_tap", map[string]any{}, tools.RiskRun, false, ""},
		{"plain test_run", g, "test_run", run(nil), tools.RiskRun, false, ""},
		{"order flow", g, "test_run", run(map[string]any{"flows": []any{"02_order/001_tao.yaml"}}), tools.RiskRun, true, "02_order/001_tao.yaml"},
		{"dispatch of order flow", g, "tower_dispatch", run(map[string]any{"flows": []any{"02_order/005_nhan.yaml"}}), tools.RiskRun, true, "tạo hoặc thay đổi"},
		{"every flow of the app", g, "test_run", run(map[string]any{"flows": []any{}}), tools.RiskRun, false, ""},
		{"every flow, no store", noStore, "test_run", run(map[string]any{"flows": []any{}}), tools.RiskRun, true, "không xác định"},
		{"recording", g, "test_run", run(map[string]any{"record": "always"}), tools.RiskRun, true, "video"},
		{"production env", g, "test_run", run(map[string]any{"env": []any{map[string]any{"name": "APP_ENV", "value": "Prod"}}}), tools.RiskRun, true, "production"},
		{"production label", g, "test_run", run(map[string]any{"label": "production"}), tools.RiskRun, true, "production"},
		{"staging env", g, "test_run", run(map[string]any{"env": []any{map[string]any{"name": "ENV", "value": "staging"}}}), tools.RiskRun, false, ""},
		{"unreadable args", g, "test_run", map[string]any{"flows": "02_order/001_tao.yaml"}, tools.RiskRun, true, "tham số"},
	}
	for _, c := range cases {
		d := c.g.Decide(c.tool, c.args, c.risk)
		if d.Confirm != c.want || !strings.Contains(strings.Join(d.Reasons, "; "), c.why) {
			t.Errorf("%s: got %+v, want confirm=%v with %q", c.name, d, c.want, c.why)
		}
		if c.g.Confirm(c.tool, c.args, c.risk) != c.want {
			t.Errorf("%s: Confirm disagrees with Decide", c.name)
		}
	}
}

func TestCheckPostOffices(t *testing.T) {
	withDefaults := New(safety(), newStore(t, map[string]string{"BRANCH": "GLOBAL0 - Test", "DEST": "GLOBAL9 - Test"}))
	bare := New(safety(), newStore(t, nil))
	req := func(flows []string, env map[string]string) testengine.RunRequest {
		return testengine.RunRequest{App: app, Flows: flows, Env: env}
	}
	cases := []struct {
		name  string
		g     *Guard
		req   testengine.RunRequest
		allow bool
		why   string
	}{
		{"not data-changing", bare, req([]string{"01_login.yaml"}, map[string]string{"BRANCH": "HCM01"}), true, ""},
		{"default env and flow literals are GLOBAL", withDefaults, req([]string{"02_order/005_nhan.yaml"}, nil), true, ""},
		{"run env overrides with GLOBAL", bare, req([]string{"02_order/001_tao.yaml"}, map[string]string{"BRANCH": "GLOBAL3 - Test"}), true, ""},
		{"run env is not GLOBAL", withDefaults, req([]string{"02_order/001_tao.yaml"}, map[string]string{"BRANCH": "HCM01 - Quan 1"}), false, `"HCM01 - Quan 1"`},
		{"flow literal is not GLOBAL", withDefaults, req([]string{"02_order/007_hcm.yaml"}, nil), false, "HCM01"},
		{"called flow literal is not GLOBAL", withDefaults, req([]string{"02_order/009_sub.yaml"}, nil), false, "HCM02"},
		{"no post office known", bare, req([]string{"02_order/001_tao.yaml"}, nil), false, "không xác định được bưu cục"},
		{"variable resolved from defaults", withDefaults, req([]string{"02_order/008_var.yaml"}, nil), true, ""},
		{"variable resolved from run env", withDefaults, req([]string{"02_order/008_var.yaml"}, map[string]string{"DEST": "SGN - x"}), false, "SGN"},
		{"variable without value", bare, req([]string{"02_order/008_var.yaml"}, map[string]string{"BRANCH": "GLOBAL1"}), false, "${DEST}"},
		{"unknown flow list", New(safety(), nil), req(nil, map[string]string{"BRANCH": "GLOBAL1"}), false, "ghi rõ tên flow"},
		{"every flow of the app includes no order flow at the root", withDefaults, req(nil, nil), true, ""},
	}
	for _, c := range cases {
		err := c.g.CheckPostOffices(c.req)
		if (err == nil) != c.allow {
			t.Errorf("%s: err = %v, want allow=%v", c.name, err, c.allow)
			continue
		}
		if err != nil {
			if apperr.CodeOf(err) != codeBlocked || !strings.Contains(err.Error(), c.why) {
				t.Errorf("%s: err = %v (code %q), want %q", c.name, err, apperr.CodeOf(err), c.why)
			}
		}
	}
}

func TestAllowedPostOfficePatterns(t *testing.T) {
	s := safety()
	s.AllowedPostOffices = []string{"global*", "TEST_HN"}
	g := New(s, nil)
	for v, want := range map[string]bool{"GLOBAL5 - Test BAT": true, "global0": true, "TEST_HN - Ha Noi": true, "TEST_HN2": false, "HCM01": false, "": false, "${BRANCH}": false} {
		if got := g.allowedPostOffice(v); got != want {
			t.Errorf("%q: got %v want %v", v, got, want)
		}
	}
	if PostOfficeCode(" GLOBAL5 - Test - BAT ") != "GLOBAL5" {
		t.Fatal("code is the part before the first \" - \"")
	}
}

type recorder struct{ calls []string }

func (r *recorder) Call(_ context.Context, name string, _ json.RawMessage) (*tools.Result, error) {
	r.calls = append(r.calls, name)
	return &tools.Result{Kind: "x"}, nil
}

func TestWrapChecksOnlyRunTools(t *testing.T) {
	rec := &recorder{}
	c := New(safety(), newStore(t, nil)).Wrap(rec)
	ctx := context.Background()
	if _, err := c.Call(ctx, "tower_fleet", json.RawMessage(`{}`)); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Call(ctx, "test_run", json.RawMessage(`{"app":"mexpress","flows":["02_order/001_tao.yaml"],"env":[{"name":"BRANCH","value":"HCM01"}]}`)); err == nil {
		t.Fatal("an order flow at HCM01 must be refused")
	}
	if _, err := c.Call(ctx, "tower_dispatch", json.RawMessage(`{"app":"mexpress","flows":["02_order/001_tao.yaml"],"env":[{"name":"BRANCH","value":"GLOBAL2"}]}`)); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Call(ctx, "test_run", json.RawMessage(`not json`)); err == nil {
		t.Fatal("unreadable run arguments must be refused")
	}
	if strings.Join(rec.calls, ",") != "tower_fleet,tower_dispatch" {
		t.Fatalf("calls that reached the registry: %v", rec.calls)
	}
}
