# `@templatedesign/platform`

The product-agnostic core shared by templatedesign (`apps/web`) and TranscriptAnything
(`apps/transcript`): accounts, tenants, API keys, wallet and ledger, checkout and webhooks,
outbound webhooks with retries, email, admin roles/audit/settings, and account deletion.

It is a **workspace package of TypeScript sources** (`exports` point at `src/*.ts`), consumed by
Astro/Vite in the apps and by `tsx` in tests. Nothing here imports a product module.

## Ownership boundary

| Stays in the app | Moves to the platform |
|---|---|
| Templates, renderer, export/share, CSV, product jobs, product pages, product nav | `db`, `http`, `csrf`, `format`, `runtime`, `rate-limit` |
| Product prices (`packs.ts`), guest copy, product email paragraphs, product admin hooks | `auth`, `tenancy`, `principal`, `keys`, `credits`, `payments`, `billing`, `checkout`, `reconcile`, `alerts` |
|  | `admin`, `webhooks`, `emails/*`, `deletion` |

A product configures the platform once:

```ts
// apps/<app>/src/lib/platform.ts
import { createPlatform } from "@templatedesign/platform/config";

export const platform = createPlatform({
  brand: { name: "…", appOrigin: "…", emailFrom: "…" },
  packs,                       // the product's own price list
  guestPolicy: { dailyCredits, exceedingMessage, exhaustedMessage, signupPath },
  copy: { welcomeBody, dataNoun },
  locales: ["en", "vi"],
  scopes: { available, default },
  apiKeyPrefix: "td" | "tt",
  webhooks: { events },
  admin: {
    loadAccountJobs?,          // product job rows on the admin account page
    loadProductMetrics?,       // product numbers on /admin
    extraSettings?,            // product admin_settings keys with their validation kind
  },
  deletion: { purgeProductData? },
});
```

Import that module from the Worker entry, the middleware and the tests so every platform module
sees the values before it runs. `resetPlatformConfig()` restores the defaults for tests.

Products extend the bindings, never fork them:

```ts
import type { PlatformEnv } from "@templatedesign/platform/types";

export interface Env extends PlatformEnv {
  EXPORTS: R2Bucket;          // templatedesign
  MEDIA: R2Bucket;            // TranscriptAnything
}
```

## Migrations

There are two modes, both driven by `scripts/compose-migrations.mjs`:

- **Frozen app (templatedesign).** The app applied these files in production before the split, so
  `apps/web/migrations.manifest.json` records a SHA-256 per file. The composer never rewrites the
  directory and `--check` fails on any byte change. Renaming or editing an applied migration would
  make D1 run it again; this is the guard.
- **New app (TranscriptAnything).** `apps/transcript/migrations.manifest.json` composes
  `packages/platform/migrations/*.sql` followed by `apps/transcript/migrations.src/*.sql` into
  `apps/transcript/migrations/`, renumbered from 0001. The directory is generated; edit the sources
  and run `npm run compose:migrations`.

```bash
npm run compose:migrations         # write the generated directories
npm run check:migrations           # CI: frozen hashes + generated output are current
```

A schema change that both products need belongs in `packages/platform/migrations`; for the frozen
app it ships as a **new** migration in `apps/web/migrations`, never as an edit.

## OAuth for an MCP endpoint (opt-in)

An app that exposes an MCP endpoint to Claude or ChatGPT lists `"modules": ["oauth"]` in its
migrations manifest and passes `mcp: { resourcePath: "/mcp", scopes: [...], consentPath: "/connect/authorize" }`
to `createPlatform`. `createAuth` then adds Better Auth's `mcp` plugin: dynamic client registration,
authorization code with PKCE S256, opaque hashed tokens (15-minute access tokens, refresh tokens with
`offline_access`), one consent grant per user and client in `agent_grants`, and per-address rate limits
on registration (5/min) and the token endpoint (30/min). Apps without the option are unchanged.

`@templatedesign/platform/agents` gives the app what it mounts:

| Export | Mount on |
|---|---|
| `handleOAuthDiscovery(env, request)` | `/.well-known/*` (protected-resource and authorization-server metadata) |
| `handleAgentApi(env, request, session)` | `/api/agents*` (consent page data, connections list, revoke) |
| `withAgentAuthorization(env, request, handler)` | the MCP endpoint; `handler` receives `{ user, tenantId, scopes }` |
| `requireScope`, `listAgentGrants`, `revokeAgentGrant`, `agentConnectorUrl` | tools and account pages |

Registration, authorize, consent and token stay on Better Auth's `/api/auth/*` handler
(`/api/auth/oauth2/register`, `/authorize`, `/consent`, `/token`).

## Tests

`packages/platform/tests` applies the platform baseline **without any product table** and asserts
that a second, deliberately different product config (names, prices, quotas, scopes, webhook
events) takes effect. If a platform module starts depending on `templates`, `jobs` or `share_links`,
those tests fail.

```bash
npm run check:platform
npm run test:platform
```
