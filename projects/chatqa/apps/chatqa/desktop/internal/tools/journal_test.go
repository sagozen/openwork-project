package tools

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"chatqa/internal/testengine"
	"deskcore/apperr"
)

func TestRegistryJournalsSourceRedactsAndDropsImages(t *testing.T) {
	const pw = "Tool-S3cret-42"
	schema := map[string]any{"type": "object"}
	r := NewRegistry(
		Raw("shot", "ảnh", "", "LiveScreen", schema, func(context.Context, json.RawMessage) (any, error) {
			return screen{DeviceID: "emu-1", PNG: strings.Repeat("A", 4000), Tree: "ô nhập " + pw}, nil
		}),
		Raw("boom", "lỗi", "", "ErrorCard", schema, func(context.Context, json.RawMessage) (any, error) {
			return nil, apperr.New("confirm_required", "costVnd=1,token=abc123 "+pw)
		}),
		Raw("big", "dài", "", "FlowList", schema, func(context.Context, json.RawMessage) (any, error) {
			return map[string]string{"yaml": strings.Repeat("x", testengine.ToolBodyCap*2)}, nil
		}),
	)
	r.Secrets = func() []string { return []string{pw} }
	var got []testengine.ToolCall
	r.Journal = func(c testengine.ToolCall) { got = append(got, c) }

	if _, err := r.Call(WithSource(context.Background(), testengine.ToolSourceMCP), "shot", json.RawMessage(`{"q":"`+pw+`"}`)); err != nil {
		t.Fatal(err)
	}
	_, _ = r.Call(WithSource(context.Background(), testengine.ToolSourceUI), "boom", nil)
	_, _ = r.Call(context.Background(), "big", nil)
	_, _ = r.Call(context.Background(), "missing", nil)
	if len(got) != 4 {
		t.Fatalf("journal = %d hàng", len(got))
	}
	shot := got[0]
	if shot.Source != "mcp" || strings.Contains(shot.Args+shot.Result, pw) || strings.Contains(shot.Result, "AAAA") ||
		!strings.Contains(shot.Args, "***") || !strings.Contains(shot.Result, "ô nhập ***") {
		t.Fatalf("shot = %+v", shot)
	}
	boom := got[1]
	if boom.Source != "ui" || boom.ErrorCode != "confirm_required" || strings.Contains(boom.Error, pw) || strings.Contains(boom.Error, "abc123") {
		t.Fatalf("boom = %+v", boom)
	}
	if got[2].Source != "unknown" || len(got[2].Result) > testengine.ToolBodyCap+64 {
		t.Fatalf("big: nguồn %q, dài %d", got[2].Source, len(got[2].Result))
	}
	if got[3].ErrorCode != apperr.CodeNotFound || got[3].Tool != "missing" {
		t.Fatalf("missing = %+v", got[3])
	}
}
