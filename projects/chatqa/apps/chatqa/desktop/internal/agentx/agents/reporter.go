package agents

import (
	"fmt"
	"strings"

	"google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/agent/llmagent"
	"google.golang.org/adk/v2/model"
)

// ReporterName is the Reporter agent's name.
const ReporterName = "reporter"

// Session-state keys the pipeline writes for the Reporter. Values are JSON strings.
const (
	StatePlan    = "pipeline.plan"    // Plan
	StateResults = "pipeline.results" // the per-platform run results
	ReportKey    = "pipeline.report"  // the Reporter's text
)

// NewReporter writes the Vietnamese report from the plan, the run results and the Triage findings, all read from
// session state. It can only read memory (recall, feature_flow_map); it cannot remember. Its reply is stored under
// ReportKey.
func NewReporter(m model.LLM, mem Memory) (agent.Agent, error) {
	return llmagent.New(llmagent.Config{
		Name:        ReporterName,
		Description: "Viết báo cáo kiểm thử sau deploy bằng tiếng Việt, nhóm theo tính năng.",
		Model:       m,
		InstructionProvider: func(ctx agent.ReadonlyContext) (string, error) {
			return reporterText + "\n\n" + renderPipeline(ctx), nil
		},
		Tools:                    pick(mem.Recall, mem.FeatureFlowMap),
		OutputKey:                ReportKey,
		DisallowTransferToParent: true,
		DisallowTransferToPeers:  true,
	})
}

func stateText(ctx agent.ReadonlyContext, key string) string {
	v, err := ctx.ReadonlyState().Get(key)
	if err != nil {
		return ""
	}
	s, _ := v.(string)
	return strings.TrimSpace(s)
}

// renderPipeline is the data block of the Reporter's prompt. Triage findings that do not parse are passed on as
// raw text with a note, so the Reporter can say the classification is unreliable instead of inventing one.
func renderPipeline(ctx agent.ReadonlyContext) string {
	var b strings.Builder
	b.WriteString("<pipeline>\n")
	fmt.Fprintf(&b, "Kế hoạch / Plan: %s\n", orNone(stateText(ctx, StatePlan)))
	fmt.Fprintf(&b, "Kết quả chạy / Results: %s\n", orNone(stateText(ctx, StateResults)))
	triage := stateText(ctx, TriageKey)
	switch {
	case triage == "":
		b.WriteString("Phân loại lỗi / Triage: không có (không có flow lỗi)\n")
	default:
		if _, err := ParseTriage(triage); err != nil {
			fmt.Fprintf(&b, "Phân loại lỗi / Triage (không đọc được, coi là chưa chắc chắn: %v): %s\n", err, triage)
		} else {
			fmt.Fprintf(&b, "Phân loại lỗi / Triage: %s\n", triage)
		}
	}
	b.WriteString("</pipeline>")
	return b.String()
}

func orNone(s string) string {
	if s == "" {
		return "(không có)"
	}
	return s
}
