# 0002 — OAuth and MCP as an opt-in platform module

- Status: **accepted**
- Date: 2026-11-06
- Owner: product owner
- Sources: `plans/261106-1950-imagefactory-mcp-mvp1/plan.md` (decisions D1 to D4), `packages/platform/README.md`

## Context

ImageFactory is used from AI clients (Claude, ChatGPT) that connect to a remote MCP server and need OAuth 2.1
with dynamic client registration and PKCE. The monorepo already owns sign-in (Better Auth magic link and Google),
tenancy, the wallet and ledger, API keys and the admin console in `packages/platform`. A working OAuth MCP
server already exists in a sibling repository (`hosting-platform`) on the same Better Auth stack.

## Decision

1. ImageFactory is an app in this monorepo (`apps/imagefactory`), not a separate repository.
2. OAuth uses Better Auth's `@better-auth/mcp` and `@better-auth/oauth-provider`, pinned to the platform's
   `better-auth` version. A connector sign-in is the ordinary ImageFactory sign-in, on the same user table.
3. The OAuth server is an **opt-in platform module**: an app passes `createPlatform({ mcp: { resourcePath,
   scopes, consentPath } })` and lists `"modules": ["oauth"]` in its migrations manifest. `createAuth` adds the
   plugin only when `mcp` is set. Apps that do not opt in (transcript, puzzle, restaurant, erp, ota, web) receive no
   plugin, no tables and no endpoints, and their composed migrations are byte-identical.
4. The platform exports `@templatedesign/platform/agents`: `withAgentAuthorization`, `requireScope`,
   `listAgentGrants`, `revokeAgentGrant`, `agentConnectorUrl`, `handleOAuthDiscovery` and `handleAgentApi`. The app
   mounts them on its own routes and owns the consent page.
5. Tokens are opaque and stored hashed. A connection is an `agent_grants` row with a generation; revoking rotates
   the generation and deletes tokens, consents and pending codes in one batch, so a revoked connection fails on its
   next request. API keys (`if_live_...`) are a second way in to the same tools and REST routes through one
   function, so scope and tenant handling is identical.
6. The MCP transport is stateless streamable HTTP at `/mcp`; the legacy SSE transport is not offered.

## Consequences

- A new module adds tables to a tenant-level auth store; they are listed in the tenant-isolation exceptions in the
  root `CLAUDE.md`.
- OAuth endpoints need a rate limit (dynamic registration and token) and a cap on registered clients; the module
  carries both.
- Account deletion removes grants with the account (the migration cascades from the user table); tokens are not
  revoked during the 30-day grace period, only at the final purge.
- The first real-client run (Claude, ChatGPT) is the real acceptance test for the consent flow; see the deploy guide.

## Update 2026-11-22: second consumer

`apps/myartifacts` (file transfer and storage on Contabo S3) is the second app to opt into the module, with the
same wiring (`createPlatform({ mcp })`, `"modules": ["oauth"]`, the `@templatedesign/platform/agents` routes). It
adds **owner-only mode** on top: with `OWNER_EMAILS` set the platform refuses sign-in for any other address, and the
app also checks the owner on the consent decision and on every API key and connector token, so removing an address
from the list cuts off what was issued to it. Its API keys use the prefix `ma_live_`.
