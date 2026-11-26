package agents

import (
	"google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/agent/llmagent"
	"google.golang.org/adk/v2/model"
	"google.golang.org/adk/v2/tool"
	"google.golang.org/adk/v2/tool/exitlooptool"
	"google.golang.org/adk/v2/tool/functiontool"

	"chatqa/internal/tools"
)

// FlowFixerName is the FlowFixer agent's name (and its model entry in agent.yaml).
const FlowFixerName = "flowfixer"

// FlowFixerTools are the registry tools the FlowFixer may call. Both only read: test_validate checks the flows in the
// store, device_ui_state reads the selector tree of an attached device. test_compile is left out on purpose: it
// generates and saves flows, and the FlowFixer must never write a flow.
var FlowFixerTools = []string{"test_validate", "device_ui_state"}

// Names of the FlowFixer's own tools. They exist only for the agents, not in the shared registry, so MCP tools/list
// does not change.
const (
	ReadFlowName     = "read_flow"
	ProposePatchName = "propose_flow_patch"
)

// FlowFixerRisks is the risk of each FlowFixer tool, for the approval dialog. propose_flow_patch is a write (it
// creates files) but asks no one: it writes a draft under agent-drafts and never the flow itself. The tester applies
// a draft through test_apply_repair, which asks for approval.
var FlowFixerRisks = map[string]tools.Risk{ReadFlowName: tools.RiskRead, ProposePatchName: tools.RiskWrite, "exit_loop": tools.RiskRead}

type readFlowIn struct {
	App  string `json:"app" jsonschema:"app name in the flow store"`
	Flow string `json:"flow" jsonschema:"flow file name, e.g. 01_login.yaml or 02_order/001.yaml"`
}

type proposeIn struct {
	App       string `json:"app" jsonschema:"app name in the flow store"`
	Flow      string `json:"flow" jsonschema:"flow file name to fix"`
	PatchYAML string `json:"patch_yaml" jsonschema:"the WHOLE fixed flow YAML (appId, ---, every step), not a fragment; secrets only as ${NAME}"`
	Reason    string `json:"reason" jsonschema:"why this fixes the failure, for the tester (Vietnamese)"`
}

// errResult is the ErrorCard shape registry tools use, so the model reads every tool failure the same way.
func errResult(err error) map[string]any {
	return map[string]any{"kind": "ErrorCard", "isError": true, "data": map[string]any{"code": "invalid", "message": err.Error()}}
}

// Tools returns read_flow and propose_flow_patch over the drafts.
func (d *Drafts) Tools() (readFlow, propose tool.Tool, err error) {
	readFlow, err = functiontool.New(functiontool.Config{
		Name:        ReadFlowName,
		Description: "Đọc nội dung YAML hiện tại của một flow trong kho và kết quả kiểm tra (valid, errors). Reads a flow's YAML. Chỉ đọc.",
	}, func(_ agent.Context, in readFlowIn) (map[string]any, error) {
		ft, err := d.ReadFlow(in.App, in.Flow)
		if err != nil {
			return errResult(err), nil
		}
		return map[string]any{"kind": "FlowText", "data": ft}, nil
	})
	if err != nil {
		return nil, nil, err
	}
	propose, err = functiontool.New(functiontool.Config{
		Name: ProposePatchName,
		Description: "Đề xuất bản sửa cho một flow dưới dạng BẢN NHÁP: kiểm tra cú pháp, flow con và an toàn, lưu nháp kèm diff và lý do để người dùng " +
			"duyệt. KHÔNG BAO GIỜ ghi đè flow. Trả valid và errors. Writes a draft only; the flow is never changed.",
	}, func(_ agent.Context, in proposeIn) (map[string]any, error) {
		res, err := d.Propose(in.App, in.Flow, in.PatchYAML, in.Reason)
		if err != nil {
			return errResult(err), nil
		}
		return map[string]any{"kind": "FlowDraft", "data": res}, nil
	})
	if err != nil {
		return nil, nil, err
	}
	return readFlow, propose, nil
}

// FixTools are the FlowFixer's own tools (built by Drafts.Tools).
type FixTools struct {
	ReadFlow, Propose tool.Tool
}

// NewFlowFixer builds the agent that runs inside the FlowFixer loop. One pass reads the flow (and the screen when a
// device is attached), proposes a fixed version as a draft and checks the result: a valid draft ends the loop with
// exit_loop, an invalid one is fixed in the next pass. toolset is the shared registry toolset (it sees only
// FlowFixerTools); ext are the external MCP toolsets agent.yaml gives the flowfixer.
func NewFlowFixer(m model.LLM, toolset tool.Toolset, fix FixTools, ext ...tool.Toolset) (agent.Agent, error) {
	exit, err := exitlooptool.New()
	if err != nil {
		return nil, err
	}
	sets := append([]tool.Toolset{tool.FilterToolset(toolset, tools.Allow(FlowFixerTools...))}, ext...)
	return llmagent.New(llmagent.Config{
		Name:        FlowFixerName,
		Description: "Đề xuất bản sửa flow hỏng (thường do selector/giao diện đổi) dưới dạng bản nháp để người dùng duyệt.",
		Model:       m,
		InstructionProvider: func(agent.ReadonlyContext) (string, error) {
			return flowFixerText, nil
		},
		Tools:                    pick(fix.ReadFlow, fix.Propose, exit),
		Toolsets:                 sets,
		DisallowTransferToParent: true,
		DisallowTransferToPeers:  true,
	})
}
