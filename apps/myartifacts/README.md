# MyArtifacts

> Part of [OpenWork](../../README.md). Shared code lives in [`packages/`](../../packages).

**Use it as a base for:** An owner-only MCP + REST service: presigned uploads to any S3-compatible bucket, share links with passwords and expiry, SSRF-guarded URL import, and a strict allowlist of who may sign in.

File transfer and storage driven through an MCP connector. You add `https://myartifacts.zhst.app/mcp` to Claude
(web, Desktop, Code) or ChatGPT, then ask it to save a file, hand someone a link to view or download it, and
switch that link off later. Files live in one private Contabo Object Storage bucket (S3 compatible), not in R2;
D1 holds only metadata. The same operations are available over HTTP with an API key for n8n and scripts.

The app is owner-only: sign-in, connector consent, API keys and connector tokens are refused for any address
that is not in `OWNER_EMAILS`. There is no billing, quota or per-account limit.

Guides: [connect guide](../../docs/myartifacts/connect-guide.md) ·
[deploy and operations](../../docs/myartifacts/deploy-and-operations.md) ·
[decision record](../../docs/decisions/0002-oauth-mcp-platform-module.md).

```bash
npm run dev:myartifacts        # http://localhost:4336
npm run check:myartifacts
npm run test:myartifacts
npm run build:myartifacts
npm run preflight:myartifacts  # deploy blockers; lists missing resources and secrets
./deploy-cf.sh myartifacts     # gates, D1 migrations, deploy, then scripts/smoke-myartifacts.sh
```

Copy `.dev.vars.example` to `.dev.vars` first. It sets `EMAIL_PROVIDER=console`, so the magic link prints to the
terminal, and `OWNER_EMAILS`, which must contain the address you sign in with. Storage needs real `S3_*` values
for a bucket you can write test objects to; without them `/api/v1/health` reports the store as down. Before the
first deploy run `npx tsx scripts/contabo-s3-smoke.mjs` (see the deploy guide): it writes, reads and deletes a few
tiny objects and prints the signing region the provider accepts.

## Routes

| Route | Purpose |
|---|---|
| `/` | Private (`noindex`) landing: what it does, the connector URL, privacy notes |
| `/sign-in` | Magic link, plus Google when configured. Owner addresses only |
| `/connect/authorize` | OAuth sign-in and consent for a connecting client |
| `/account` | Storage used, connector URL, files (delete, copy a 1-hour link), share links (revoke), connected apps, API keys |
| `/admin/*` | Overview, settings and audit log. No accounts, roles or quota pages |
| `/mcp` | MCP endpoint (streamable HTTP, stateless, 6 MB body limit) |
| `/.well-known/oauth-*` | OAuth discovery for the connector |
| `/api/auth/*` | Better Auth, including OAuth registration, authorize and token |
| `/api/agents/*` | Connected apps list, revoke, consent decision (signed-in session) |
| `/api/v1/*` | REST API for API keys; the same routes accept the owner's browser session for the account page |
| `/api/v1/health` | D1 and object store reachability (503 when either is down) |
| `/s/<token>` | Public share page. The 128-bit token is the capability; an optional password is the second factor |
| `/s/<token>/v/<id>`, `/s/<token>/d/<id>` | View or download one file of a share: a redirect to a 5-minute presigned URL |

## MCP tools

Read scope (`artifacts:read`): `list_files`, `get_file`, `read_file`, `get_download_link`, `get_usage`,
`list_shares`, `get_share`.
Write scope (`artifacts:write`): `create_upload`, `complete_upload`, `put_file`, `import_from_url` (open world),
`set_file_expiry`, `delete_file` (destructive), `create_share`, `update_share`, `revoke_share` (destructive).

No tool takes a tenant or user id: the account comes from the token. Every input schema is strict. Failures return
`{ code, message }` with one of `NOT_FOUND`, `INVALID_INPUT`, `UPLOAD_NOT_FOUND`, `TOO_LARGE`, `UPLOADS_DISABLED`,
`PROVIDER_ERROR`, `INSUFFICIENT_SCOPE`, `VALIDATION_ERROR`, `INTERNAL_ERROR`. The REST API maps the same codes to
404, 422, 404, 413, 503, 502, 403, 422 and 500. A token without the needed scope gets the MCP scope challenge (HTTP
403) instead.

## REST API

All routes take `Authorization: Bearer ma_live_...`. `artifacts:write` is needed to change anything.

