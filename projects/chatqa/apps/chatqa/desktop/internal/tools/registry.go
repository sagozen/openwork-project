// Package tools: một danh mục tool duy nhất cho chat trong app (Wails) và agent bên ngoài (MCP), để giao diện và agent
// không bao giờ lệch nhau. Mọi tool gọi qua Service của tháp hoặc kiểm thử, nên quyền, cổng ngân sách và nhật ký lệnh
// áp cho cả hai lối vào.
package tools

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"reflect"
	"regexp"
	"sort"
	"time"

	"chatqa/internal/testengine"
	"deskcore/apperr"
)

// Loại chi phí của một tool.
const (
	CostFree = "free" // chỉ đọc hoặc thao tác không tốn tiền
	CostPaid = "paid" // tốn phút máy/tiền nhà cung cấp (phase 11)
	CostLLM  = "llm"  // gọi Claude qua Worker, qua cổng ngân sách
)

// Kinds: loại kết quả, UI ánh xạ sang component (phase 08). Tool trả lỗi luôn hiện bằng ErrorCard.
var Kinds = []string{"DeviceGrid", "DeviceCard", "LiveScreen", "TaskTimeline", "RunProgress", "MetricChart", "CostConfirm",
	"BudgetMeter", "AlertList", "DeliveryLog", "ReportCard", "YamlDiff", "ErrorCard", "FlowList"}

// Tool: một công cụ trong danh mục.
type Tool struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Schema      map[string]any `json:"inputSchema"`
	App         string         `json:"app"`  // app cần có trong bản quyền (cqs.tower | cqs.test)
	Perm        string         `json:"perm"` // quyền thao tác cần; "" = chỉ đọc
	Cost        string         `json:"cost"`
	Kind        string         `json:"kind"` // loại kết quả
	// Risk: mức rủi ro của tool, để agent biết khi nào cần người xác nhận. Không có trong tools/list của MCP.
	Risk Risk `json:"-"`
	run  func(ctx context.Context, raw json.RawMessage) (any, error)
}

// Result: kết quả một lần gọi, giống hệt nhau qua Wails và MCP.
type Result struct {
	Kind string `json:"kind"`
	Data any    `json:"data"`
}

// confirmTokenRe: mã xác nhận chi phí trong lỗi confirm_required ("...,token=<hex>").
var confirmTokenRe = regexp.MustCompile(`,?token=[0-9a-fA-F]+`)

// ForModel: lỗi viết lại để gửi cho mô hình hoặc client MCP. Mã xác nhận chi phí bị bỏ: chỉ người bấm trên thẻ xác nhận
// trong app mới có mã, nên agent không tự xác nhận khoản chi vượt trần được.
func ForModel(err error) string {
	msg := confirmTokenRe.ReplaceAllString(err.Error(), "")
	if apperr.CodeOf(err) == "confirm_required" {
		msg += " (người dùng phải xác nhận chi phí trên thẻ trong app ChatQASoftware; không gọi lại)"
	}
	return msg
}

// Registry: danh mục tool theo tên.
type Registry struct {
	tools map[string]Tool
	// Secrets: giá trị bí mật hiện có; kết quả tool (gửi cho Claude, client MCP, UI) được che các giá trị này. nil = không che.
	Secrets func() []string
	// Journal: ghi mỗi lần gọi (nguồn, tool, tham số và kết quả đã che, lỗi, thời gian) vào sổ cục bộ. nil = không ghi.
	Journal func(testengine.ToolCall)
}

type sourceKey struct{}

// WithSource gắn nguồn gọi tool (testengine.ToolSourceMCP | ToolSourceChat | ToolSourceUI) vào ctx cho sổ tool.
func WithSource(ctx context.Context, source string) context.Context {
	return context.WithValue(ctx, sourceKey{}, source)
}

// SourceOf: nguồn gọi tool trong ctx; "" nếu người gọi chưa gắn.
func SourceOf(ctx context.Context) string {
	s, _ := ctx.Value(sourceKey{}).(string)
	return s
}

func NewRegistry(ts ...Tool) *Registry {
	r := &Registry{tools: map[string]Tool{}}
	for _, t := range ts {
		if _, dup := r.tools[t.Name]; dup {
			panic("tools: trùng tên " + t.Name)
		}
		r.tools[t.Name] = t
	}
	return r
}

