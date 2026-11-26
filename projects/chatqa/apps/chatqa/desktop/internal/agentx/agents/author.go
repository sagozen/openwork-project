package agents

import (
	"time"

	"google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/agent/llmagent"
	"google.golang.org/adk/v2/model"
	"google.golang.org/adk/v2/tool"

	"chatqa/internal/tools"
)

// AuthorName is the Author agent's name (and its model entry in agent.yaml).
const AuthorName = "author"

// AuthorTools are the registry tools the Author may call. It reads the flow store and the screen, and walks a multi-step
// journey on the browser profile with web_click, web_fill and web_back (the page it must describe often has no URL of its own;
// the prompt forbids destructive, paying or sending controls), then writes a
// new flow with test_compile (the app's AI writes it from the documents and the page) or test_save_flow (the Author
// writes the YAML or .spec.ts itself). Both write, so the tester approves every call (guard: Decide), and a flow is
// stored only after its confirming run passes, as for MCP clients. The Author never edits or deletes an existing flow:
// repairs stay with the FlowFixer, which writes drafts.
var AuthorTools = []string{"test_flows", "test_validate", "docs_requirements", "device_ui_state", "web_navigate", "web_click", "web_fill", "web_back", "test_compile", "test_save_flow"}

// NewAuthor writes new test flows. toolset is the shared registry toolset; the Author sees only AuthorTools.
func NewAuthor(m model.LLM, toolset tool.Toolset, live ContextFunc, ext ...tool.Toolset) (agent.Agent, error) {
	return llmagent.New(llmagent.Config{
		Name:        AuthorName,
		Description: "Soạn flow kiểm thử mới (web .spec.ts hoặc điện thoại YAML) từ yêu cầu, rồi lưu sau khi chạy xác nhận đạt.",
		Model:       m,
		InstructionProvider: func(agent.ReadonlyContext) (string, error) {
			text := authorText
			if live != nil {
				text += "\n\n" + live().render(time.Now())
			}
			return text, nil
		},
		Toolsets:                 append([]tool.Toolset{tool.FilterToolset(toolset, tools.Allow(AuthorTools...))}, ext...),
		DisallowTransferToParent: true,
		DisallowTransferToPeers:  true,
	})
}
