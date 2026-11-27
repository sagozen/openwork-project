# ImageFactory

> Part of [OpenWork](../../README.md). Shared code lives in [`packages/`](../../packages).

**Use it as a base for:** A paid MCP connector: OAuth consent for AI clients, a credit wallet with reservation and settlement, a REST API for n8n/Make, per-tenant isolation tests, and a provider job queue with webhook and sweep fallbacks.

Branded AI images through an MCP connector. You add `https://imagefactory.zhst.app/mcp` to Claude (web,
Chrome extension, Desktop) or ChatGPT, save a brand kit once, and ask for Pinterest pins, blog heroes and
book-cover concepts. Each image is stored in R2 behind a stable public URL and costs credits from the
account's wallet. There is no editor: the AI client is the interface. The same service is available over
HTTP with an API key for n8n, Make and Postiz.

Guides: [connect guide](../../docs/imagefactory/connect-guide.md) ·
[deploy and operations](../../docs/imagefactory/deploy-and-operations.md) ·
[decision record](../../docs/decisions/0002-oauth-mcp-platform-module.md).

```bash
npm run dev:imagefactory        # http://localhost:4334
npm run check:imagefactory
npm run test:imagefactory
npm run build:imagefactory
npm run preflight:imagefactory  # deploy blockers; lists missing resources and secrets
./deploy-cf.sh imagefactory     # gates, D1 migrations, deploy, then scripts/smoke-imagefactory.sh
```

Copy `.dev.vars.example` to `.dev.vars` first. It sets `EMAIL_PROVIDER=console`, so the magic link prints to
the terminal. Generating needs `FAL_KEY`; fal.ai cannot call a localhost webhook, so local jobs finish through
`get_job` or the sweep unless you use a tunnel. `node scripts/imagefactory-fal-smoke.mjs` runs one real generate and one real
edit against fal.ai (about $0.05) and prints timings and file sizes.

## Routes

| Route | Purpose |
|---|---|
| `/` | What it does and the connector URL |
| `/sign-in` | Magic link, plus Google when configured |
| `/connect/authorize` | OAuth sign-in and consent for a connecting client |
| `/account` | Credits, connector URL, connected apps, API keys, account deletion |
| `/admin/*` | Overview, accounts and credit adjustments, image jobs, settings, roles, audit |
| `/mcp` | MCP endpoint (streamable HTTP, stateless) |
| `/.well-known/oauth-*` | OAuth discovery for the connector |
| `/api/auth/*` | Better Auth, including OAuth registration, authorize and token |
| `/api/agents/*` | Connected apps list, revoke, consent decision (signed-in session) |
| `/api/v1/*` | REST API for API keys, plus session routes for the account page |
| `/api/v1/fal-webhook` | fal.ai completion callback (signature verified) |
| `/i/<id>.<ext>` | Public image host; the 128-bit id is the capability |
| `/i/ref/<asset>?exp&sig` | Ten-minute signed link the provider uses to fetch a private brand reference |

## MCP tools

Read scope (`images:read`): `list_brands`, `get_brand`, `list_presets`, `estimate_cost`, `get_job`,
`list_images`, `get_image`, `get_balance`.
Write scope (`images:write`): `create_brand`, `update_brand`, `add_brand_asset`, `remove_brand_asset`
(destructive), `delete_brand` (destructive), `generate_image`, `edit_image`, `delete_image` (destructive).

No tool takes a tenant or user id: the account comes from the token. Every input schema is strict.
Failures return `{ code, message }` with one of `INSUFFICIENT_CREDITS`, `INSUFFICIENT_SCOPE`, `INVALID_INPUT`,
`NOT_FOUND`, `PROVIDER_ERROR`, `CONTENT_BLOCKED`, `VALIDATION_ERROR`, `INTERNAL_ERROR`. The REST API maps
the same codes to 402, 403, 422, 404, 502, 422, 422 and 500.

## REST API

