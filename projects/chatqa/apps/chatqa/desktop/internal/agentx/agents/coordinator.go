package agents

import (
	"context"

	"google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/agent/llmagent"
	"google.golang.org/adk/v2/model"
	"google.golang.org/adk/v2/tool"
)

// Memory is the QA memory as agent tools (built by the memory package). Each agent gets only the tools its job
// needs; a nil tool is left out.
//   - Recall (read): memories, known issues, feature map and flaky statistics. Coordinator, Planner, Triage, Reporter.
//   - Remember (write, asks the tester first): Coordinator.
//   - Propose (named remember, writes nothing): Triage; the pipeline's save_memory step asks the tester before
//     storing what it proposed.
//   - KnownIssues (read): Triage.
//   - FeatureFlowMap (read): Planner and Reporter.
type Memory struct {
	Recall, Remember, Propose, KnownIssues, FeatureFlowMap tool.Tool
	// Brief is the flaky statistics and feature map block of the Planner's prompt; nil or "" = none.
	Brief func(ctx context.Context) string
}

// pick returns the non-nil tools among ts.
func pick(ts ...tool.Tool) []tool.Tool {
	out := make([]tool.Tool, 0, len(ts))
	for _, t := range ts {
		if t != nil {
			out = append(out, t)
		}
	}
	return out
}

// NewCoordinator is the root agent. It talks to the tester and hands work to the sub-agents. It can recall and
// remember QA memory. ext are the external MCP toolsets agent.yaml gives the coordinator (nil = none).
func NewCoordinator(m model.LLM, mem Memory, ext []tool.Toolset, sub ...agent.Agent) (agent.Agent, error) {
	return llmagent.New(llmagent.Config{
		Name:        "coordinator",
		Description: "Điều phối viên QA: nói chuyện với người dùng và giao việc cho agent con.",
		Model:       m,
		InstructionProvider: func(agent.ReadonlyContext) (string, error) {
			return coordinatorText, nil
		},
		Tools:     pick(mem.Recall, mem.Remember),
		Toolsets:  ext,
		SubAgents: sub,
	})
}
