package testengine

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"deskcore/apperr"
)

func newTestMetrics(t *testing.T) *Metrics {
	t.Helper()
	m, err := OpenMetrics(filepath.Join(t.TempDir(), "testengine.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { m.Close() })
	return m
}

func TestStructuredLLMJournalsRedactedCappedBodies(t *testing.T) {
	m := newTestMetrics(t)
	reply := `{"ok":"` + secretPassword + strings.Repeat("x", LLMBodyCap) + `"}`
	call := func(_ context.Context, _, out any) error {
		raw, _ := json.Marshal(map[string]any{
			"content":     []map[string]any{{"type": "text", "text": reply}},
			"stop_reason": "end_turn",
			"usage":       map[string]int{"input_tokens": 10, "output_tokens": 5},
			"billing":     map[string]any{"model": "sonnet", "costVnd": 1.0, "budgetLeftVnd": 9.0},
		})
		return json.Unmarshal(raw, out)
	}
	c := newLLMClient(func() LLMCall { return call }, m, 0, time.Now, func() []string { return []string{secretPassword} })
	var out map[string]string
	err := c.structured(context.Background(), "demo", "01.yaml", "repair", "medium", "SYSTEM", "prompt có "+secretPassword,
		obj(map[string]any{"ok": str()}), 100, &out)
	if err != nil {
		t.Fatal(err)
	}
	list, err := m.Ledger(time.Time{}, 10)
	if err != nil || len(list) != 1 {
		t.Fatalf("ledger = %v %v", list, err)
	}
	if list[0].Request != "" || list[0].Response != "" {
		t.Fatal("danh sách sổ không được trả nội dung")
	}
	full, err := m.LLMCall(list[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(full.Request, "SYSTEM\n\nprompt có ***") || strings.Contains(full.Request, secretPassword) {
		t.Fatalf("request = %q", full.Request)
	}
	if strings.Contains(full.Response, secretPassword) || len(full.Response) > LLMBodyCap+64 || !strings.Contains(full.Response, "đã cắt") {
		t.Fatalf("response dài %d, chưa che/cắt", len(full.Response))
	}
	if full.LatencyMs < 0 || full.Purpose != "repair" {
		t.Fatalf("entry = %+v", full)
	}

	// Lỗi khi gọi: có hàng với error đã che, không có response.
	failing := func(context.Context, any, any) error { return errors.New("mất kết nối " + secretPassword) }
	c2 := newLLMClient(func() LLMCall { return failing }, m, 0, time.Now, func() []string { return []string{secretPassword} })
	if err := c2.structured(context.Background(), "demo", "f", "compile", "low", "S", "P", obj(map[string]any{}), 10, &out); err == nil {
		t.Fatal("muốn lỗi")
	}
	list, _ = m.Ledger(time.Time{}, 10)
	e, _ := m.LLMCall(list[0].ID)
	if e.Error != "mất kết nối ***" || e.Response != "" || e.Request != "S\n\nP" {
		t.Fatalf("entry lỗi = %+v", e)
	}
	if _, err := m.LLMCall(9999); apperr.CodeOf(err) != apperr.CodeNotFound {
		t.Fatalf("not found: %v", err)
	}
}

func TestJournalJSONDropsImagesRedactsAndCaps(t *testing.T) {
	data := map[string]any{"kind": "LiveScreen", "data": map[string]any{"png": strings.Repeat("A", 5000), "tree": "pw=" + secretPassword},
		"blocks": []any{map[string]any{"type": "image", "source": map[string]any{"type": "base64", "data": "QUJD"}}}}
	got := JournalJSON(data, []string{secretPassword}, ToolBodyCap)
	if strings.Contains(got, "AAAA") || strings.Contains(got, "QUJD") || strings.Contains(got, secretPassword) {
		t.Fatalf("chưa bỏ ảnh/che: %s", got)
	}
	if !strings.Contains(got, "pw=***") || !strings.Contains(got, "không lưu") {
		t.Fatalf("got = %s", got)
	}
	big := JournalJSON(json.RawMessage(`{"yaml":"`+strings.Repeat("é", ToolBodyCap)+`"}`), nil, ToolBodyCap)
	if len(big) > ToolBodyCap+64 || !strings.Contains(big, "đã cắt") {
		t.Fatalf("chưa cắt: %d", len(big))
	}
	if s := capText("ééé", 3); s != "é…[đã cắt 4 byte]" {
		t.Fatalf("capText cắt giữa ký tự: %q", s)
	}
}

func TestToolCallsAndUsageEvents(t *testing.T) {
	m := newTestMetrics(t)
	now := time.Now()
	if err := m.RecordToolCall(ToolCall{At: now, Source: ToolSourceMCP, Tool: "tower_fleet", Args: "{}", DurationMs: 3}); err != nil {
		t.Fatal(err)
	}
	calls, err := m.ToolCalls(time.Time{}, 10)
	if err != nil || len(calls) != 1 || calls[0].Source != "mcp" || calls[0].ID == 0 {
		t.Fatalf("tool calls = %+v %v", calls, err)
	}
	for _, bad := range []string{"", "Page.View", "a b", strings.Repeat("a", 65), "1page"} {
		if err := m.RecordUsage(now, bad, nil, nil); apperr.CodeOf(err) != apperr.CodeInvalid {
			t.Errorf("kind %q: %v", bad, err)
		}
	}
	if err := m.RecordUsage(now, "page_view", map[string]any{"x": strings.Repeat("a", UsageMaxSize)}, nil); apperr.CodeOf(err) != apperr.CodeInvalid {
		t.Fatalf("detail quá lớn: %v", err)
	}
	if err := m.RecordUsage(now, "page_view", map[string]any{"page": "testing", "q": secretPassword}, []string{secretPassword}); err != nil {
		t.Fatal(err)
	}
	evs, err := m.UsageEvents(time.Time{}, 10)
	if err != nil || len(evs) != 1 || evs[0].Kind != "page_view" {
		t.Fatalf("usage = %+v %v", evs, err)
	}
	if strings.Contains(string(evs[0].Detail), secretPassword) || !strings.Contains(string(evs[0].Detail), `"page":"testing"`) {
		t.Fatalf("detail = %s", evs[0].Detail)
	}
}
