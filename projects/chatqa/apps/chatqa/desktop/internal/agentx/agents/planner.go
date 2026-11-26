package agents

import (
	"time"

	"google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/agent/llmagent"
	"google.golang.org/adk/v2/model"
	"google.golang.org/adk/v2/tool"

	"chatqa/internal/tools"
)

// PlanKey is the session-state key the Planner writes its JSON plan to and the Runner reads.
const PlanKey = "plan"

// PlannerTools are the registry tools the Planner may call.
var PlannerTools = []string{"test_git_diff", "test_flows", "test_metrics"}

// NewPlanner picks flows. toolset is the shared registry toolset; the Planner sees only PlannerTools.
// It also gets recall and feature_flow_map, and its prompt carries the flaky statistics and feature map
// (mem.Brief). Its reply is stored under PlanKey.
func NewPlanner(m model.LLM, toolset tool.Toolset, live ContextFunc, mem Memory) (agent.Agent, error) {
	return newPlanner(m, toolset, live, mem, "", PlanKey)
}

// PipelinePlanKey is the session-state key the pipeline's Planner writes its JSON plan to.
const PipelinePlanKey = "pipeline.plan_text"

// NewPipelinePlanner is the Planner for the post-deploy pipeline: its input is a code diff, not a chat request.
func NewPipelinePlanner(m model.LLM, toolset tool.Toolset, live ContextFunc, mem Memory) (agent.Agent, error) {
	return newPlanner(m, toolset, live, mem, pipelinePlannerText, PipelinePlanKey)
}

// The memory block is part of the instruction rather than a preload_memory tool: the Planner needs the flaky flows
// and the feature map whatever the request says, while preload_memory searches only with the user's words (and in the
// pipeline the "user" text is a diff). Rendering it in the InstructionProvider, as the live flow list already is, has
// the effect of a BeforeModelCallback without a second place that edits the request.
func newPlanner(m model.LLM, toolset tool.Toolset, live ContextFunc, mem Memory, extra, outputKey string) (agent.Agent, error) {
	return llmagent.New(llmagent.Config{
		Name:        "planner",
		Description: "Chọn flow cần chạy từ yêu cầu (khớp tên gần đúng, xem diff, flow hay lỗi).",
		Model:       m,
		InstructionProvider: func(ctx agent.ReadonlyContext) (string, error) {
			text := plannerText
			if extra != "" {
				text += "\n\n" + extra
			}
			if live != nil {
				text += "\n\n" + live().render(time.Now())
			}
			if mem.Brief != nil {
				if b := mem.Brief(ctx); b != "" {
					text += "\n\n" + b
				}
			}
			return text, nil
		},
		Tools:                    pick(mem.Recall, mem.FeatureFlowMap),
		Toolsets:                 []tool.Toolset{tool.FilterToolset(toolset, tools.Allow(PlannerTools...))},
		OutputKey:                outputKey,
		DisallowTransferToParent: true,
		DisallowTransferToPeers:  true,
	})
}
