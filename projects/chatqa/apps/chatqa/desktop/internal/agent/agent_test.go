package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"chatqa/internal/components"
	"chatqa/internal/testengine"
	"chatqa/internal/tools"
	"chatqa/internal/tower/pool"
	"deskcore/apperr"
)

const secret = "Chat-S3cret-77"

var emptySchema = map[string]any{"type": "object", "properties": map[string]any{}, "required": []string{}, "additionalProperties": false}

type ranTools struct {
	mu    sync.Mutex
	names []string
}

func (r *ranTools) add(n string) { r.mu.Lock(); r.names = append(r.names, n); r.mu.Unlock() }

func testRegistry(ran *ranTools) *tools.Registry {
	return tools.NewRegistry(
		tools.Raw("tower_fleet", "máy", "", "DeviceGrid", emptySchema, func(context.Context, json.RawMessage) (any, error) {
			ran.add("tower_fleet")
			return []map[string]any{{"id": "emu-1", "state": "ready", "platform": "android"}}, nil
		}),
		tools.Raw("tower_health", "sức khoẻ", "", "MetricChart", emptySchema, func(context.Context, json.RawMessage) (any, error) {
			ran.add("tower_health")
			return map[string]any{"flows": 3, "successRate": 1.0}, nil
		}),
		tools.Raw("tower_pause_all", "dừng", "cqs.run", "TaskTimeline", emptySchema, func(context.Context, json.RawMessage) (any, error) {
			ran.add("tower_pause_all")
			return nil, apperr.New(apperr.CodePermissionDenied, "cqs.run")
		}),
		tools.Raw("device_screenshot", "ảnh", "", "LiveScreen", emptySchema, func(context.Context, json.RawMessage) (any, error) {
			ran.add("device_screenshot")
			return map[string]any{"deviceId": "emu-1", "png": "iVBORw0KGgo="}, nil
		}),
		tools.Raw("test_compile", "biên dịch", "cqs.run", "FlowList", emptySchema, func(context.Context, json.RawMessage) (any, error) {
			return nil, apperr.New("confirm_required", "costVnd=30000,leftVnd=120000,token=tok-1")
		}),
	)
}

// sse dựng chuỗi sự kiện stream của một câu trả lời.
type block struct {
	typ, text, name, id, input, thinking, sig string
}

func sse(stop string, u usage, blocks ...block) [][]byte {
	var ev []string
	ev = append(ev, fmt.Sprintf(`{"type":"message_start","message":{"model":"claude-sonnet-5-5","usage":{"input_tokens":%d,"cache_read_input_tokens":%d,"cache_creation_input_tokens":%d}}}`,
		u.InputTokens, u.CacheReadTokens, u.CacheCreationTokens))
	for i, b := range blocks {
		switch b.typ {
		case "text":
			ev = append(ev, fmt.Sprintf(`{"type":"content_block_start","index":%d,"content_block":{"type":"text","text":""}}`, i))
			for _, part := range strings.SplitAfter(b.text, " ") {
				p, _ := json.Marshal(part)
				ev = append(ev, fmt.Sprintf(`{"type":"content_block_delta","index":%d,"delta":{"type":"text_delta","text":%s}}`, i, p))
			}
		case "thinking":
			ev = append(ev, fmt.Sprintf(`{"type":"content_block_start","index":%d,"content_block":{"type":"thinking","thinking":""}}`, i))
			ev = append(ev, fmt.Sprintf(`{"type":"content_block_delta","index":%d,"delta":{"type":"signature_delta","signature":"%s"}}`, i, b.sig))
		case "tool_use":
			ev = append(ev, fmt.Sprintf(`{"type":"content_block_start","index":%d,"content_block":{"type":"tool_use","id":"%s","name":"%s","input":{}}}`, i, b.id, b.name))
			half := len(b.input) / 2
			for _, part := range []string{b.input[:half], b.input[half:]} {
				p, _ := json.Marshal(part)
				ev = append(ev, fmt.Sprintf(`{"type":"content_block_delta","index":%d,"delta":{"type":"input_json_delta","partial_json":%s}}`, i, p))
			}
		case "fallback":
			ev = append(ev, fmt.Sprintf(`{"type":"content_block_start","index":%d,"content_block":{"type":"fallback","from":{"model":"claude-sonnet-5-5"},"to":{"model":"claude-opus-5-5"}}}`, i))
		}
		ev = append(ev, fmt.Sprintf(`{"type":"content_block_stop","index":%d}`, i))
	}
	ev = append(ev, fmt.Sprintf(`{"type":"message_delta","delta":{"stop_reason":"%s"},"usage":{"output_tokens":%d}}`, stop, u.OutputTokens))
	ev = append(ev, `{"type":"message_stop"}`)
	out := make([][]byte, len(ev))
	for i, e := range ev {
		out[i] = []byte(e)
	}
	return out
}

