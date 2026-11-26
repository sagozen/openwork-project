package workflows

import (
	"errors"

	"google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/agent/workflowagents/loopagent"
)

// FlowFixerLoopName is the name the Coordinator transfers to for a flow fix.
const FlowFixerLoopName = "fix_flow"

// NewFlowFixerLoop runs the FlowFixer in a bounded loop: each pass proposes a draft and validates it. The loop ends
// when the FlowFixer calls exit_loop (a valid draft), when maxIterations passes are done, or on an error or a cancel.
// It never applies a fix: the tester applies a draft from the chat pane.
func NewFlowFixerLoop(fixer agent.Agent, maxIterations int) (agent.Agent, error) {
	if fixer == nil {
		return nil, errors.New("flow fixer loop needs the FlowFixer agent")
	}
	if maxIterations <= 0 {
		return nil, errors.New("flow fixer loop needs a positive iteration bound")
	}
	return loopagent.New(loopagent.Config{
		AgentConfig: agent.Config{
			Name:        FlowFixerLoopName,
			Description: "Sửa flow hỏng (selector, giao diện đổi): đọc flow, đề xuất bản nháp, kiểm tra, lặp tối đa vài lần; người dùng duyệt rồi mới áp dụng.",
			SubAgents:   []agent.Agent{fixer},
		},
		MaxIterations: uint(maxIterations),
	})
}
