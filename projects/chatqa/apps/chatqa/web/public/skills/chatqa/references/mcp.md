# ChatQA MCP reference

The MCP server runs inside the ChatQASoftware app, listens only on this machine, and acts with the rights of the signed-in user. Closing the app or signing out drops the connection. Every call goes through the same permission check, budget gate, command journal and secret redaction as the app UI.

## 1. Connect a client

Prerequisites: the app is open and signed in; **Điều phối → Kết nối AI (MCP) → Bật MCP** is on. The app shows the URL (default `http://127.0.0.1:39017/mcp`), the token once (**Cấp token mới** issues a new one and kills the old), and a ready config per client with the token and the app path filled in. Devices must be plugged in or simulators running; for browsers, install the runner once in **Cài đặt › Kiểm thử › Trình duyệt** and add a browser profile.

Never put the token in git, in chat, or in a shared file.

**Claude Code** (HTTP):

```bash
claude mcp add --scope user --transport http chatqa http://127.0.0.1:39017/mcp --header "Authorization: Bearer <token>"
claude mcp list   # chatqa: connected
```

Run it in a terminal outside the agent chat so the token never enters a transcript. `--scope user` registers it for every project (default scope is the current folder only). Start a new session afterwards. Tools appear as `mcp__chatqa__<tool>`. Allow `mcp__chatqa__*` in `/permissions` to stop per-call prompts; headless: `claude -p --allowedTools 'mcp__chatqa__*' < prompt.txt`.

**Claude Desktop** (stdio, the app binary relays to the running app). Add to `claude_desktop_config.json` (Settings → Developer → Edit Config), then quit and reopen:

```json
{
  "mcpServers": {
    "chatqa": {
      "command": "/Applications/ChatQASoftware.app/Contents/MacOS/ChatQASoftware",
      "args": ["--mcp"],
      "env": { "CHATQA_MCP_TOKEN": "<token>" }
    }
  }
}
```

Windows: `command` is the path to `ChatQASoftware.exe`, with `\\` in JSON.

**Codex CLI** (token from the environment). `~/.codex/config.toml`:

```toml
[mcp_servers.chatqa]
url = "http://127.0.0.1:39017/mcp"
bearer_token_env_var = "CHATQA_MCP_TOKEN"
default_tools_approval_mode = "approve"
```

Then `export CHATQA_MCP_TOKEN='<token>'` (PowerShell: `$env:CHATQA_MCP_TOKEN = '<token>'`). `default_tools_approval_mode = "approve"` is required for `codex exec`, which otherwise blocks every writing tool.

**Cursor**. `~/.cursor/mcp.json`, then reopen Cursor:

```json
{ "mcpServers": { "chatqa": { "url": "http://127.0.0.1:39017/mcp", "headers": { "Authorization": "Bearer <token>" } } } }
```

**ChatGPT**: not supported. Its connectors call from OpenAI servers and the ChatQA server only listens locally.

Connection errors: refused (app closed / MCP off), 401 (wrong or replaced token), 403 (another user signed in, or nobody). Port 39017 taken: change `mcp.port` in the app, re-enable MCP, update the client URL.

## 2. Tool map

| Group | Tools | Use |
|---|---|---|
| Fleet and tasks | `tower_health`, `tower_fleet`, `tower_tasks`, `tower_dispatch`, `tower_wait_task`, `tower_replay_failed`, `tower_report`, `tower_device_report`, `tower_alerts`, `tower_budget`, `tower_deliveries`, `tower_pause_all` | Who is free, queue runs across devices, wait, re-run failures, budget and alerts |
| Device | `device_ui_state`, `device_screenshot`, `device_tap`, `device_swipe` | Read the screen (text, refs, 0..1 boxes), screenshot, tap and swipe in 0..1 coordinates. On web profiles tap = click, swipe = scroll |
| Browser | `web_navigate`, `web_click`, `web_fill`, `web_select`, `web_press`, `web_back`, `web_wait` | Drive a `web-*` profile with `ref` + `snapshot_id` or a Playwright locator |
| Flows | `test_flows`, `test_get_flow`, `test_validate`, `test_run`, `test_stop`, `test_report`, `test_compare`, `test_metrics`, `test_save_flow`, `test_save_result`, `test_compile`, `test_repair`, `test_apply_repair`, `test_delete_flow`, `test_set_env`, `test_export_spec`, `test_git_diff` | List, lint, run, read reports, author, repair, export, impact analysis |
| Docs | `docs_list`, `docs_get`, `docs_requirements`, `docs_update`, `docs_affected_cases`, `docs_coverage` | Requirement docs, traceability, coverage |
| Sync | `sync_status`, `sync_pull`, `sync_push` | Team sync over the company's S3/MinIO |

