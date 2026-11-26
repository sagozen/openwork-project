package workflows

import (
	"fmt"
	"slices"
	"strings"

	"github.com/google/jsonschema-go/jsonschema"
	"google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/session"
	"google.golang.org/adk/v2/workflow"

	"chatqa/internal/agentx/agents"
)

// ApproveNode is the name of the pipeline's human approval step.
const ApproveNode = "approve"

// ApprovalFlow is one data-changing flow the approval request lists. Key is what the answer names in approved_flows.
type ApprovalFlow struct {
	Key    string `json:"key"` // "<app>/<flow>"
	App    string `json:"app"`
	Flow   string `json:"flow"`
	Reason string `json:"reason,omitempty"` // why the Planner chose it
}

// ApprovalPayload is RequestInput.Payload of the approval step: the flows that need a person's approval, and the
// planned flows that run anyway because they change nothing.
type ApprovalPayload struct {
	Flows  []ApprovalFlow `json:"flows"`
	Others []string       `json:"others,omitempty"`
}

// ApprovalReply is the answer: the keys (or flow names) of the approved flows and an optional note.
type ApprovalReply struct {
	ApprovedFlows []string `json:"approved_flows"`
	Note          string   `json:"note,omitempty"`
}

// ApprovedPlan is what reaches split after the approval step: the plan cut to the approved flows, or Skip when
// nothing is left to run.
type ApprovedPlan struct {
	agents.Plan
	Skip string `json:"skip,omitempty"`
}

// approvalSchema is the response schema the answer must match; ADK checks it before the step runs again.
var approvalSchema = &jsonschema.Schema{
	Type: "object",
	Properties: map[string]*jsonschema.Schema{
		"approved_flows": {Type: "array", Items: &jsonschema.Schema{Type: "string"}},
		"note":           {Type: "string"},
	},
	Required: []string{"approved_flows"},
}

// ApprovalInterruptID is the id of the approval request of one pipeline run. It is stable across the run's resume
// (ADK reuses the paused invocation) and unique per run.
func ApprovalInterruptID(invocationID string) string { return ApproveNode + "-" + invocationID }

// approve asks a person which data-changing flows may run, and stops the run with status waiting_approval. When the
// answer arrives the step runs again, keeps the approved data-changing flows and every flow that changes nothing, and
// hands that plan to split.
func (p *pipeline) approve(ctx agent.Context, in any, emit emitFn) (any, error) {
	plan, err := decode[agents.Plan](in)
	if err != nil {
		return nil, err
	}
	var payload ApprovalPayload
	for _, f := range plan.Flows {
		if p.d.IsDataChanging(f.App, f.Flow) {
			payload.Flows = append(payload.Flows, ApprovalFlow{Key: f.App + "/" + f.Flow, App: f.App, Flow: f.Flow, Reason: f.Reason})
		} else {
			payload.Others = append(payload.Others, f.App+"/"+f.Flow)
		}
	}
	id := ApprovalInterruptID(ctx.InvocationID())
	raw, answered := ctx.ResumedInput(id)
	if !answered {
		keys := make([]string, 0, len(payload.Flows))
		for _, f := range payload.Flows {
			keys = append(keys, f.Key)
		}
		text := "Kế hoạch có flow tạo hoặc thay đổi dữ liệu: " + strings.Join(keys, ", ") +
			". Pipeline dừng ở bước duyệt và chưa chạy gì trên thiết bị; chọn flow được phép chạy."
		if err := say(ctx, emit, PipelineName, text, map[string]any{StateStatus: StatusWaitingApproval}); err != nil {
			return nil, err
		}
		req := session.RequestInput{InterruptID: id, Message: text, Payload: payload, ResponseSchema: approvalSchema}
		if err := emit(workflow.NewRequestInputEvent(ctx, req)); err != nil {
			return nil, err
		}
		return nil, workflow.ErrNodeInterrupted
	}

	reply, err := decode[ApprovalReply](raw)
	if err != nil {
		return nil, fmt.Errorf("câu trả lời duyệt không đọc được: %w", err)
	}
	var kept []agents.PlanFlow
	var approved, refused []string
	for _, f := range plan.Flows {
		key := f.App + "/" + f.Flow
		if !p.d.IsDataChanging(f.App, f.Flow) {
			kept = append(kept, f)
			continue
		}
		if slices.Contains(reply.ApprovedFlows, key) || slices.Contains(reply.ApprovedFlows, f.Flow) {
			kept = append(kept, f)
			approved = append(approved, key)
		} else {
			refused = append(refused, key)
		}
	}
	text := "Đã duyệt: " + listOr(approved, "không flow nào") + ". Không chạy: " + listOr(refused, "không có") + "."
	if note := strings.TrimSpace(reply.Note); note != "" {
		text += " Ghi chú: " + note
	}
	if err := say(ctx, emit, PipelineName, text, map[string]any{StateStatus: StatusRunning}); err != nil {
		return nil, err
	}
	out := ApprovedPlan{Plan: agents.Plan{Flows: kept, Platforms: plan.Platforms}}
	if len(kept) == 0 {
		out.Skip = "người duyệt không cho chạy flow nào"
	}
	return nil, output(ctx, emit, out, nil, nil)
}

func listOr(items []string, empty string) string {
	if len(items) == 0 {
		return empty
	}
	return strings.Join(items, ", ")
}
