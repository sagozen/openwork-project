// Package agent: chat của ChatQASoftware. Vòng lặp gửi hội thoại và danh mục tool tới Claude Sonnet 5.5 qua Worker
// (Messages API, stream), chạy tool qua danh mục chung (cùng quyền, ngân sách, nhật ký như MCP) và trả kết quả thành
// component cho giao diện.
package agent

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

// usage: token của một lần gọi (Messages API).
type usage struct {
	InputTokens         int `json:"input_tokens"`
	OutputTokens        int `json:"output_tokens"`
	CacheReadTokens     int `json:"cache_read_input_tokens"`
	CacheCreationTokens int `json:"cache_creation_input_tokens"`
}

// streamed: câu trả lời đã ghép từ các sự kiện SSE. Khối nội dung giữ nguyên mọi trường (thinking kèm signature,
// khối lạ) để gửi lại không đổi ở lượt sau.
type streamed struct {
	blocks     map[int]map[string]any
	partial    map[int]*strings.Builder // tool_use: input JSON đang ghép
	stopReason string
	model      string
	usage      usage
	err        string // sự kiện "error" giữa stream
}

func newStreamed() *streamed {
	return &streamed{blocks: map[int]map[string]any{}, partial: map[int]*strings.Builder{}}
}

// add xử lý một sự kiện; onText nhận chữ mới của khối text để hiện dần.
func (s *streamed) add(data []byte, onText func(string)) error {
	var ev struct {
		Type    string          `json:"type"`
		Index   int             `json:"index"`
		Message json.RawMessage `json:"message"`
		Block   map[string]any  `json:"content_block"`
		Delta   json.RawMessage `json:"delta"`
		Usage   *usage          `json:"usage"`
		Error   *struct {
			Type    string `json:"type"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(data, &ev); err != nil {
		return fmt.Errorf("sự kiện stream không hợp lệ: %w", err)
	}
	switch ev.Type {
	case "message_start":
		var m struct {
			Model string `json:"model"`
			Usage usage  `json:"usage"`
		}
		_ = json.Unmarshal(ev.Message, &m)
		s.model = m.Model
		s.usage.InputTokens += m.Usage.InputTokens
		s.usage.CacheReadTokens += m.Usage.CacheReadTokens
		s.usage.CacheCreationTokens += m.Usage.CacheCreationTokens
		s.usage.OutputTokens += m.Usage.OutputTokens
	case "content_block_start":
		s.blocks[ev.Index] = ev.Block
		if ev.Block["type"] == "tool_use" {
			s.partial[ev.Index] = &strings.Builder{}
		}
	case "content_block_delta":
		b := s.blocks[ev.Index]
		if b == nil {
			return nil
		}
		var d struct {
			Type        string `json:"type"`
			Text        string `json:"text"`
			PartialJSON string `json:"partial_json"`
			Thinking    string `json:"thinking"`
			Signature   string `json:"signature"`
		}
		_ = json.Unmarshal(ev.Delta, &d)
		switch d.Type {
		case "text_delta":
			b["text"] = str(b["text"]) + d.Text
			if onText != nil && d.Text != "" {
				onText(d.Text)
			}
		case "input_json_delta":
			if p := s.partial[ev.Index]; p != nil {
				p.WriteString(d.PartialJSON)
			}
		case "thinking_delta":
			b["thinking"] = str(b["thinking"]) + d.Thinking
		case "signature_delta":
			b["signature"] = str(b["signature"]) + d.Signature
		}
	case "content_block_stop":
		if p := s.partial[ev.Index]; p != nil {
			raw := strings.TrimSpace(p.String())
			if raw == "" {
				raw = "{}"
			}
			var input any
			if err := json.Unmarshal([]byte(raw), &input); err != nil {
				input = map[string]any{} // tham số hỏng: tool sẽ báo lỗi tham số
			}
			s.blocks[ev.Index]["input"] = input
			delete(s.partial, ev.Index)
		}
	case "message_delta":
		var d struct {
			StopReason string `json:"stop_reason"`
		}
		_ = json.Unmarshal(ev.Delta, &d)
		if d.StopReason != "" {
			s.stopReason = d.StopReason
		}
		if ev.Usage != nil {
			s.usage.OutputTokens = max(s.usage.OutputTokens, ev.Usage.OutputTokens)
		}
	case "error":
		if ev.Error != nil {
			s.err = ev.Error.Type + ": " + ev.Error.Message
		}
	}
	return nil
}

// content: các khối theo thứ tự index.
func (s *streamed) content() []map[string]any {
	idx := make([]int, 0, len(s.blocks))
	for i := range s.blocks {
		idx = append(idx, i)
	}
	sort.Ints(idx)
	out := make([]map[string]any, 0, len(idx))
	for _, i := range idx {
		out = append(out, s.blocks[i])
	}
	return out
}

// afterFallback áp luật gửi lại sau khi chuyển mô hình dự phòng giữa chừng: các khối thinking, redacted_thinking,
// tool_use và khối nội bộ lạ đứng trước khối fallback cuối cùng bị bỏ (chữ giữ lại); khối sau ranh giới giữ nguyên.
// Tool chỉ chạy theo khối tool_use sau ranh giới.
func afterFallback(blocks []map[string]any) []map[string]any {
	last := -1
	for i, b := range blocks {
		if b["type"] == "fallback" {
			last = i
		}
	}
	if last < 0 {
		return blocks
	}
	out := make([]map[string]any, 0, len(blocks))
	for i, b := range blocks {
		if i < last && b["type"] != "text" && b["type"] != "fallback" {
			continue
		}
		out = append(out, b)
	}
	return out
}

func str(v any) string {
	s, _ := v.(string)
	return s
}
