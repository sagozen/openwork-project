package runtime

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"google.golang.org/genai"

	"chatqa/internal/testengine"
	"chatqa/internal/tools"
)

const brokenLogin = "appId: com.example\n---\n- launchApp\n- tapOn: \"Dang nhap\"\n"
const fixedLogin = "appId: com.example\n---\n- launchApp\n- tapOn: \"Đăng nhập\"\n"

// flowFixerFixture is a fixture with a real flow store holding mexpress/01_login.yaml, and a registry whose
// test_validate and test_apply_repair work on that store.
func flowFixerFixture(t *testing.T) (*fixture, string) {
	t.Helper()
	f := newFixture(t, t.TempDir(), passingRun)
	root := filepath.Join(t.TempDir(), "flows")
	if err := os.MkdirAll(filepath.Join(root, "mexpress"), 0o755); err != nil {
		t.Fatal(err)
	}
	flowFile := filepath.Join(root, "mexpress", "01_login.yaml")
	if err := os.WriteFile(flowFile, []byte(brokenLogin), 0o644); err != nil {
		t.Fatal(err)
	}
	f.store = testengine.NewFlowStore(root)
	schema := map[string]any{"type": "object"}
	f.reg = tools.NewRegistry(
		tools.Raw("test_validate", "kiểm tra", "", "FlowList", schema, func(_ context.Context, raw json.RawMessage) (any, error) {
			var a struct {
				App   string   `json:"app"`
				Flows []string `json:"flows"`
			}
			if err := json.Unmarshal(raw, &a); err != nil {
				return nil, err
			}
			if err := f.store.Validate(a.App, a.Flows...); err != nil {
				return nil, err
			}
			return map[string]any{"valid": true}, nil
		}),
		tools.Raw("test_apply_repair", "lưu bản sửa", "cqs.run", "FlowList", schema, func(_ context.Context, raw json.RawMessage) (any, error) {
			var d testengine.YamlDiff
			if err := json.Unmarshal(raw, &d); err != nil {
				return nil, err
			}
			cur, err := os.ReadFile(filepath.Join(root, d.App, d.Flow))
			if err != nil || string(cur) != d.Before {
				return nil, errors.New("flow đã thay đổi sau khi đề xuất bản sửa")
			}
			return f.store.Save(d.App, d.Flow, []byte(d.After), "")
		}),
	)
	return f, flowFile
}

func sum(t *testing.T, path string) [32]byte {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return sha256.Sum256(raw)
}

func TestFlowFixerLoopStopsOnAValidDraftAndLeavesTheFlowAlone(t *testing.T) {
	f, flowFile := flowFixerFixture(t)
	before := sum(t, flowFile)
	fixer := &scripted{steps: []func() []*genai.Part{
		call("p1", "read_flow", map[string]any{"app": "mexpress", "flow": "01_login.yaml"}),
		call("p2", "propose_flow_patch", map[string]any{"app": "mexpress", "flow": "01_login.yaml", "patch_yaml": "appId: com.example\n---\n- tapOn: [\n", "reason": "thử"}),
		text("Bản nháp chưa hợp lệ, sửa lại ở lượt sau."),
		call("p3", "propose_flow_patch", map[string]any{"app": "mexpress", "flow": "01_login.yaml", "patch_yaml": fixedLogin, "reason": "nút đổi chữ thành có dấu"}),
		func() []*genai.Part {
			return []*genai.Part{{Text: "Bản nháp đã sẵn sàng để duyệt."}, {FunctionCall: &genai.FunctionCall{ID: "x1", Name: "exit_loop", Args: map[string]any{}}}}
		},
		text("không được chạy tới đây"),
	}}
	f.open(t, map[string]*scripted{"c": {steps: []func() []*genai.Part{transferTo("fix_flow")}}, "f": fixer})

	_, evs, err := collect(t, f.rt, "", "sửa flow login: không thấy nút Dang nhap")
	if err != nil {
		t.Fatal(err)
	}
	if got := len(fixer.requests()); got != 5 {
		t.Fatalf("the loop must stop right after exit_loop: %d model calls, events %+v", got, evs)
	}
	if strings.Contains(allText(evs), "không được chạy tới đây") {
		t.Fatal("a pass ran after exit_loop")
	}
	reqs := fixer.requests()
	if !strings.Contains(reqs[1].body, `Dang nhap`) || !strings.Contains(reqs[2].body, `"valid":false`) || !strings.Contains(reqs[4].body, `"valid":true`) {
		t.Fatalf("the fixer must read the flow and each validation result: %+v", reqs)
	}
	if sum(t, flowFile) != before {
		t.Fatal("the flow file must be byte-identical: the fixer writes drafts only")
	}
	list, err := f.rt.Drafts()
	if err != nil || len(list) != 2 || !list[0].Valid || list[1].Valid || list[0].Flow != "01_login.yaml" || list[0].Applied {
		t.Fatalf("drafts = %+v %v", list, err)
	}
	if c := find(evs, KindConfirmation); c != nil {
		t.Fatalf("a draft asks no one: %+v", c)
	}
}

