# ChatQASoftware

> Part of [OpenWork](../../README.md).

A QA workbench that runs on your own machine. It drives **Maestro** flows on real Android and iOS devices and
**Playwright** flows in browsers, records evidence, and exposes everything through a local **MCP server** so an AI
agent can run, write and repair test flows for you. The UI ships twice from one codebase: a desktop app (Wails)
and a PWA.

**Use it as a base for:** a Wails desktop app with a React front end, a local MCP server that wraps device and
browser tooling, an agent-driven test loop (the agent proposes a flow, the engine runs it, evidence comes back),
and a front-end shell package shared between a desktop build and a PWA.

## What it does

- Runs Maestro flows on connected devices and Playwright flows in browsers, with run reports and evidence.
- Local MCP server with `tower_*`, `device_*`, `web_*`, `test_*`, `docs_*` and `sync_*` tools.
- Analyses a git diff to suggest which flows to run, and generates cases from requirement documents.
- Team sync of QA files, plus an agent chat that can call the same tools.
- Vietnamese UI strings; the code and tool names are English.

## Layout

```
apps/chatqa/desktop/   Go + Wails app: test engine, device and browser control, MCP tools, agent, team sync
apps/chatqa/web/       React 19 + Vite UI, built as desktop bundle or PWA; Playwright visual and e2e tests
packages/go-core/      Go module shared by desktop apps (imported as `deskcore`)
packages/ui-shell/     Shared shell: sign-in, admin, desktop/PWA platform layer
contracts/             JSON contracts shared by Go and web (roles, permissions, errors, limits)
docs/brand/chatqa/     Logo and icon sources
```

## Run it

Requires Node 24, Go 1.27 and the [Wails CLI](https://wails.io) for the desktop build.

```bash
npm install                                  # from this folder, installs both web workspaces

cd apps/chatqa/web
npm run dev                                  # PWA in the browser
npm run check                                # typecheck + 266 unit tests

cd ../desktop
go build ./... && go test ./...              # engine, tools and MCP contract tests
wails dev                                    # desktop app with live reload
wails build                                  # packaged app
```

Real device runs need Android platform tools or Xcode, plus a connected device. The Maestro runner is a fork,
pinned in `desktop/go.mod`.

## Status

Working product code. Visual and live end-to-end suites (`npm run visual`, `playwright.live.config.mjs`)
need devices and credentials and are not part of the quick check above.

## License

[MIT](LICENSE)
