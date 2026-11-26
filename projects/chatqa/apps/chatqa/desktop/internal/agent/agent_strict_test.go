package agent

import (
	"fmt"
	"testing"

	"chatqa/internal/tools"
)

func registryOf(n int) *tools.Registry {
	ts := make([]tools.Tool, n)
	for i := range ts {
		ts[i] = tools.Tool{Name: fmt.Sprintf("t%02d", i), Description: "d", Schema: map[string]any{"type": "object"}}
	}
	return tools.NewRegistry(ts...)
}

func strictCount(a *Agent) (total, strict int) {
	got := a.request(&conversation{})["tools"].([]map[string]any)
	for _, d := range got {
		if d["strict"] == true {
			strict++
		}
	}
	return len(got), strict
}

// Claude từ chối cả yêu cầu có hơn maxStrictTools tool strict (HTTP 400): danh mục lớn thì bỏ strict, nhỏ thì giữ.
func TestRequestStrictOnlyWithinClaudeLimit(t *testing.T) {
	if total, strict := strictCount(&Agent{Registry: registryOf(maxStrictTools + 5)}); total != maxStrictTools+5 || strict != 0 {
		t.Fatalf("danh mục lớn: %d tool, %d strict, muốn 0 strict", total, strict)
	}
	if total, strict := strictCount(&Agent{Registry: registryOf(maxStrictTools)}); total != maxStrictTools || strict != total {
		t.Fatalf("danh mục nhỏ: %d tool, %d strict, muốn tất cả strict", total, strict)
	}
}
