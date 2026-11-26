package memory

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/session"
	"google.golang.org/adk/v2/tool/functiontool"

	"chatqa/internal/agentx/agents"
	"chatqa/internal/tools"
)

// Tool names. These tools exist only for the ADK agents: they are not in the shared tools.Registry, so MCP
// tools/list and MCP behaviour do not change.
const (
	RecallName         = "recall"
	RememberName       = "remember"
	KnownIssuesName    = "known_issues"
	FeatureFlowMapName = "feature_flow_map"
)

// Risk of each memory tool, in the terms of tools.Risk. remember is a write: it changes shared QA memory.
var Risks = map[string]tools.Risk{
	RecallName: tools.RiskRead, KnownIssuesName: tools.RiskRead, FeatureFlowMapName: tools.RiskRead, RememberName: tools.RiskWrite,
}

// ToolOptions configures the agent tools.
type ToolOptions struct {
	// Confirm is the confirmation policy (guard.Confirm), asked for remember with tools.RiskWrite. nil = never ask.
	Confirm func(name string, args map[string]any, risk tools.Risk) bool
}

type recallIn struct {
	Query string   `json:"query" jsonschema:"words to look up: a flow, a feature, an error message, a question"`
	Kinds []string `json:"kinds,omitempty" jsonschema:"optional filter: fact, fix, preference, session_summary, known_issue, feature_map, flaky"`
}

type recallHit struct {
	Source string `json:"source"`
	ID     string `json:"id"`
	Kind   string `json:"kind,omitempty"`
	Text   string `json:"text"`
	At     string `json:"at,omitempty"`
}

type recallOut struct {
	Memories []recallHit `json:"memories"`
	Flaky    []FlakyStat `json:"flaky"`
	Note     string      `json:"note,omitempty"`
}

type rememberIn struct {
	Kind     string `json:"kind" jsonschema:"fact, fix, preference, known_issue or feature_map"`
	Fact     string `json:"fact" jsonschema:"what to remember, at most 2000 characters; never a password, token or secret value. For feature_map: an optional note"`
	Symptom  string `json:"symptom,omitempty" jsonschema:"known_issue: the symptom or error message (defaults to fact)"`
	Cause    string `json:"cause,omitempty" jsonschema:"known_issue: the cause"`
	Fix      string `json:"fix,omitempty" jsonschema:"known_issue: how to fix or avoid it"`
	Category string `json:"category,omitempty" jsonschema:"known_issue: app, selector, data or environment"`
	App      string `json:"app,omitempty" jsonschema:"app name, for known_issue and feature_map"`
	Flow     string `json:"flow,omitempty" jsonschema:"flow file name, for known_issue and feature_map"`
	Platform string `json:"platform,omitempty" jsonschema:"android, ios or web, for known_issue"`
	Feature  string `json:"feature,omitempty" jsonschema:"feature_map: the product feature the flow tests"`
}

type rememberOut struct {
	Saved bool   `json:"saved"`
	ID    string `json:"id,omitempty"`
	Error string `json:"error,omitempty"`
}

type proposeOut struct {
	Proposed bool   `json:"proposed"`
	Error    string `json:"error,omitempty"`
	Note     string `json:"note,omitempty"`
}

type knownIssuesIn struct {
	Query string `json:"query" jsonschema:"symptom or error text to look up"`
}

type knownIssuesOut struct {
	Issues []KnownIssue `json:"issues"`
}

type featureFlowMapIn struct {
	Feature string `json:"feature,omitempty" jsonschema:"optional feature words; empty lists every link"`
}

type featureFlowMapOut struct {
	Links []FeatureFlow `json:"links"`
}

// knownIssuesLimit bounds a known_issues answer.
const knownIssuesLimit = 5

