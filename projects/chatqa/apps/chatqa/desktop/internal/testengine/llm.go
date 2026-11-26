package testengine

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"deskcore/apperr"
)

// Mọi bước LLM của engine (tách ca, sinh YAML, sửa) gọi Claude Sonnet 5.5 qua Worker POST /v1/ai/messages.
// Worker giữ khoá API, chọn mô hình theo cài đặt sản phẩm chatqa, chặn theo ngân sách tháng và trả chi phí.
// Engine thêm: trần token cho mỗi flow, sổ ghi từng lần gọi (SQLite), và không bao giờ gửi giá trị bí mật.

// Các trường Messages API engine dùng. Worker chỉ chuyển tiếp các trường trong danh sách cho phép.
type llmMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type llmFormat struct {
	Type   string         `json:"type"` // json_schema
	Schema map[string]any `json:"schema"`
}

type llmOutputConfig struct {
	Effort string     `json:"effort,omitempty"`
	Format *llmFormat `json:"format,omitempty"`
}

type llmRequest struct {
	Product      string          `json:"product"`
	System       string          `json:"system,omitempty"`
	Messages     []llmMessage    `json:"messages"`
	MaxTokens    int             `json:"max_tokens"`
	OutputConfig llmOutputConfig `json:"output_config"`
	// Bị từ chối vì an toàn thì Worker/API tự chạy lại trên mô hình dự phòng theo loại từ chối.
	Fallbacks string   `json:"fallbacks,omitempty"`
	Betas     []string `json:"betas,omitempty"`
}