func TestFlowFixerLoopIsBoundedByMaxIterations(t *testing.T) {
	f, _ := flowFixerFixture(t)
	f.cfg.Agent.FlowFixer.MaxIterations = 2
	fixer := &scripted{} // never proposes, never exits
	f.open(t, map[string]*scripted{"c": {steps: []func() []*genai.Part{transferTo("fix_flow")}}, "f": fixer})
	if _, _, err := collect(t, f.rt, "", "sửa flow login"); err != nil {
		t.Fatal(err)
	}
	if got := len(fixer.requests()); got != 2 {
		t.Fatalf("model calls = %d, want one per pass and 2 passes", got)
	}
}

func TestApplyDraftAsksFirstThenWritesThroughTheRegistry(t *testing.T) {
	f, flowFile := flowFixerFixture(t)
	f.open(t, map[string]*scripted{})
	res, err := f.rt.drafts.Propose("mexpress", "01_login.yaml", fixedLogin, "nút đổi chữ")
	if err != nil || !res.Valid {
		t.Fatalf("propose: %+v %v", res, err)
	}
	ctx := context.Background()
	ask, err := f.rt.ApplyDraft(ctx, res.DraftID, false)
	if err != nil || !ask.NeedsConfirm || ask.Applied || ask.Risk != "write" || ask.Consequence == "" {
		t.Fatalf("first call must ask: %+v %v", ask, err)
	}
	if raw, _ := os.ReadFile(flowFile); string(raw) != brokenLogin {
		t.Fatal("nothing is written before the approval")
	}
	done, err := f.rt.ApplyDraft(ctx, res.DraftID, true)
	if err != nil || !done.Applied {
		t.Fatalf("apply: %+v %v", done, err)
	}
	if raw, _ := os.ReadFile(flowFile); string(raw) != fixedLogin {
		t.Fatalf("flow after apply = %q", raw)
	}
	if list, _ := f.rt.Drafts(); len(list) != 1 || !list[0].Applied {
		t.Fatalf("drafts = %+v", list)
	}
	if _, err := f.rt.ApplyDraft(ctx, res.DraftID, true); err == nil {
		t.Fatal("a draft applies once")
	}

	// A draft written before the flow changed is refused by test_apply_repair.
	stale, err := f.rt.drafts.Propose("mexpress", "01_login.yaml", fixedLogin+"- back\n", "thêm bước")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(flowFile, []byte(fixedLogin+"- scroll\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := f.rt.ApplyDraft(ctx, stale.DraftID, true); err == nil || !strings.Contains(err.Error(), "đã thay đổi") {
		t.Fatalf("stale draft: %v", err)
	}
	if raw, _ := os.ReadFile(flowFile); string(raw) != fixedLogin+"- scroll\n" {
		t.Fatal("a refused apply writes nothing")
	}

	invalid, err := f.rt.drafts.Propose("mexpress", "01_login.yaml", "appId: x\n---\n- tapOn: [\n", "thử")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.rt.ApplyDraft(ctx, invalid.DraftID, true); err == nil {
		t.Fatal("an invalid draft cannot be applied")
	}
	if err := f.rt.DiscardDraft(invalid.DraftID); err != nil {
		t.Fatal(err)
	}
}

func TestNoFlowStoreMeansNoFlowFixer(t *testing.T) {
	f := newFixture(t, t.TempDir(), passingRun)
	f.open(t, map[string]*scripted{})
	if list, err := f.rt.Drafts(); err != nil || len(list) != 0 {
		t.Fatalf("drafts = %+v %v", list, err)
	}
	if _, err := f.rt.ApplyDraft(context.Background(), "mexpress/x.20261124T083000000", true); err == nil {
		t.Fatal("apply needs a flow store")
	}
}
