package agents

import (
	"encoding/json"
	"fmt"
	"slices"
	"strings"

	"google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/agent/llmagent"
	"google.golang.org/adk/v2/model"
	"google.golang.org/adk/v2/tool"

	"chatqa/internal/tools"
)

// TriageName is the Triage agent's name.
const TriageName = "triage"

// TriageKey is the session-state key the Triage writes its JSON findings to.
const TriageKey = "pipeline.triage"

// TriageTools are the registry tools the Triage may call. All are read-only: Triage looks, it never acts.
var TriageTools = []string{"test_report", "device_screenshot"}

// Failure categories a Triage finding may carry.
var TriageCategories = []string{"app", "selector", "data", "environment"}

// Finding is one classified failure.
type Finding struct {
	Flow       string  `json:"flow"`
	Platform   string  `json:"platform"`
	Category   string  `json:"category"`
	Evidence   string  `json:"evidence"`
	Confidence float64 `json:"confidence"`
}

// ParseTriage reads the Triage's reply: a JSON array of findings, with or without a code fence. A finding with an
// unknown category or a confidence outside 0..1 is an error, so a bad reply is never passed on as a classification.
func ParseTriage(text string) ([]Finding, error) {
	s := strings.TrimSpace(text)
	if i := strings.Index(s, "["); i >= 0 {
		if j := strings.LastIndex(s, "]"); j > i {
			s = s[i : j+1]
		}
	}
	var out []Finding
	if err := json.Unmarshal([]byte(s), &out); err != nil {
		return nil, fmt.Errorf("phân loại lỗi của Triage không phải JSON hợp lệ: %w", err)
	}
	for i, f := range out {
		if !slices.Contains(TriageCategories, f.Category) {
			return nil, fmt.Errorf("phân loại lỗi #%d (%s) có loại %q không hợp lệ", i+1, f.Flow, f.Category)
		}
		if f.Confidence < 0 || f.Confidence > 1 {
			return nil, fmt.Errorf("phân loại lỗi #%d (%s) có độ tin cậy %v ngoài 0..1", i+1, f.Flow, f.Confidence)
		}
	}
	return out, nil
}

// NewTriage classifies failed flows. toolset is the shared registry toolset; the Triage sees only TriageTools plus
// known_issues, recall and remember (which only proposes: the pipeline stores a proposal after the tester approves
// it). Its reply is stored under TriageKey.
func NewTriage(m model.LLM, toolset tool.Toolset, mem Memory) (agent.Agent, error) {
	return llmagent.New(llmagent.Config{
		Name:        TriageName,
		Description: "Phân loại vì sao flow lỗi (app, selector, data, environment) kèm bằng chứng.",
		Model:       m,
		InstructionProvider: func(agent.ReadonlyContext) (string, error) {
			return triageText, nil
		},
		Tools:                    pick(mem.KnownIssues, mem.Recall, mem.Propose),
		Toolsets:                 []tool.Toolset{tool.FilterToolset(toolset, tools.Allow(TriageTools...))},
		OutputKey:                TriageKey,
		DisallowTransferToParent: true,
		DisallowTransferToPeers:  true,
	})
}