type fakeStream struct {
	mu      sync.Mutex
	replies [][][]byte
	bodies  []map[string]any
}

func (f *fakeStream) stream(_ context.Context, body any, onEvent func([]byte) error) error {
	f.mu.Lock()
	raw, _ := json.Marshal(body)
	var b map[string]any
	json.Unmarshal(raw, &b)
	f.bodies = append(f.bodies, b)
	if len(f.replies) == 0 {
		f.mu.Unlock()
		return apperr.New("ai_unavailable", "hết câu trả lời giả")
	}
	r := f.replies[0]
	f.replies = f.replies[1:]
	f.mu.Unlock()
	for _, e := range r {
		if err := onEvent(e); err != nil {
			return err
		}
	}
	return nil
}

type events struct {
	mu   sync.Mutex
	list []Event
}

func (e *events) emit(ev Event) { e.mu.Lock(); e.list = append(e.list, ev); e.mu.Unlock() }

func (e *events) kinds() []string {
	var out []string
	for _, ev := range e.list {
		if ev.Type == "component" {
			out = append(out, ev.Kind)
		}
	}
	return out
}

func (e *events) text() string {
	var b strings.Builder
	for _, ev := range e.list {
		if ev.Type == "text" {
			b.WriteString(ev.Text)
		}
	}
	return b.String()
}

