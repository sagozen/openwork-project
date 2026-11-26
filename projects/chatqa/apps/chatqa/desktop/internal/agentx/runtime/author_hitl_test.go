package runtime

import (
	"context"
	"encoding/json"
	"strings"
	"sync/atomic"
	"testing"

	"google.golang.org/genai"

	"chatqa/internal/tools"
)

// The coordinator hands a new-flow request to the author; saving the flow asks the tester, nothing is saved before the
// answer, and after the approval the author's run continues, saves the flow and reports.
func TestAuthorSavesFlowOnlyAfterApproval(t *testing.T) {
	f := newFixture(t, t.TempDir(), passingRun)
	var saved atomic.Int32
	f.reg = tools.NewRegistry(
		tools.Raw("test_flows", "flow", "", "FlowList", map[string]any{"type": "object"}, func(context.Context, json.RawMessage) (any, error) { return []string{}, nil }),
		tools.Raw("test_save_flow", "lưu", "cqs.test", "ReportCard", map[string]any{"type": "object"}, func(context.Context, json.RawMessage) (any, error) {
			saved.Add(1)
			return map[string]any{"saved": true}, nil
		}),
	)
	save := func() []*genai.Part {
		return []*genai.Part{{FunctionCall: &genai.FunctionCall{ID: "s1", Name: "test_save_flow", Args: map[string]any{"app": "sixmonths"}}}}
	}
	f.open(t, map[string]*scripted{
		"c": {steps: []func() []*genai.Part{transferTo("author")}},
		"a": {steps: []func() []*genai.Part{save, text("đã lưu flow")}},
	})
	id, evs, err := collect(t, f.rt, "", "soạn flow mới cho sixmonths")
	if err != nil {
		t.Fatal(err)
	}
	c := find(evs, KindConfirmation)
	if c == nil || c.ToolName != "test_save_flow" || saved.Load() != 0 {
		t.Fatalf("confirmation = %+v saved=%d: nothing may be saved before the answer", c, saved.Load())
	}
	after, err := approve(t, f, id, c.ToolCallID, true)
	if err != nil {
		t.Fatal(err)
	}
	if saved.Load() != 1 || !strings.Contains(allText(after), "đã lưu flow") {
		t.Fatalf("saved=%d events=%+v: the approved author run must save the flow and report", saved.Load(), after)
	}
}