All routes take `Authorization: Bearer if_live_...`. `images:write` is needed for generate, edit and delete.

| Route | Same as tool |
|---|---|
| `GET /api/v1/brands`, `GET /api/v1/presets`, `GET /api/v1/balance` | `list_brands`, `list_presets`, `get_balance` |
| `POST /api/v1/images/generate` | `generate_image`. `?wait=false` returns 202 and a `job_id` |
| `POST /api/v1/images/edit` | `edit_image` |
| `GET /api/v1/jobs/{id}` | `get_job`: 202 while running, 200 with images when done |
| `GET /api/v1/images`, `GET`/`DELETE /api/v1/images/{id}` | `list_images`, `get_image`, `delete_image` |

Brand kits are created and edited through the MCP tools only.

## How a generation works

1. The tool validates the request, composes the prompt (brand style, palette, typography, exact text) and
   reserves `ceil(megapixels) x credits per MP x images` credits.
2. While a registered worker (an OpenClaw agent, see [the worker runbook](../../docs/imagefactory/openclaw-worker.md))
   is online, the job is queued for it and the worker pulls it. Otherwise, or if the worker stalls or fails twice,
   the job is submitted to the fal.ai queue API with a webhook URL.
3. The tool polls for up to 45 seconds. If the job is still running it returns a `job_id`.
4. When the worker uploads its files, or when fal.ai finishes, the webhook, the in-tool poll or the five-minute sweep (whichever comes first)
   claims the job, copies each image into R2 and settles the credits in one database batch. Images the safety
   check blocked are not stored and not charged. A failed job releases the whole reservation.

Models (fal.ai): `qwen-image` is `fal-ai/qwen-image-2512` (4 credits per MP by default) and `qwen-edit` is
`fal-ai/qwen-image-edit-2511` (6 credits per MP). One credit is one US cent. The size presets
(`pin` 816x1224, `pin_hd` 1152x1728, `square` 992x992, `blog_hero` 1280x720, `cover_6x9` 1024x1536) are kept under
whole megapixels because the provider bills every started megapixel.

## Data

`image_jobs`, `images`, `brand_kits`, `brand_assets` (every row has `tenant_id` and an index that starts with
it), the shared `workers` registry (no tenant: it is operations infrastructure), plus the platform wallet, ledger, API key and admin tables and the OAuth module tables. Source SQL is in
`migrations.src/`; run `npm run compose:migrations -w @templatedesign/imagefactory` after editing it and never edit
`migrations/` by hand.

## Configuration

| Name | Kind | Purpose |
|---|---|---|
| `BETTER_AUTH_SECRET` | secret | Session and token signing; also signs reference links |
| `FAL_KEY` | secret | fal.ai API key |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | secret, optional pair | Google sign-in |
| `APP_ORIGIN`, `BETTER_AUTH_URL` | var | `https://imagefactory.zhst.app` |
| `ADMIN_EMAILS` | var | First admin accounts and digest recipients |
| `EMAIL_FROM`, `EMAIL_PROVIDER` | var | Transactional email |
| `IMAGE_PUBLIC_BASE` | var | Public prefix generated images are served from |

Bindings: `DB` (D1), `SESSION` (KV), `IMAGES` (R2), `EMAIL` (send_email).
Admin settings (no deploy needed): `generation.enabled`, `generation.max_images_per_call`,
`generation.rate_per_minute`, `pricing.<model>.credits_per_mp`, `free_monthly_credits`.

## Isolation

Every business table is queried with a `tenant_id` predicate, and `tests/isolation.test.ts` replays every
tool as a second account against the first account's ids and fails on any query without the predicate.
Generated images are public by design (served with a one-year immutable cache, so a deleted image can linger in caches that already fetched it); brand reference images are private.

## Contributing

Issues and pull requests are welcome. Read the [contributing guide](../../CONTRIBUTING.md) first; the checks
for this project are `npm run check:imagefactory && npm run test:imagefactory`, run from the repository root.

## License

[MIT](LICENSE)