func newAgent(t *testing.T, fs *fakeStream, gate testengine.BudgetGate) (*Agent, *ranTools, *testengine.Metrics) {
	t.Helper()
	m, err := testengine.OpenMetrics(filepath.Join(t.TempDir(), "m.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { m.Close() })
	ran := &ranTools{}
	a := New(fs.stream, testRegistry(ran), gate, m)
	a.Secrets = func() []string { return []string{secret} }
	a.Context = func(context.Context) string { return "<context>Giờ: 2026-11-13 10:00. Máy rảnh: 1.</context>" }
	return a, ran, m
}

func TestToolLoopPassesContentBackUnchanged(t *testing.T) {
	fs := &fakeStream{replies: [][][]byte{
		sse("tool_use", usage{InputTokens: 900, CacheReadTokens: 4000, OutputTokens: 60},
			block{typ: "thinking", sig: "sig-abc"}, block{typ: "text", text: "Để tôi xem máy. "},
			block{typ: "tool_use", id: "tu1", name: "tower_fleet", input: `{}`}, block{typ: "tool_use", id: "tu2", name: "device_screenshot", input: `{}`}),
		sse("end_turn", usage{InputTokens: 50, CacheReadTokens: 5000, OutputTokens: 20}, block{typ: "text", text: "Có 1 máy rảnh."}),
	}}
	a, ran, m := newAgent(t, fs, nil)
	ev := &events{}
	if err := a.Send(context.Background(), "c1", "máy nào đang rảnh?", "", ev.emit); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(ev.kinds(), ","); got != "DeviceGrid,LiveScreen" {
		t.Fatalf("components = %s", got)
	}
	if ev.text() != "Để tôi xem máy. Có 1 máy rảnh." || ev.list[len(ev.list)-1].Type != "done" {
		t.Fatalf("text = %q", ev.text())
	}
	if strings.Join(ran.names, ",") != "tower_fleet,device_screenshot" {
		t.Fatalf("ran = %v", ran.names)
	}
	// Lần gọi thứ hai gửi lại nguyên lượt trả lời (kể cả thinking + signature) và mọi tool_result trong một tin nhắn.
	msgs := fs.bodies[1]["messages"].([]any)
	if len(msgs) != 3 {
		t.Fatalf("messages = %d", len(msgs))
	}
	asst := msgs[1].(map[string]any)["content"].([]any)
	if asst[0].(map[string]any)["type"] != "thinking" || asst[0].(map[string]any)["signature"] != "sig-abc" {
		t.Fatalf("thinking phải được gửi lại nguyên: %v", asst[0])
	}
	results := msgs[2].(map[string]any)["content"].([]any)
	if len(results) != 2 || results[0].(map[string]any)["tool_use_id"] != "tu1" {
		t.Fatalf("tool results = %v", results)
	}
	shot := results[1].(map[string]any)["content"].([]any)
	if shot[1].(map[string]any)["type"] != "image" || strings.Contains(shot[0].(map[string]any)["text"].(string), "iVBOR") {
		t.Fatalf("ảnh màn hình phải là khối ảnh, không nằm trong chữ: %v", shot)
	}
	rows, _ := m.Ledger(time.Time{}, 10)
	if len(rows) != 2 || rows[0].Purpose != "chat" || rows[1].CacheTokens != 4000 || rows[0].CostVnd <= 0 {
		t.Fatalf("ledger = %+v", rows)
	}
}

func TestRequestShapeCachingStrictToolsAndNoSecrets(t *testing.T) {
	fs := &fakeStream{replies: [][][]byte{
		sse("end_turn", usage{}, block{typ: "text", text: "ok"}),
		sse("end_turn", usage{}, block{typ: "text", text: "ok"}),
	}}
	a, _, _ := newAgent(t, fs, nil)
	a.Send(context.Background(), "c1", "mật khẩu là "+secret+" nhé, có bao nhiêu máy?", "", nil)
	a.Send(context.Background(), "c1", "chạy flow đăng nhập trên 3 máy", "", nil)
	b := fs.bodies[0]
	raw, _ := json.Marshal(fs.bodies)
	if strings.Contains(string(raw), secret) {
		t.Fatal("giá trị bí mật không được gửi cho Claude")
	}
	toolsList := b["tools"].([]any)
	last := toolsList[len(toolsList)-1].(map[string]any)
	if last["cache_control"] == nil || toolsList[0].(map[string]any)["strict"] != true {
		t.Fatalf("tools = %v", toolsList[0])
	}
	sys := b["system"].([]any)[0].(map[string]any)
	if sys["cache_control"] == nil || strings.Contains(sys["text"].(string), "2026-11-13") {
		t.Fatal("system prompt cố định có cache_control; giờ và thiết bị chỉ ở tin nhắn")
	}
	if b["tool_choice"].(map[string]any)["type"] != "auto" || b["fallbacks"] != "default" || b["stream"] != true || b["product"] != "chatqa" {
		t.Fatalf("body = %v", b)
	}
	if b["output_config"].(map[string]any)["effort"] != "low" || fs.bodies[1]["output_config"].(map[string]any)["effort"] != "medium" {
		t.Fatal("câu hỏi ngắn effort low, lệnh chạy effort medium")
	}
	// Danh sách tool cùng thứ tự giữa hai lần gọi (cache tiền tố).
	t0, _ := json.Marshal(b["tools"])
	t1, _ := json.Marshal(fs.bodies[1]["tools"])
	if string(t0) != string(t1) {
		t.Fatal("tool phải cố định thứ tự giữa các lần gọi")
	}
}

func TestStepCapRefusalAndPermission(t *testing.T) {
	loop := sse("tool_use", usage{}, block{typ: "tool_use", id: "x", name: "tower_health", input: `{}`})
	fs := &fakeStream{replies: [][][]byte{loop, loop, loop}}
	a, _, _ := newAgent(t, fs, nil)
	a.StepCap = 3
	ev := &events{}
	a.Send(context.Background(), "c1", "xem sức khoẻ", "", ev.emit)
	if k := ev.kinds(); len(k) != 4 || k[3] != "ErrorCard" || ev.list[len(ev.list)-2].Data.(map[string]string)["code"] != CodeStepCap {
		t.Fatalf("step cap: %v", k)
	}

	fs2 := &fakeStream{replies: [][][]byte{sse("refusal", usage{}, block{typ: "text", text: "Không."})}}
	a2, _, _ := newAgent(t, fs2, nil)
	ev2 := &events{}
	a2.Send(context.Background(), "c2", "làm 1000 tài khoản ảo", "", ev2.emit)
	if k := ev2.kinds(); len(k) != 1 || k[0] != "ErrorCard" || ev2.list[len(ev2.list)-2].Data.(map[string]string)["code"] != testengine.CodeLLMRefused {
		t.Fatalf("refusal: %v", k)
	}

	fs3 := &fakeStream{replies: [][][]byte{
		sse("tool_use", usage{}, block{typ: "tool_use", id: "p1", name: "tower_pause_all", input: `{}`}),
		sse("end_turn", usage{}, block{typ: "text", text: "Bạn chưa có quyền."}),
	}}
	a3, _, _ := newAgent(t, fs3, nil)
	ev3 := &events{}
	a3.Send(context.Background(), "c3", "dừng hết đi", "", ev3.emit)
	errCard := ev3.list[0]
	if errCard.Kind != "ErrorCard" || errCard.Data.(map[string]string)["code"] != apperr.CodePermissionDenied {
		t.Fatalf("thiếu quyền phải hiện ErrorCard: %+v", ev3.list)
	}
	res := fs3.bodies[1]["messages"].([]any)[2].(map[string]any)["content"].([]any)[0].(map[string]any)
	if res["is_error"] != true {
		t.Fatalf("tool_result lỗi phải có is_error: %v", res)
	}
}

type gate struct{ calls []string }

func (g *gate) Allow(op testengine.PaidOp, token string) error {
	g.calls = append(g.calls, token)
	if token != "tok-chat" {
		return apperr.New("confirm_required", "costVnd=25000,leftVnd=90000,token=tok-chat")
	}
	return nil
}

func TestConfirmOnceThenContinue(t *testing.T) {
	fs := &fakeStream{replies: [][][]byte{sse("end_turn", usage{}, block{typ: "text", text: "Xong."})}}
	g := &gate{}
	a, _, _ := newAgent(t, fs, g)
	ev := &events{}
	a.Send(context.Background(), "c1", "phân tích toàn bộ lịch sử chạy", "", ev.emit)
	if len(fs.bodies) != 0 || len(ev.kinds()) != 1 || ev.kinds()[0] != "CostConfirm" {
		t.Fatalf("phải hỏi xác nhận trước khi gọi Claude: %v", ev.kinds())
	}
	d := ev.list[0].Data.(map[string]any)
	if d["token"] != "tok-chat" || d["costVnd"] != 25000.0 || d["leftVnd"] != "90000" || d["scope"] != "chat" {
		t.Fatalf("CostConfirm = %v", d)
	}
	ev2 := &events{}
	if err := a.Send(context.Background(), "c1", "", "tok-chat", ev2.emit); err != nil {
		t.Fatal(err)
	}
	if ev2.text() != "Xong." || len(fs.bodies) != 1 {
		t.Fatalf("sau xác nhận phải chạy tiếp: %q", ev2.text())
	}
	// Tool trả confirm_required: thẻ CostConfirm kèm tool và tham số để chạy lại với mã.
	fs2 := &fakeStream{replies: [][][]byte{
		sse("tool_use", usage{}, block{typ: "tool_use", id: "c", name: "test_compile", input: `{"app":"demo"}`}),
		sse("end_turn", usage{}, block{typ: "text", text: "Cần xác nhận."}),
	}}
	a2, _, _ := newAgent(t, fs2, nil)
	ev3 := &events{}
	a2.Send(context.Background(), "c2", "biên dịch PRD", "", ev3.emit)
	cc := ev3.list[0].Data.(map[string]any)
	if ev3.list[0].Kind != "CostConfirm" || cc["tool"] != "test_compile" || cc["token"] != "tok-1" || cc["scope"] != "tool" {
		t.Fatalf("tool CostConfirm = %+v", ev3.list[0])
	}
}

func TestFallbackBoundaryDropsEarlierModelBlocks(t *testing.T) {
	fs := &fakeStream{replies: [][][]byte{
		sse("tool_use", usage{},
			block{typ: "thinking", sig: "old"}, block{typ: "text", text: "Đang "}, block{typ: "tool_use", id: "old", name: "tower_pause_all", input: `{}`},
			block{typ: "fallback"}, block{typ: "tool_use", id: "new", name: "tower_fleet", input: `{}`}),
		sse("end_turn", usage{}, block{typ: "text", text: "ok"}),
	}}
	a, ran, _ := newAgent(t, fs, nil)
	a.Send(context.Background(), "c1", "máy?", "", nil)
	if strings.Join(ran.names, ",") != "tower_fleet" {
		t.Fatalf("chỉ chạy tool sau ranh giới fallback: %v", ran.names)
	}
	asst := fs.bodies[1]["messages"].([]any)[1].(map[string]any)["content"].([]any)
	var types []string
	for _, b := range asst {
		types = append(types, b.(map[string]any)["type"].(string))
	}
	if strings.Join(types, ",") != "text,fallback,tool_use" {
		t.Fatalf("khối gửi lại = %v", types)
	}
}

func TestResolverShortCommands(t *testing.T) {
	r := &Resolver{
		Fleet: func() []pool.Device { return []pool.Device{{ID: "R58N123", Name: "Galaxy test"}} },
		Flows: func() map[string][]string {
			return map[string][]string{"mexpress": {"01_login_check_info.yaml", "02_home.yaml"}, "ops": {"01_ops_login.yaml"}}
		},
	}
	cases := map[string]string{
		"dừng tất cả":                    "tower_pause_all",
		"Stop all":                       "tower_pause_all",
		"máy":                            "tower_fleet",
		"r58n123":                        "tower_device_report",
		"Galaxy test":                    "tower_device_report",
		"chạy check_info trên 3 android": "tower_dispatch",
		"run 02_home on 2":               "tower_dispatch",
	}
	for text, want := range cases {
		c, ok := r.Resolve(text)
		if !ok || c.Tool != want {
			t.Errorf("%q: %v %v", text, c.Tool, ok)
		}
	}
	c, _ := r.Resolve("chạy check_info trên 3 android")
	var args map[string]any
	json.Unmarshal(c.Args, &args)
	if args["app"] != "mexpress" || args["filter"].(map[string]any)["count"] != 3.0 || args["filter"].(map[string]any)["platform"] != "android" {
		t.Fatalf("dispatch args = %v", args)
	}
	for _, text := range []string{"chạy login trên 3 android", "máy nào nhanh nhất tuần này?", "chạy flow đăng nhập trên 3 máy, báo p95"} {
		if _, ok := r.Resolve(text); ok {
			t.Errorf("%q phải để chat xử lý (mơ hồ hoặc không phải lệnh ngắn)", text)
		}
	}
}

func TestHistoryKeepsOnlyWhatUserSaw(t *testing.T) {
	h, err := OpenHistory(filepath.Join(t.TempDir(), "chat.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	now := time.Now()
	c, _ := h.Create("u1", "Thử", now)
	rec := NewRecorder(func() time.Time { return now })
	for _, e := range []Event{{Type: "text", Text: "Đang "}, {Type: "text", Text: "xem"}, {Type: "component", Kind: "LiveScreen",
		Data: map[string]any{"deviceId": "emu-1", "png": "iVBOR", "note": secret}}, {Type: "text", Text: "Xong"}, {Type: "done"}} {
		rec.Add(e)
	}
	h.Add(c.ID, Item{At: now, Role: "user", Text: "mật khẩu " + secret}, []string{secret})
	for _, it := range rec.Items() {
		h.Add(c.ID, it, []string{secret})
	}
	items, _ := h.Items(c.ID)
	if len(items) != 4 || items[1].Text != "Đang xem" || items[2].Kind != "LiveScreen" || items[3].Text != "Xong" {
		t.Fatalf("items = %+v", items)
	}
	all, _ := json.Marshal(items)
	if strings.Contains(string(all), secret) || strings.Contains(string(all), "iVBOR") {
		t.Fatalf("lịch sử không được giữ bí mật hay ảnh: %s", all)
	}
	if err := h.Owned("u2", c.ID); apperr.CodeOf(err) != apperr.CodeNotFound {
		t.Fatal("người khác không đọc được cuộc chat")
	}
}

func TestAgentCardsMatchContract(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "..", "contracts", "cqs-components.json"))
	if err != nil {
		t.Fatal(err)
	}
	c, _ := components.Parse(raw)
	errCard := errorEvent(apperr.New(apperr.CodePermissionDenied, "cqs.run"))
	confirm := confirmData(apperr.New("confirm_required", "costVnd=30000,leftVnd=?,token=t1"), map[string]any{"scope": "chat", "conversationId": "c1"})
	for kind, data := range map[string]any{errCard.Kind: errCard.Data, "CostConfirm": confirm} {
		if err := c.Validate(kind, data); err != nil {
			t.Errorf("%s: %v", kind, err)
		}
	}
}
