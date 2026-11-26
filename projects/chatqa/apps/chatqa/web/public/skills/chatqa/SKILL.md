---
name: chatqa
description: Drive ChatQASoftware, the QA app that runs Maestro flows on real Android/iOS devices and Playwright flows in browsers, through its local MCP server (tools tower_*, device_*, web_*, test_*, docs_*, sync_*) or its Google ADK agent team (/agent/ HTTP API, --pipeline CLI, your own ADK agent over MCP). Use when the user wants to run, write, repair or export test flows, read run reports and evidence, analyse a git diff for test impact, generate cases from requirement docs, sync QA files with the team, or wire ChatQA into CI. Also use when the user mentions ChatQA, ChatQASoftware, kiểm thử app, chạy flow, viết flow Maestro/Playwright, or the mcp__chatqa__ tools.
---

# ChatQA (ChatQASoftware)

ChatQASoftware is a desktop app (macOS, Windows) that owns the test devices: phones, simulators and browser profiles. It runs flows, keeps screenshots, video, logs and reports for every run, and enforces permissions, budget and secret redaction. You never touch devices directly. You either call its tools (MCP) or hand a job to its agent team (ADK).

| Way | Who reasons | When to pick it |
|---|---|---|
| **ChatQA MCP** | You, with the user's own AI account | Interactive work: look at a screen, write a flow, run, read the report, fix. Free with the app license |
| **ChatQA ADK Agent** | The team inside the app (coordinator, planner, runner, triage, reporter, flowfixer, author) | Hands-off jobs: git diff to report, CI after deploy, long pipelines that stop for human approval |

Details: `references/mcp.md` (setup per client, every tool, flow rules) and `references/adk.md` (agent team, `agent.yaml`, CI API, building your own ADK agent on ChatQA MCP). Read the one you need before acting; do not guess tool arguments.

## Step 0: check the connection

1. Look for tools named `chatqa` / `mcp__chatqa__*` (`tower_fleet`, `test_run`, ...). If present, call `tower_health` then `tower_fleet` and tell the user which devices are free.
2. If the tools are missing, the user has not connected yet. Walk them through it (full text in `references/mcp.md` §1):
   - Install and open ChatQASoftware, sign in.
   - In the app: **Điều phối → Kết nối AI (MCP) → Bật MCP**. The app shows the URL (`http://127.0.0.1:39017/mcp`) and a token **once**, plus a ready-made config for Claude Code, Claude Desktop, Codex and Cursor.
   - Claude Code: the user runs, **in a separate terminal window**, `claude mcp add --scope user --transport http chatqa http://127.0.0.1:39017/mcp --header "Authorization: Bearer <token>"`, then starts a new Claude Code session. `--scope user` makes it work in every project.
   - Never ask for the token and never put it in a command you run or suggest with `!`: anything typed in this chat, including `!` commands, lands in the transcript. Give the command with the `<token>` placeholder and let the user run it outside the chat, or paste the config the app shows into the client's config file.
3. Connection errors: refused = app closed or MCP off; 401 = old token (issue a new one in the app); 403 = a different user is signed in.

## Rules that keep runs safe and cheap

