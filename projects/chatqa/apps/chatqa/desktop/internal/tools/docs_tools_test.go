package tools

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"chatqa/internal/docs"
	"chatqa/internal/testengine"
	"deskcore/apperr"
)

const docsToolDoc = "---\ntype: PRD\ntitle: Checkout\n---\n# Checkout\n\n## Đăng nhập {#REQ-012}\nĐăng nhập rồi thấy Trang chủ.\n\n## Thanh toán\nThanh toán đơn hàng.\n"

func callTool(t *testing.T, e env, name string, args any) (*Result, error) {
	t.Helper()
	raw, err := json.Marshal(args)
	if err != nil {
		t.Fatal(err)
	}
	return e.registry.Call(context.Background(), name, raw)
}

// asJSON đổi dữ liệu kết quả về kiểu cụ thể như client MCP nhận.
func asJSON[T any](t *testing.T, data any) T {
	t.Helper()
	raw, err := json.Marshal(data)
	if err != nil {
		t.Fatal(err)
	}
	var out T
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("%v: %s", err, raw)
	}
	return out
}

func TestDocsToolsRoundTrip(t *testing.T) {
	e := newEnv(t, &fakeHost{})
	var journaled []testengine.ToolCall
	e.registry.Journal = func(c testengine.ToolCall) { journaled = append(journaled, c) }

	res, err := callTool(t, e, "docs_update", map[string]any{"app": "demo", "id": "prd-checkout", "markdown": docsToolDoc})
	if err != nil {
		t.Fatal(err)
	}
	saved := asJSON[docs.Doc](t, res.Data)
	if saved.Rev != 1 || !strings.Contains(saved.Markdown, "## Thanh toán {#REQ-013}") {
		t.Fatalf("docs_update phải trả mã đã gán: %+v", saved)
	}
	if len(journaled) != 1 || journaled[0].Tool != "docs_update" || journaled[0].ErrorCode != "" {
		t.Fatalf("docs_update phải vào sổ tool: %+v", journaled)
	}

	res, err = callTool(t, e, "docs_list", map[string]any{"app": "demo"})
	if err != nil {
		t.Fatal(err)
	}
	list := asJSON[struct {
		App  string         `json:"app"`
		Docs []docs.DocInfo `json:"docs"`
	}](t, res.Data)
	if list.App != "demo" || len(list.Docs) != 1 || list.Docs[0].ID != "prd-checkout" {
		t.Fatalf("docs_list: %+v", list)
	}

	res, err = callTool(t, e, "docs_get", map[string]any{"app": "demo", "id": "prd-checkout"})
	if err != nil {
		t.Fatal(err)
	}
	if got := asJSON[docs.Doc](t, res.Data); got.Markdown != saved.Markdown || len(got.Requirements) != 2 {
		t.Fatalf("docs_get: %+v", got)
	}

	res, err = callTool(t, e, "docs_requirements", map[string]any{"app": "demo"})
	if err != nil {
		t.Fatal(err)
	}
	idx := asJSON[struct {
		Reqs       []docs.Requirement `json:"reqs"`
		Duplicates []string           `json:"duplicates"`
	}](t, res.Data)
	if len(idx.Reqs) != 2 || idx.Reqs[1].ID != "REQ-013" || idx.Duplicates == nil {
		t.Fatalf("docs_requirements: %+v", idx)
	}

	res, err = callTool(t, e, "docs_coverage", map[string]any{"app": "demo"})
	if err != nil {
		t.Fatal(err)
	}
	if cov := asJSON[testengine.Coverage](t, res.Data); len(cov.Reqs) != 2 || len(cov.Reqs[0].Cases) != 0 {
		t.Fatalf("docs_coverage: %+v", cov)
	}

	res, err = callTool(t, e, "docs_affected_cases", map[string]any{"app": "demo"})
	if err != nil {
		t.Fatal(err)
	}
	affected := asJSON[struct {
		Cases []testengine.AffectedCase `json:"cases"`
	}](t, res.Data)
	if affected.Cases == nil || len(affected.Cases) != 0 {
		t.Fatalf("docs_affected_cases: %+v", affected)
	}

	if _, err := callTool(t, e, "docs_get", map[string]any{"app": "demo", "id": "khong-co"}); apperr.CodeOf(err) != apperr.CodeNotFound {
		t.Fatalf("docs_get tài liệu lạ: %v", err)
	}
}

func TestDocsUpdateNeedsRunPermission(t *testing.T) {
	e := newEnv(t, &fakeHost{perms: []string{}})
	if _, err := callTool(t, e, "docs_update", map[string]any{"app": "demo", "id": "prd-checkout", "markdown": docsToolDoc}); apperr.CodeOf(err) != apperr.CodePermissionDenied {
		t.Fatalf("docs_update không có cqs.run: %v", err)
	}
	res, err := callTool(t, e, "docs_list", map[string]any{"app": "demo"})
	if err != nil {
		t.Fatalf("docs_list chỉ đọc: %v", err)
	}
	if n := len(asJSON[struct{ Docs []docs.DocInfo }](t, res.Data).Docs); n != 0 {
		t.Fatalf("không được ghi khi thiếu quyền: %d tài liệu", n)
	}
}

// reqs của test_compile tới được engine: mã không có trong tài liệu bị từ chối trước khi gọi AI.
func TestCompileToolPassesReqs(t *testing.T) {
	e := newEnv(t, &fakeHost{})
	if _, err := callTool(t, e, "docs_update", map[string]any{"app": "demo", "id": "prd-checkout", "markdown": docsToolDoc}); err != nil {
		t.Fatal(err)
	}
	_, err := callTool(t, e, "test_compile", map[string]any{"app": "demo", "source": "", "app_id": "com.example.app", "device_id": "emu-1",
		"start_path": "", "env": []any{}, "secrets": []string{}, "confirm_token": "", "reqs": []string{"REQ-999"}})
	if apperr.CodeOf(err) != apperr.CodeNotFound || !strings.Contains(err.Error(), "REQ-999") {
		t.Fatalf("mã yêu cầu lạ phải bị từ chối kèm mã: %v", err)
	}
}
