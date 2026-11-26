# ChatQA ADK Agent reference

ChatQASoftware ships a team of [Google ADK](https://adk.dev/agents/) agents (ADK Go v2) running inside the app process. It uses the same tool catalog as MCP, so permissions, budget, journal and redaction are identical; the journal records the source as `agent`. Models are called through the ChatQA cloud with the signed-in session (or the company's own provider key set by the admin), never with a key on the machine.

There are three ways to use ADK with ChatQA:

1. **The built-in team** in the app chat (no code).
2. **Drive the team from outside**: CI over HTTP `/agent/`, the `--pipeline` CLI, or ADK REST chat.
3. **Build your own ADK agent** that uses ChatQA MCP as a toolset.

## 1. The built-in team

| Agent | Job | Main tools |
|---|---|---|
| `coordinator` | Talks to the user, delegates | all sub-agents |
| `planner` | Picks flows for a change | `test_git_diff`, `test_flows`, `test_metrics`, `recall`, `feature_flow_map` |
| `runner` | No model. Finds free devices, `test_run` per platform, `tower_wait_task`, `test_report` | |
| `triage` | Classifies failures `app`, `selector`, `data`, `environment` | `test_report`, `device_screenshot`, `known_issues`, `recall` |
| `reporter` | Writes the report | `recall`, `feature_flow_map` |
| `flowfixer` | Proposes flow fixes as drafts only; applying a draft always asks | |
| `author` | Writes NEW flows (YAML or `.spec.ts`), every save asks | `device_ui_state`, `web_*`, `test_compile`, `test_save_flow` |
| `summarizer` | Cheap model that compacts context | |

QA memory lives in `agent.db`: flaky stats (30 days), known issues, feature-to-flow map, redacted session summaries.

**Enable**: sign in, then an Admin opens **Cài đặt › Agent** and picks **Đội agent ADK** (writes `agent.engine: adk`, `agent.enabled: true`). Own provider key: **Cài đặt › Dịch vụ AI**. Edits to `agent.yaml` apply with **Tải lại cấu hình**.

**`agent.yaml`** (`~/Library/Application Support/ChatQASoftware/agent.yaml` on macOS; never holds keys, secret-looking keys are rejected):

```yaml
agent:
  enabled: true
  engine: adk                # legacy | adk
  default_model: sonnet      # sonnet | haiku | opus
  agents:
    coordinator: { model: sonnet }
    planner:     { model: haiku }
    triage:      { model: opus }
  limits: { max_steps: 30, tool_timeout: 120s, max_cost_usd: 1.0, max_tokens_per_run: 400000 }
  external_mcp: []           # [{name, transport: stdio|http, command, args, url, tools, agents, risk}]
  http: { enabled: true }    # local CI API under /agent/ (needs MCP on)
  otel: { enabled: false, exporter: stdout, endpoint: "" }
pipeline:
  retry_failed: 1            # a flow that passes on retry is recorded as flaky
safety:
  allowed_post_offices: ["GLOBAL*"]   # required when enabled; data-changing flows only on these test branches
  production_env_names: [prod, production]
  data_changing_flows: ["02_order/*", "*/02_order/*"]   # pipeline stops for approval
```

Safety rules (production env, data-changing flows, allowed test branches in `allowed_post_offices`) apply to the agent team only. A run that touches them waits for a person in the app; nobody can approve over HTTP.

`external_mcp` gives the team extra MCP servers with an explicit tool allowlist and target agents (`coordinator`, `flowfixer`). `risk` left out means every call asks; `flowfixer` accepts only `risk: read`. Pipeline agents never get external MCP.

## 2. Drive the team from outside

Same port and token as MCP. Conditions: app open, the user who enabled MCP signed in, MCP on, `agent.enabled: true` and `agent.http.enabled: true`. Meant for a self-hosted CI runner on the app machine.

**Pipeline over HTTP**:

```bash
export CHATQA_MCP_TOKEN=...   # token shown when MCP was enabled
curl -s -X POST http://127.0.0.1:39017/agent/pipeline \
  -H "Authorization: Bearer $CHATQA_MCP_TOKEN" -H "Content-Type: application/json" \
  -d '{"repo":"/Users/qa/code/myapp","from":"v1.4.0","to":"v1.5.0"}'
# 202 {"sessionId":"…","statusUrl":"/agent/pipeline/…"}

curl -s http://127.0.0.1:39017/agent/pipeline/<sessionId> -H "Authorization: Bearer $CHATQA_MCP_TOKEN"
# {"status":"running|waiting_approval|done|failed","failed":false,"flaky":[…],"report":"…","pending":[…]}
```

`repo` is an absolute path; `to` empty = HEAD; `"mergeBase": true` for PR-style diffs. The run also appears in the app chat.

**Pipeline CLI** (same env var):

```bash
"/Applications/ChatQASoftware.app/Contents/MacOS/ChatQASoftware" --pipeline --repo . --from v1.4.0 --to v1.5.0 --wait
```

`--poll` (default 5s), `--timeout` (default 2h). Exit codes: 0 started or all passed, 1 error or run broke, 2 bad arguments or missing token, 3 done with failing flows, 4 waiting for approval in the app, 5 timeout (pipeline keeps running).

**ADK REST chat** (text only, signed-in user only):

```bash
curl -s -X POST http://127.0.0.1:39017/agent/apps/chatqa/users/<user>/sessions -H "Authorization: Bearer $CHATQA_MCP_TOKEN"
curl -s -X POST http://127.0.0.1:39017/agent/run_sse -H "Authorization: Bearer $CHATQA_MCP_TOKEN" -H "Content-Type: application/json" \
  -d '{"appName":"chatqa","userId":"<user>","sessionId":"<id>","newMessage":{"role":"user","parts":[{"text":"chạy flow login trên Android"}]}}'
```

Available: `POST /agent/run`, `POST /agent/run_sse`, `GET|POST /agent/apps/chatqa/users/<user>/sessions[/<id>]`, `GET /agent/list-apps`, `GET /agent/health`, `GET /agent/version`. One run per session at a time (409 when busy). Errors: 401 token, 403 foreign origin / other user / blocked request, 404 `agent.http` off, 503 team not ready.

## 3. Build your own ADK agent on ChatQA MCP

Any ADK agent can use ChatQA as an MCP toolset over streamable HTTP with the bearer token. Keep a `tool_filter` so the agent only sees what it needs, and keep the app's guarantees: it still enforces permissions, budget and redaction on every call.

**Python** (`pip install "google-adk[mcp]"`: the plain `google-adk` package lacks the MCP client and `McpToolset` fails to import):

```python
import os
from google.adk.agents import LlmAgent
from google.adk.tools.mcp_tool import McpToolset
from google.adk.tools.mcp_tool.mcp_session_manager import StreamableHTTPConnectionParams

chatqa = McpToolset(
    connection_params=StreamableHTTPConnectionParams(
        url="http://127.0.0.1:39017/mcp",
        headers={"Authorization": f"Bearer {os.environ['CHATQA_MCP_TOKEN']}"},
        timeout=30,
        sse_read_timeout=300,
    ),
    tool_filter=["tower_fleet", "test_flows", "test_run", "tower_wait_task", "test_report"],
)

root_agent = LlmAgent(
    model="gemini-flash-latest",
    name="chatqa_smoke",
    instruction=(
        "Run the smoke flows of the app the user names on one free device per platform. "
        "test_run returns status running with a taskId after 60s: poll tower_wait_task with timeout_sec 60, "
        "then read test_report. Report pass/fail per device and the failing step. Never ask for secret values."
    ),
    tools=[chatqa],
)
```

**Go** (ADK Go v2, as the app does for external MCP):

```go
import (
	"net/http"
	"os"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"google.golang.org/adk/v2/tool"
	"google.golang.org/adk/v2/tool/mcptoolset"
)

type bearer struct{ token string }

func (b bearer) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.Header.Set("Authorization", "Bearer "+b.token)
	return http.DefaultTransport.RoundTrip(r)
}

chatqa, err := mcptoolset.New(mcptoolset.Config{
	Client: mcp.NewClient(&mcp.Implementation{Name: "my-qa-agent", Version: "1"}, nil),
	Transport: &mcp.StreamableClientTransport{
		Endpoint:   "http://127.0.0.1:39017/mcp",
		HTTPClient: &http.Client{Transport: bearer{os.Getenv("CHATQA_MCP_TOKEN")}},
	},
})
// then: llmagent.Config{..., Toolsets: []tool.Toolset{tool.FilterToolset(chatqa, tool.AllowedToolsPredicate([]string{"test_run", "tower_wait_task", "test_report"}))}}
```

Tips for your own agent:

- Split roles like the built-in team: a planner with read tools (`test_git_diff`, `test_flows`, `test_metrics`), a runner with `test_run` / `tower_dispatch` / `tower_wait_task` / `test_report`, a reporter with no tools.
- Use ADK confirmation (`require_confirmation`) on tools that run data-changing flows or save flows.
- Long runs: keep each tool call under your client timeout and poll `tower_wait_task`, never re-dispatch.
- The token is personal and grants device control on that machine. Read it from the environment; never log it.