// AgentTools builds the memory tools for the agents.
func (s *Service) AgentTools(opts ToolOptions) (agents.Memory, error) {
	recall, err := functiontool.New(functiontool.Config{
		Name: RecallName,
		Description: "Tra cứu trí nhớ QA: điều đã ghi nhớ, tóm tắt phiên trước, lỗi đã biết, tính năng ↔ flow, và thống kê flow hay lỗi " +
			"(30 ngày) của các flow có tên trong câu hỏi. Looks up QA memory and flaky statistics.",
	}, s.recall)
	if err != nil {
		return agents.Memory{}, err
	}
	rcfg := functiontool.Config{
		Name: RememberName,
		Description: "Ghi nhớ lâu dài (cần người dùng xác nhận): kind fact | fix | preference | known_issue | feature_map. " +
			"Không bao giờ ghi mật khẩu, token hay giá trị bí mật. Stores QA memory after the tester confirms.",
	}
	if opts.Confirm != nil {
		rcfg.RequireConfirmationProvider = func(in rememberIn) bool {
			return opts.Confirm(RememberName, argsMap(in), Risks[RememberName])
		}
	}
	remember, err := functiontool.New(rcfg, s.remember)
	if err != nil {
		return agents.Memory{}, err
	}
	// The Triage runs inside the pipeline graph, where ADK v2.8.0 cannot resume a tool confirmation (a graph resumes a
	// paused node only for an input request). Its remember therefore records a proposal in session state, and the
	// pipeline's save_memory step asks the tester with an input request before anything is stored.
	propose, err := functiontool.New(functiontool.Config{
		Name: RememberName,
		Description: "Đề xuất ghi nhớ (thường là kind known_issue kèm symptom, cause, fix, category, app, flow, platform). Tester duyệt ở " +
			"cuối pipeline trước khi lưu. Không bao giờ ghi mật khẩu, token hay giá trị bí mật. Proposes a memory for the tester to approve.",
	}, s.propose)
	if err != nil {
		return agents.Memory{}, err
	}
	known, err := functiontool.New(functiontool.Config{
		Name:        KnownIssuesName,
		Description: "Tra lỗi đã biết theo triệu chứng hoặc thông báo lỗi (nguyên nhân, cách sửa). Looks up known issues by symptom.",
	}, s.knownIssues)
	if err != nil {
		return agents.Memory{}, err
	}
	fmap, err := functiontool.New(functiontool.Config{
		Name:        FeatureFlowMapName,
		Description: "Liệt kê tính năng ↔ flow kiểm thử (lọc theo tên tính năng nếu có). Lists which flows test which feature.",
	}, s.featureFlowMap)
	if err != nil {
		return agents.Memory{}, err
	}
	return agents.Memory{
		Recall: recall, Remember: remember, Propose: propose, KnownIssues: known, FeatureFlowMap: fmap,
		Brief: func(ctx context.Context) string { return s.Brief(ctx) },
	}, nil
}

func argsMap(v any) map[string]any {
	raw, err := json.Marshal(v)
	if err != nil {
		return map[string]any{}
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil || m == nil {
		return map[string]any{}
	}
	return m
}

func (s *Service) recall(ctx agent.Context, in recallIn) (recallOut, error) {
	out := recallOut{Memories: []recallHit{}, Flaky: []FlakyStat{}}
	if strings.TrimSpace(in.Query) == "" {
		return out, errors.New("recall cần query")
	}
	searchKinds := make([]string, 0, len(in.Kinds))
	wantFlaky := len(in.Kinds) == 0
	for _, k := range in.Kinds {
		if k == "flaky" {
			wantFlaky = true
			continue
		}
		searchKinds = append(searchKinds, k)
	}
	if len(in.Kinds) == 0 || len(searchKinds) > 0 {
		hits, err := s.search(ctx, ctx.AppName(), ctx.UserID(), in.Query, searchKinds)
		if err != nil {
			return out, err
		}
		for _, h := range hits {
			rh := recallHit{Source: h.source, ID: h.id, Kind: h.kind, Text: s.redact(h.text)}
			if h.at > 0 {
				rh.At = time.UnixMilli(h.at).Format("2006-01-02 15:04")
			}
			out.Memories = append(out.Memories, rh)
		}
	}
	if wantFlaky {
		st, err := s.FlakyFor(ctx, in.Query)
		if err != nil {
			return out, err
		}
		out.Flaky = st
	}
	if len(out.Memories) == 0 && len(out.Flaky) == 0 {
		out.Note = "chưa có trí nhớ nào khớp"
	}
	return out, nil
}

func noteOf(ctx agent.Context, in rememberIn) Note {
	return Note{
		Kind: in.Kind, Text: in.Fact, Symptom: in.Symptom, Cause: in.Cause, Fix: in.Fix, Category: in.Category,
		App: in.App, Flow: in.Flow, Platform: in.Platform, Feature: in.Feature,
		AppName: ctx.AppName(), UserID: ctx.UserID(), Author: ctx.AgentName(),
	}
}

func (s *Service) remember(ctx agent.Context, in rememberIn) (rememberOut, error) {
	id, err := s.Remember(ctx, noteOf(ctx, in))
	if errors.Is(err, ErrRejected) {
		return rememberOut{Error: err.Error()}, nil // the model reads why and can fix its request
	}
	if err != nil {
		return rememberOut{}, fmt.Errorf("không lưu được vào trí nhớ: %w", err)
	}
	return rememberOut{Saved: true, ID: id}, nil
}

// ProposalPrefix is the session-state key prefix of the memories proposed during a pipeline run, one key per tool
// call. The value is the Note as JSON; "" means handled.
const ProposalPrefix = "pipeline.memory_proposal."

func (s *Service) propose(ctx agent.Context, in rememberIn) (proposeOut, error) {
	n := noteOf(ctx, in)
	if err := s.Check(&n); err != nil {
		if errors.Is(err, ErrRejected) {
			return proposeOut{Error: err.Error()}, nil
		}
		return proposeOut{}, err
	}
	raw, err := json.Marshal(n)
	if err != nil {
		return proposeOut{}, err
	}
	key := ctx.FunctionCallID()
	if key == "" {
		key = newID()
	}
	ctx.Actions().StateDelta[ProposalPrefix+key] = string(raw)
	return proposeOut{Proposed: true, Note: "đã ghi đề xuất; tester duyệt ở cuối pipeline rồi mới lưu"}, nil
}

// Proposal is a memory proposed during a pipeline run and not handled yet.
type Proposal struct {
	Key  string `json:"key"` // the state key without ProposalPrefix
	Note Note   `json:"-"`
	Text string `json:"text"` // the note in words, redacted
}

// Proposals lists the open proposals in a session's state, in key order. Values that do not parse are skipped.
func (s *Service) Proposals(state session.ReadonlyState) []Proposal {
	var out []Proposal
	for k, v := range state.All() {
		raw, _ := v.(string)
		if !strings.HasPrefix(k, ProposalPrefix) || raw == "" {
			continue
		}
		var n Note
		if err := json.Unmarshal([]byte(raw), &n); err != nil {
			continue
		}
		out = append(out, Proposal{Key: strings.TrimPrefix(k, ProposalPrefix), Note: n, Text: s.redact(n.String())})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Key < out[j].Key })
	return out
}