- **Secrets by name only.** Passwords live in the app's secret store, one store shared by every app and platform. Use `secrets: ["PASSWORD"]` and `${PASSWORD}` in flows. Never ask for, print or hard-code a secret value, even if the user typed it in chat; there is deliberately no tool to set one. When a name is missing (`test_flows` → `secretNames`, or `secret_missing`), ask the user to add it in **Cài đặt › Kiểm thử › Biến bí mật** (needs the `cqs.credentials` right), then continue.
- **Read before you look.** `device_ui_state` gives text, refs and 0..1 boxes and is far lighter than `device_screenshot`. Screenshot only when layout or visuals matter.
- **Long runs.** MCP clients time out around 80 s. `test_run` and `test_save_flow` return `status: running` with a `taskId` / `saveId` after `wait_sec` (default 60). Then call `tower_wait_task` with `timeout_sec` under 70, or `test_save_result`, and loop. Do not start the same run again.
- **Flows are saved only after they pass.** Write with `test_save_flow` (you author, no app AI cost) or `test_compile` (the app's AI authors from docs, costs budget). A failed verification returns `failed_verification` + run id: read `test_report`, fix, retry at most 2 times, then report. Overwrite an existing flow only with `replace: true` when the user asked.
- **Do not retry what a person must fix:** `web_host_blocked` (host not in profile allowlist), `confirm_required` (cost above per-action cap, user confirms in the app), sync `conflicts` (user merges in the app), `permission_denied` (admin grants the right), `web_runtime_missing` (install the browser runtime in Settings). Explain and stop.
- **Data-changing and production runs:** ask the user before running flows that create orders, pay, delete or send, or that target production env values.
- Device ids are case-insensitive; a unique device name also works. Web profiles are `web-<name>`.

## Recipes

**Run flows and report.** `tower_fleet` → `test_flows` (app, flow names, `envDefaults`, `secretNames`) → `tower_dispatch` (several devices, `filter: {platform, count}`) or `test_run` (one device) → `tower_wait_task` → `test_report`. Summarise pass/fail per device, p50/p95, the failing step and its screenshot reference. `tower_replay_failed` re-runs failures of a task.

**Write a phone flow (Maestro YAML).** Open the screen on the device, `device_ui_state`, draft the YAML using `${VARS}`, `test_save_flow` with `yaml`, name like `02_login.yaml`. Forbidden: `runScript`, `evalScript`, `openLink`, `addMedia`, literal secrets. Use `test_validate` to lint first.

**Write a web flow (Playwright `.spec.ts`).** On a `web-*` profile: `web_navigate` `/login` → `device_ui_state` (refs `[ref=eN]` + `snapshotId`) → `web_fill` / `web_click` with `ref` + `snapshot_id` (or a Playwright locator) → reuse the normalised locators the tools return. Save with `test_save_flow` and `script`. Template: `import { test, expect, step } from './chatqa';` and every action inside `await step('name', async () => { ... })`. Strict rules (no loops, `try`, `evaluate`, computed URLs, secrets outside `fill`) are in `references/mcp.md` §5. `web_stale_ref` → read `device_ui_state` again. Each spec starts in a fresh browser with no session and cannot import another flow, so a spec behind login repeats the login steps itself; the live `web-*` profile may also be logged out between tasks.

**Reuse a saved flow.** `test_get_flow` (`app`, `name`) returns the exact source of a saved YAML flow, a subflow (`common/<name>.yaml`) or a `.spec.ts`. Read it before writing a flow that repeats steps such as login, or before fixing one. Older app versions without this tool: export a web flow with `test_export_spec` and read `tests/<name>` in the zip.

**Impact of a code change.** `test_git_diff` with `repo` (absolute path on the app machine), `commit_a`, `commit_b` (empty = HEAD), `merge_base: true` for PR-style. It returns a compact diff and an `analysis` brief; you write the report (summary, risks, likely bugs, test plan, questions for devs, which flows to run). Narrow big diffs with `paths`.

**Requirements and coverage.** `docs_list` / `docs_get` / `docs_requirements` read docs with ids like `REQ-012`, `AC-03`. After a requirement changes: `docs_affected_cases` → `test_compile` with `reqs` = union of their ids. `docs_coverage` shows requirement ↔ case ↔ last result; requirements without cases are untested. `docs_update` overwrites a whole doc: `docs_get` first, keep every `{#...}` anchor.

**Repair a failing flow.** `test_report` → `test_repair` (proposes a checked fix) → show the user → `test_apply_repair`.

**Team sync and CI export.** `sync_status` / `sync_pull` / `sync_push` (S3 configured in the app). `test_export_spec` zips a `.spec.ts` to run with plain `npx playwright test` in CI.

**Hand a whole job to the agent team.** When the user wants git diff → plan → run → triage → report without watching, use the ADK team: in-app chat, `ChatQASoftware --pipeline --repo . --from v1.4.0 --to v1.5.0 --wait`, or `POST /agent/pipeline`. Approvals happen only in the app. See `references/adk.md`.

## Reporting back

Lead with the outcome (passed/failed, which devices), then the failing step, the cause, evidence (run id, screenshot and trace paths from `test_report`) and the next action. `test_report` classes each failure as `product` (an assertion failed: the app or its data is wrong), `automation` (the flow is wrong: element not found, broken selector) or `environment` (device, browser, driver, blocked host); only `automation` is fixed by editing the flow. The ADK team's triage uses finer labels: `app`, `selector`, `data`, `environment`. Keep secret names, never values.