// List: mọi tool, theo tên.
func (r *Registry) List() []Tool {
	out := make([]Tool, 0, len(r.tools))
	for _, t := range r.tools {
		out = append(out, t)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

func (r *Registry) Get(name string) (Tool, bool) {
	t, ok := r.tools[name]
	return t, ok
}

// Call giải mã tham số đúng schema (không nhận trường lạ) rồi chạy tool. Mỗi lần gọi được ghi sổ nếu có Journal.
func (r *Registry) Call(ctx context.Context, name string, args json.RawMessage) (res *Result, err error) {
	start := time.Now()
	defer func() { r.journal(ctx, start, name, args, res, err) }()
	t, ok := r.tools[name]
	if !ok {
		return nil, apperr.New(apperr.CodeNotFound, "tool "+name)
	}
	if len(bytes.TrimSpace(args)) == 0 || string(bytes.TrimSpace(args)) == "null" {
		args = json.RawMessage("{}")
	}
	logCallArgs(name, args)
	data, err := t.run(ctx, args)
	if err != nil {
		return nil, err
	}
	return &Result{Kind: t.Kind, Data: r.redact(data)}, nil
}

// journal ghi một lần gọi: tham số và kết quả che bí mật, bỏ ảnh base64, cắt còn testengine.ToolBodyCap.
func (r *Registry) journal(ctx context.Context, start time.Time, name string, args json.RawMessage, res *Result, err error) {
	if r.Journal == nil {
		return
	}
	var secrets []string
	if r.Secrets != nil {
		secrets = r.Secrets()
	}
	c := testengine.ToolCall{At: start, Source: SourceOf(ctx), Tool: name, DurationMs: time.Since(start).Milliseconds(),
		Args: testengine.JournalJSON(args, secrets, testengine.ToolBodyCap)}
	if c.Source == "" {
		c.Source = "unknown"
	}
	if err != nil {
		c.ErrorCode = apperr.CodeOf(err)
		c.Error = testengine.JournalText(confirmTokenRe.ReplaceAllString(err.Error(), ""), secrets, testengine.ToolBodyCap)
	} else if res != nil {
		c.Result = testengine.JournalJSON(res, secrets, testengine.ToolBodyCap)
	}
	r.Journal(c)
}

// logCallArgs ghi tên các khoá của tham số thô mỗi lần gọi tool, kèm giá trị của các khoá chỉ mã thiết bị (không phải
// bí mật), để biết client có gửi tham số thiết bị hay không. Không ghi giá trị của khoá nào khác (yaml, env...).
func logCallArgs(tool string, args json.RawMessage) {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(args, &m); err != nil {
		log.Printf("tool %s: tham số thô không phải object: %v", tool, err)
		return
	}
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var ids []string
	for _, k := range []string{"device", "device_id", "devices", "id"} {
		if v, ok := m[k]; ok {
			ids = append(ids, fmt.Sprintf("%s=%s", k, v))
		}
	}
	log.Printf("tool %s: khoá nhận được=%v mã thiết bị=%v", tool, keys, ids)
}

// redact che giá trị bí mật trong kết quả (vd chữ đang hiện trên màn hình trong cây giao diện, lỗi của driver).
// Màn hình: mọi trường chuỗi (cây, URL, locator...) đều được che, chỉ ảnh giữ nguyên (không có chữ để thay); phần còn
// lại đi qua JSON đã che, nên MCP và Wails vẫn nhận cùng một JSON.
func (r *Registry) redact(data any) any {
	if r.Secrets == nil {
		return data
	}
	secrets := r.Secrets()
	if len(secrets) == 0 {
		return data
	}
	if s, ok := data.(screen); ok {
		v := reflect.ValueOf(&s).Elem()
		for i := range v.NumField() {
			if f := v.Field(i); f.Kind() == reflect.String && v.Type().Field(i).Name != "PNG" {
				f.SetString(testengine.Redact(f.String(), secrets))
			}
		}
		return s
	}
	raw, err := json.Marshal(data)
	if err != nil {
		return data
	}
	clean := testengine.Redact(string(raw), secrets)
	if clean == string(raw) {
		return data
	}
	return json.RawMessage(clean)
}

// def tạo một tool có tham số kiểu A: schema sinh từ A, tham số giải mã chặt vào A.
func def[A any](name, desc, app, perm, cost, kind string, fn func(ctx context.Context, a A) (any, error)) Tool {
	var zero A
	names := fieldNames(reflect.TypeOf(zero))
	return Tool{Name: name, Description: desc, Schema: schemaOf(reflect.TypeOf(zero)), App: app, Perm: perm, Cost: cost, Kind: kind,
		run: func(ctx context.Context, raw json.RawMessage) (any, error) {
			var a A
			dec := json.NewDecoder(bytes.NewReader(normalizeArgs(names, raw)))
			dec.DisallowUnknownFields()
			if err := dec.Decode(&a); err != nil {
				return nil, apperr.New(apperr.CodeInvalid, fmt.Sprintf("tham số %s: %s", name, withAcceptedFields(err.Error(), names)))
			}
			return fn(ctx, a)
		}}
}

// Raw tạo tool nhận tham số JSON thô (adapter nhà cung cấp, test); schema do người gọi khai.
func Raw(name, desc, perm, kind string, schema map[string]any, fn func(ctx context.Context, args json.RawMessage) (any, error)) Tool {
	return Tool{Name: name, Description: desc, Schema: schema, Perm: perm, Cost: CostFree, Kind: kind, run: fn}
}