func (s *Service) knownIssues(ctx agent.Context, in knownIssuesIn) (knownIssuesOut, error) {
	issues, err := s.KnownIssues(ctx, in.Query, knownIssuesLimit)
	if err != nil {
		return knownIssuesOut{}, err
	}
	return knownIssuesOut{Issues: issues}, nil
}

func (s *Service) featureFlowMap(ctx agent.Context, in featureFlowMapIn) (featureFlowMapOut, error) {
	links, err := s.FeatureFlows(ctx, in.Feature)
	if err != nil {
		return featureFlowMapOut{}, err
	}
	return featureFlowMapOut{Links: links}, nil
}

// Brief limits: how many flaky flows and feature links the Planner's prompt lists.
const (
	briefFlaky    = 15
	briefFeatures = 50
)

// Brief is the <memory> block of the Planner's prompt: the flows that failed most in the last 30 days and the known
// feature-to-flow links. "" when both are empty or memory cannot be read (the Planner still works without it).
func (s *Service) Brief(ctx context.Context) string {
	flaky, err := s.TopFlaky(ctx, briefFlaky)
	if err != nil {
		return ""
	}
	links, err := s.FeatureFlows(ctx, "")
	if err != nil {
		return ""
	}
	if len(links) > briefFeatures {
		links = links[:briefFeatures]
	}
	if len(flaky) == 0 && len(links) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("<memory>\n")
	if len(flaky) > 0 {
		b.WriteString("Flow hay lỗi trong 30 ngày / Flaky flows:\n")
		for _, st := range flaky {
			fmt.Fprintf(&b, "- %s/%s %s: lỗi %d/%d lượt, %d lần đạt khi chạy lại", st.App, st.Flow, st.Platform, st.Fails, st.Runs, st.FlakyPasses)
			if len(st.TopCauses) > 0 {
				var cs []string
				for _, c := range st.TopCauses {
					cs = append(cs, fmt.Sprintf("%s ×%d", c.Class, c.Count))
				}
				b.WriteString("; lỗi chính: " + strings.Join(cs, ", "))
			}
			b.WriteByte('\n')
		}
	}
	if len(links) > 0 {
		b.WriteString("Tính năng ↔ flow / Feature map:\n")
		for _, l := range links {
			fmt.Fprintf(&b, "- %q: %s/%s", l.Feature, l.App, l.Flow)
			if l.Note != "" {
				b.WriteString(" (" + l.Note + ")")
			}
			b.WriteByte('\n')
		}
	}
	b.WriteString("</memory>")
	return s.redact(b.String())
}