| Route | Same as tool |
|---|---|
| `GET /api/v1/files`, `GET`/`PATCH`/`DELETE /api/v1/files/{id}` | `list_files`, `get_file`, `set_file_expiry` (body `{ "expires_in_days": number or null }`), `delete_file` |
| `POST /api/v1/files/uploads`, `POST /api/v1/files/{id}/complete` | `create_upload`, `complete_upload` |
| `POST /api/v1/files` | `put_file`: JSON, or a raw `application/octet-stream` body with `name`, `mime`, `expires_in_days`, `note` in the query. Up to the inline cap |
| `POST /api/v1/files/import` | `import_from_url` |
| `GET /api/v1/files/{id}/link?ttl&disposition` | `get_download_link` |
| `GET`/`POST /api/v1/shares`, `GET`/`PATCH`/`DELETE /api/v1/shares/{id}` | `list_shares`, `create_share`, `get_share`, `update_share`, `revoke_share` (`DELETE` revokes) |
| `GET /api/v1/usage` | `get_usage` |

`read_file` has no REST route: an HTTP client downloads through a link.

## How an upload works

| Path | Limit | How |
|---|---|---|
| `put_file` / `POST /api/v1/files` | 4 MB | The content is in the request. The only path that works from chat-only clients |
| `create_upload` then PUT then `complete_upload` | 5 GB | The client PUTs the bytes straight to a presigned URL pinned to the declared size and type (valid 15 minutes). `complete_upload` HEADs the object and records its real size |
| `import_from_url` | 100 MB | The Worker fetches a public https URL (no private or reserved addresses, port 443 only, at most 3 redirects, each re-checked) and streams it into storage; a source that does not report its size is held in memory and capped at 32 MB |

An upload that is never completed is closed, with its object, after 24 hours. Files are kept until deleted unless
an expiry is set; the hourly cleanup removes expired files.

## Links

- **Download link** (`get_download_link`): a presigned URL, 1 minute to 7 days, default 1 hour. It cannot be
  revoked early. HTML, SVG and other types a browser could run are always served as attachments.
- **Share** (`create_share`): 1 to 50 files at `/s/<token>`, optional password (PBKDF2-SHA256, 100k iterations,
  per-share salt) and optional expiry, no download limit, revocable at any time. One file opens a viewer with a
  preview; several show a list. Pages load media only from the storage host, run no script, and are `no-store`,
  `noindex` and `no-referrer`. A password attempt is rate limited per visitor and per share, and a correct one
  sets a cookie for that one share for 12 hours. Files are never streamed from this origin.

## Data

`artifacts`, `shares`, `share_items` (every row has `tenant_id` and an index that starts with it), the
operational `sweep_runs` history (no tenant: the cleanup spans the service), plus the platform API key, admin and
OAuth module tables. Edit `migrations.src/`; run `npm run compose:migrations -w @templatedesign/myartifacts` after
editing it and never edit `migrations/` by hand.

## Configuration

| Name | Kind | Purpose |
|---|---|---|
| `BETTER_AUTH_SECRET` | secret | Session and token signing; also signs the share-password cookie |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | secret | Contabo Object Storage credentials for the bucket |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | secret, optional pair | Google sign-in |
| `APP_ORIGIN`, `BETTER_AUTH_URL` | var | `https://myartifacts.zhst.app`; share URLs are built from `APP_ORIGIN` |
| `OWNER_EMAILS` | var | The only addresses that can sign in or connect. Empty admits nobody |
| `ADMIN_EMAILS` | var | First admin accounts and digest recipients |
| `EMAIL_FROM`, `EMAIL_PROVIDER` | var | Transactional email |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET` | var | `https://usc1.contabostorage.com`, the signing region, `myartifact` |

Bindings: `DB` (D1), `SESSION` (KV), `EMAIL` (send_email). There is no R2 binding.
Admin settings (no deploy needed): `uploads.enabled`, `uploads.max_inline_bytes` (at most 4 MB),
`uploads.max_import_bytes` (at most 500 MB).

Crons: hourly cleanup of expired files and abandoned uploads (500 of each per run), and a daily digest at 03:20 UTC.

## Isolation

Every business table is queried with a `tenant_id` predicate: `tests/tenant-scoping.test.ts` scans the source and
fails on any statement without it, and `tests/isolation.test.ts` replays every tool and REST route as a second
account against the first account's ids while a recorder fails on any business-table query without `tenant_id`.
The exceptions are the public share lookup (the token is the capability; everything after it is scoped to the
share's tenant) and the operator cleanup and reporting in `src/lib/ops.ts`, which span every account and return
counts only.

Uploaded content never runs on this origin: previews and downloads come from the storage host through presigned
URLs, share pages carry a CSP that allows no script, and a type a browser could run is always an attachment.

## License

[MIT](LICENSE)