Device tools accept `device_id` or `id` (also `deviceId`, `serial`, `udid`), case-insensitive, or a unique device name. Unknown id → `not_found` with the valid ids.

## 3. Running

- `test_run` waits up to `wait_sec` (default 60). Not done → `status: running` + `taskId`; the run continues and shows in `tower_tasks`. Poll `tower_wait_task` with `timeout_sec` < 70, then `test_report`.
- `tower_dispatch` picks devices by flow type: `.yaml` runs on phones, `.spec.ts` on browser profiles. `filter.platform` accepts `android`, `ios`, `web`; `filter.count` applies per type (`count: 1` with one YAML and one spec = 1 phone + 1 browser, in parallel). A missing device type is never skipped silently: `no_device_available`, or an `environment` failure when explicit `devices` lack that type.
- Typing speed: 5 keys/s on iOS, 10 on Android by default; override with `typing_frequency` on `test_run`, `test_save_flow`, `tower_dispatch`.
- Screenshots are downscaled to 720 px JPEG by default; pass `max_width` (160 to 2400) or `format: "png"` when you need detail.

## 4. Variables and secrets

- Plain variables: `test_set_env` stores defaults per app and platform (`all`, `ios`, `android`, `web`). Merge order for a run: `all` defaults, platform defaults, run `env`, then `secrets`. `test_flows` returns `envDefaults` and `secretNames`.
- A flow using `${NAME}` with no value is refused with `env_missing` instead of typing "undefined". `${...}` takes a variable name only; branch with `when: {true: ${NAME}}`.
- Secrets: the user sets them in the app at **Cài đặt › Kiểm thử › Biến bí mật** (right `cqs.credentials`; one store for all apps, values cannot be read back). You pass names: `secrets: ["PASSWORD"]`; YAML uses `${PASSWORD}`; `web_fill` takes `text: "${PASSWORD}"`; specs read `process.env.PASSWORD` as the value of `fill`. Values are redacted verbatim in results, locators, URLs, snapshots and reports. Runs with secrets only work on Chromium, Chrome or Edge profiles.
- Reserved names are refused: `NODE_*`, `PLAYWRIGHT_*`, `PWDEBUG`, `PW_*`, `CQS_*`, `DYLD_*`, `LD_*`, `*_PROXY`.
- Use test accounts, never real ones.

## 5. Authoring flows

| Tool | Who writes | App AI cost |
|---|---|---|
| `test_save_flow` | You, after reading `device_ui_state`: `yaml` for phones, `script` for browser profiles (exactly one) | None |
| `test_compile` | The app's AI, from docs or case descriptions; on a browser profile it opens `start_path` (default `/`) and writes `.spec.ts` | Monthly budget; above the per-action cap the user confirms in the app |

Both save only after one verification run passes. Results: `saved`, `invalid` (with errors to fix), `failed_verification` (with run id; candidate kept hidden), or `running` + `saveId` (poll `test_save_result`; calling `test_save_flow` again for the same flow returns the run in progress). Existing names are overwritten only with `replace: true`.

**Maestro YAML** is refused when: syntax error, literal secret value, `runScript` / `evalScript` / `openLink` / `addMedia`, or `${...}` that is not a variable name.

**Playwright `.spec.ts`** (name must end in `.spec.ts`):

```ts
import { test, expect, step } from './chatqa';

test('đăng nhập', async ({ page }) => {
  await step('mở trang đăng nhập', async () => {
    await page.goto('/login');
  });
  await step('điền tài khoản', async () => {
    await page.getByLabel('Email').fill(process.env.USERNAME);
    await page.getByLabel('Mật khẩu').fill(process.env.PASSWORD);
    await page.getByRole('button', { name: 'Đăng nhập' }).click();
  });
  await step('vào trang đơn hàng', async () => {
    await expect(page).toHaveURL('/orders');
  });
});
```

