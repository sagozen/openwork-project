package agent

import (
	"context"
	"strings"
	"testing"
	"time"

	"chatqa/internal/testengine"
)

// Sổ LLM của chat: mỗi lần gọi chỉ ghi tin nhắn mới (không cả lịch sử), câu trả lời là các khối nội dung, ảnh base64
// của tool_result không vào sổ, và sổ tool ghi nguồn chat.
func TestChatLLMJournalOnlyNewMessages(t *testing.T) {
	fs := &fakeStream{replies: [][][]byte{
		sse("tool_use", usage{InputTokens: 10}, block{typ: "text", text: "xem máy "}, block{typ: "tool_use", id: "tu1", name: "device_screenshot", input: `{}`}),
		sse("end_turn", usage{InputTokens: 10}, block{typ: "text", text: "xong"}),
	}}
	a, _, m := newAgent(t, fs, nil)
	var calls []testengine.ToolCall
	a.Registry.Journal = func(c testengine.ToolCall) { calls = append(calls, c) }
	if err := a.Send(context.Background(), "c9", "chụp màn hình, mật khẩu "+secret, "", nil); err != nil {
		t.Fatal(err)
	}
	rows, err := m.Ledger(time.Time{}, 10)
	if err != nil || len(rows) != 2 {
		t.Fatalf("ledger = %+v %v", rows, err)
	}
	first, _ := m.LLMCall(rows[1].ID)
	second, _ := m.LLMCall(rows[0].ID)
	if first.ConvID != "c9" || !strings.Contains(first.Request, "chụp màn hình") || !strings.Contains(first.Response, "tool_use") {
		t.Fatalf("lần 1 = %+v", first)
	}
	if strings.Contains(second.Request, "chụp màn hình") || !strings.Contains(second.Request, "tool_result") {
		t.Fatalf("lần 2 phải chỉ có tool_result mới: %s", second.Request)
	}
	if strings.Contains(second.Request, "iVBORw0KGgo=") || !strings.Contains(second.Response, "xong") {
		t.Fatalf("ảnh base64 lọt vào sổ hoặc thiếu phản hồi: %s", second.Request)
	}
	for _, e := range []testengine.LedgerEntry{first, second} {
		if strings.Contains(e.Request+e.Response, secret) || e.LatencyMs < 0 {
			t.Fatalf("sổ lộ bí mật: %+v", e)
		}
	}
	if len(calls) != 1 || calls[0].Source != testengine.ToolSourceChat || calls[0].Tool != "device_screenshot" ||
		strings.Contains(calls[0].Result, "iVBORw0KGgo=") {
		t.Fatalf("sổ tool = %+v", calls)
	}
}
