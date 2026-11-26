package components

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func contract(t *testing.T) *Contract {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "..", "contracts", "cqs-components.json"))
	if err != nil {
		t.Fatal(err)
	}
	c, err := Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestValidateAcceptsAndRejects(t *testing.T) {
	c := contract(t)
	ok := map[string]any{
		"DeviceGrid":   []map[string]any{{"id": "a", "platform": "android", "state": "ready", "extra": 1}},
		"TaskTimeline": map[string]any{"canceled": 2, "tasks": []map[string]any{{"id": "t", "kind": "dispatch", "status": "canceled"}}},
		"MetricChart":  map[string]any{"byDevice": nil, "maxParallelOk": 0},
		"ErrorCard":    map[string]any{"code": "permission_denied"},
		"CostConfirm":  map[string]any{"costVnd": 1.5, "leftVnd": "?", "token": "x", "scope": "tool"},
	}
	for kind, data := range ok {
		if err := c.Validate(kind, data); err != nil {
			t.Errorf("%s hợp lệ bị từ chối: %v", kind, err)
		}
	}
	bad := []struct {
		kind string
		data any
		want string
	}{
		{"DeviceGrid", []map[string]any{{"id": "a", "platform": "android"}}, "thiếu state"},
		{"DeviceGrid", []map[string]any{{"id": "a", "platform": "android", "state": "flying"}}, "không thuộc"},
		{"DeviceGrid", map[string]any{}, "cần kiểu"},
		{"TaskTimeline", map[string]any{"tasks": []any{}}, "không khớp dạng nào"},
		{"RunProgress", map[string]any{"id": "t", "kind": "dispatch", "status": "running", "passed": 1.5}, "không khớp"},
		{"ErrorCard", "lỗi", "cần kiểu"},
		{"Unknown", map[string]any{}, "không có trong hợp đồng"},
	}
	for _, b := range bad {
		err := c.Validate(b.kind, b.data)
		if err == nil || !strings.Contains(err.Error(), b.want) {
			t.Errorf("%s %v: err = %v, muốn chứa %q", b.kind, b.data, err, b.want)
		}
	}
}