Refused (with file and line): other imports, `require`, `import()`, `evaluate*`, `route*`, `context`, `request`, `new`, `constructor`, `[]` access, tagged templates, loops, `try`, non-literal or off-allowlist URLs in `goto` / `waitForURL` / `toHaveURL`, `process.env.X` anywhere except the value of `fill` / `pressSequentially` / `keyboard.type`, unknown variable names, literal secrets. Prefer locators returned by `web_*` tools.

`test_repair` on a web flow reruns twice, stops without AI on environment errors, otherwise proposes replacing exactly one `step()` block and test-runs it; save with `test_apply_repair`.

Each `.spec.ts` runs in a fresh browser context and may only import `./chatqa`, so a flow behind login carries its own login steps.

`test_get_flow` returns a saved flow's exact source (YAML, `common/` subflow or `.spec.ts`; hidden candidates are refused). Copy login steps from it instead of rediscovering the page.

`test_export_spec` (`app`, `name`, optional `device_id` for baseURL) writes a zip under the app data `exports/` folder: unzip, `npm install`, `npx playwright install chromium`, set the README variables, `npx playwright test` (verified to pass unchanged). No values, traces or run files inside. `playwright.config.ts` carries the profile's baseURL: if it is `localhost` or another address CI cannot reach, tell the user to change it.

## 6. Browser control

Profiles have ids `web-<name>` and appear in `tower_fleet` with `platform: web`. `device_ui_state` returns `url`, `viewport`, `snapshotId` (`<gen>-<n>`), then elements with `[ref=eN]` and `[box=x,y,w,h]`. `web_click` / `web_fill` / `web_select` take `ref` + `snapshot_id` of that snapshot, or a Playwright locator such as `getByRole('button', { name: 'Đăng nhập' })`; send every field, empty when unused. Results include the normalised locator, new `url`, new `snapshotId`; a screenshot only with `screenshot: true`.

`web_navigate` takes a path relative to the profile baseURL or an absolute http(s) URL. Hosts outside the profile allowlist are blocked, including via redirects, popups and WebSockets (`web_host_blocked`): do not retry, ask the user to edit the profile.

## 7. Impact, docs, sync

- `test_git_diff`: `repo`, `commit_a`, `commit_b`, optional `merge_base`, `paths`, `max_lines` (default 60 per file), `out_dir`. Saves the full diff as JSON and returns `diffPath`, a compact diff and `analysis`. You write the report; the app spends no AI.
- `docs_update` (right `cqs.run`) overwrites the whole document: read with `docs_get`, send full Markdown back, keep existing `{#...}` anchors. Duplicate ids across two docs make `test_compile` return `invalid`.
- `sync_pull` / `sync_push` (`apps` empty = all apps) never overwrite conflicting files: they come back in `conflicts`, the user merges in **Kiểm thử › Đồng bộ**. `sync_push` with `run_id` shares redacted evidence; above 200 MB it returns `evidence_confirm_required`. `not_signed_in` / `sync_not_configured` mean the user must act in the app.

## 8. Errors

| Error | Meaning and action |
|---|---|
| `permission_denied` | Account lacks a right (e.g. `cqs.run`). Admin grants it |
| `confirm_required` | Cost above the per-action cap. User confirms on the card in the app |
| `device_not_ready` | Device busy, held, or disconnected. Check `tower_fleet`; wait for the run to finish |
| `no_device_available` | No free device of that type for the filter |
| `env_missing` / `secret_missing` | Missing variable / secret name. Set with `test_set_env`; secrets only in the app |
| `invalid` | Bad arguments or flow rules; the message says what to fix |
| `failed_verification` | Verification run failed. `test_report` with the run id |
| `web_stale_ref` | Old snapshot. `device_ui_state`, then use new refs |
| `web_host_blocked` | Host outside allowlist. Do not retry |
| `web_runtime_missing` | Browser runner not installed. User installs it in Settings |
| `web_sidecar_failed` | Browser driver crashed. Retry once; restart the app if it repeats |