type llmResponse struct {
	Content []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"content"`
	StopReason string `json:"stop_reason"`
	Usage      struct {
		InputTokens         int `json:"input_tokens"`
		OutputTokens        int `json:"output_tokens"`
		CacheReadTokens     int `json:"cache_read_input_tokens"`
		CacheCreationTokens int `json:"cache_creation_input_tokens"`
	} `json:"usage"`
	Billing struct {
		Model         string  `json:"model"`
		CostVnd       float64 `json:"costVnd"`
		BudgetLeftVnd float64 `json:"budgetLeftVnd"`
	} `json:"billing"`
}

func (r *llmResponse) text() string {
	var b strings.Builder
	for _, c := range r.Content {
		if c.Type == "text" {
			b.WriteString(c.Text)
		}
	}
	return b.String()
}

func (r *llmResponse) tokens() int {
	return r.Usage.InputTokens + r.Usage.OutputTokens + r.Usage.CacheReadTokens + r.Usage.CacheCreationTokens
}

// LLMCall: gọi Worker; trong app là ModuleDeps.AIMessages, trong test là hàm giả.
type LLMCall func(ctx context.Context, body, out any) error

const (
	CodeLLMTokenCap = "llm_token_cap" // flow đã dùng hết trần token cho lần biên dịch/sửa này
	CodeLLMRefused  = "llm_refused"   // mô hình (cả dự phòng) từ chối
	CodeLLMBadReply = "llm_bad_reply" // câu trả lời không đúng định dạng JSON đã yêu cầu

	// Trần mặc định cho một flow trong một lần biên dịch hoặc sửa (vào + ra, gồm cache).
	DefaultFlowTokenCap = 120_000
)

// LedgerEntry: một lần gọi LLM, ghi vào sổ để xem chi phí và chứng minh lượt chạy YAML không tốn token.
type LedgerEntry struct {
	ID           int64     `json:"id"` // rowid trong sổ, cho LLMCall
	At           time.Time `json:"at"`
	App          string    `json:"app"`
	Flow         string    `json:"flow"`    // flow hoặc ca kiểm thử liên quan; trống khi tách ca
	Purpose      string    `json:"purpose"` // split | compile | repair
	Effort       string    `json:"effort"`
	Model        string    `json:"model"`
	InputTokens  int       `json:"inputTokens"`
	OutputTokens int       `json:"outputTokens"`
	CacheTokens  int       `json:"cacheTokens"`
	CostVnd      float64   `json:"costVnd"`
	// BudgetLeftVnd: ngân sách tháng còn lại của công ty theo Worker sau lần gọi này; -1 = không rõ (lỗi, mất kết nối).
	BudgetLeftVnd float64 `json:"budgetLeftVnd"`
	StopReason    string  `json:"stopReason"`
	LatencyMs     int64   `json:"latencyMs"`
	Error         string  `json:"error,omitempty"`  // lỗi khi gọi (đã che bí mật)
	ConvID        string  `json:"convId,omitempty"` // cuộc chat (purpose chat)
	// Request/Response: nội dung đã che bí mật, tối đa LLMBodyCap. Chỉ có trong LLMCall và gói xuất, danh sách sổ không trả.
	Request  string `json:"request,omitempty"`
	Response string `json:"response,omitempty"`
}

// PaidOp: một thao tác tốn tiền, trước khi làm (M1: một lần biên dịch hoặc sửa bằng LLM).
type PaidOp struct {
	Kind    string  `json:"kind"`    // llm.compile | llm.repair
	Subject string  `json:"subject"` // app/flow: mã xác nhận chỉ dùng cho đúng việc này
	CostVnd float64 `json:"costVnd"` // ước tính
}

// BudgetGate: cổng ngân sách của tháp. nil = không chặn ở máy (Worker vẫn chặn theo ngân sách tháng).
type BudgetGate interface {
	Allow(op PaidOp, confirmToken string) error
}

// Giá Claude Sonnet 5.5 (USD/1M token) và tỷ giá mặc định của Worker, chỉ để ước tính trước khi gọi.
const (
	sonnetInUSDPerM  = 2.0
	sonnetOutUSDPerM = 10.0
	usdVnd           = 26500.0
)

// EstimateVnd: chi phí ước tính cho số token vào/ra.
func EstimateVnd(inTokens, outTokens int) float64 {
	return (float64(inTokens)*sonnetInUSDPerM + float64(outTokens)*sonnetOutUSDPerM) / 1e6 * usdVnd
}

func (e *Engine) allow(op PaidOp, token string) error {
	if e.Budget == nil {
		return nil
	}
	return e.Budget.Allow(op, token)
}

// llmClient: gọi có trần token theo flow và ghi sổ.
type llmClient struct {
	call    func() LLMCall
	metrics *Metrics
	secrets func() []string // giá trị bí mật để che nội dung ghi sổ; nil = không che
	cap     int
	now     func() time.Time

	mu   sync.Mutex
	used map[string]int // flow + ngày -> token đã dùng (trần theo flow mỗi ngày, qua mọi lần biên dịch/sửa)
}

func newLLMClient(call func() LLMCall, m *Metrics, cap int, now func() time.Time, secrets func() []string) *llmClient {
	if cap <= 0 {
		cap = DefaultFlowTokenCap
	}
	return &llmClient{call: call, metrics: m, cap: cap, now: now, secrets: secrets, used: map[string]int{}}
}

func (c *llmClient) secretValues() []string {
	if c.secrets == nil {
		return nil
	}
	return c.secrets()
}

// structured gọi mô hình với một lời nhắn và schema JSON, giải mã câu trả lời vào out.
func (c *llmClient) structured(ctx context.Context, app, flow, purpose, effort, system, prompt string,
	schema map[string]any, maxTokens int, out any) error {
	call := c.call()
	if call == nil {
		return apperr.New("ai_unavailable", "chưa nối dịch vụ AI")
	}
	key := app + "/" + flow + "@" + c.now().Format("2006-01-02")
	c.mu.Lock()
	if c.used[key] >= c.cap {
		c.mu.Unlock()
		return apperr.New(CodeLLMTokenCap, fmt.Sprintf("%s đã dùng %d/%d token hôm nay", flow, c.used[key], c.cap))
	}
	c.mu.Unlock()

	req := llmRequest{
		Product:      "chatqa",
		System:       system,
		Messages:     []llmMessage{{Role: "user", Content: prompt}},
		MaxTokens:    maxTokens,
		OutputConfig: llmOutputConfig{Effort: effort, Format: &llmFormat{Type: "json_schema", Schema: schema}},
		Fallbacks:    "default",
		Betas:        []string{"server-side-fallback-2026-07-01"},
	}
	var res llmResponse
	start := time.Now()
	err := call(ctx, req, &res)
	latency := time.Since(start).Milliseconds()
	var secrets []string
	if c.metrics != nil {
		secrets = c.secretValues()
	}
	request := JournalText(system+"\n\n"+prompt, secrets, LLMBodyCap)
	if err != nil {
		// Worker có thể đã tính tiền dù máy không nhận được câu trả lời (vd hết giờ chờ): ghi lại để thấy trong sổ.
		if c.metrics != nil {
			_ = c.metrics.RecordLLM(LedgerEntry{At: c.now(), App: app, Flow: flow, Purpose: purpose, Effort: effort,
				BudgetLeftVnd: -1, StopReason: "error: " + apperr.CodeOf(err), LatencyMs: latency, Request: request,
				Error: JournalText(err.Error(), secrets, LLMBodyCap)})
		}
		return err
	}
	c.mu.Lock()
	c.used[key] += res.tokens()
	c.mu.Unlock()
	if c.metrics != nil {
		_ = c.metrics.RecordLLM(LedgerEntry{At: c.now(), App: app, Flow: flow, Purpose: purpose, Effort: effort,
			Model: res.Billing.Model, InputTokens: res.Usage.InputTokens, OutputTokens: res.Usage.OutputTokens,
			CacheTokens: res.Usage.CacheReadTokens + res.Usage.CacheCreationTokens, CostVnd: res.Billing.CostVnd,
			BudgetLeftVnd: res.Billing.BudgetLeftVnd, StopReason: res.StopReason, LatencyMs: latency, Request: request,
			Response: JournalText(res.text(), secrets, LLMBodyCap)})
	}
	switch res.StopReason {
	case "refusal":
		return apperr.New(CodeLLMRefused, purpose)
	case "max_tokens":
		return apperr.New(CodeLLMBadReply, "câu trả lời bị cắt vì quá dài")
	}
	if err := json.Unmarshal([]byte(res.text()), out); err != nil {
		return apperr.Wrap(CodeLLMBadReply, err)
	}
	return nil
}

// obj: schema đối tượng JSON với mọi trường bắt buộc và không cho trường lạ (yêu cầu của structured outputs).
func obj(props map[string]any) map[string]any {
	req := make([]string, 0, len(props))
	for k := range props {
		req = append(req, k)
	}
	sort.Strings(req)
	return map[string]any{"type": "object", "properties": props, "required": req, "additionalProperties": false}
}

func str() map[string]any { return map[string]any{"type": "string"} }

func arr(items map[string]any) map[string]any { return map[string]any{"type": "array", "items": items} }
