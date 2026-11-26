# MyArtifacts deploy and operations

MyArtifacts is one Cloudflare Worker (`myartifacts-web`) at `https://myartifacts.zhst.app`, with D1
`myartifacts-web`, KV `SESSION`, the `EMAIL` send binding and two cron triggers. Files do not live in R2: they
are in one private bucket on Contabo Object Storage (S3 compatible). D1 holds only metadata. The app is
owner-only. Product notes are in [`apps/myartifacts/README.md`](../../apps/myartifacts/README.md); users start
with the [connect guide](connect-guide.md).

## 1. Contabo bucket (once)

1. In the Contabo customer panel create (or reuse) an Object Storage and a bucket named `myartifact` in the US
   central region. Keep it **private**: the app never needs public read, and every file is served through
   presigned URLs.
2. Create the S3 access key and secret for it. You need a key that can read, write, delete and HEAD objects in
   that bucket.
3. No CORS rule and no lifecycle rule are needed. Uploads from a browser are not offered, and the app deletes
   expired files itself.
4. Confirm the endpoint and the signing region before anything else depends on them. This writes, reads and
   deletes a few tiny objects under `ma/smoke-check/` and prints which region string the provider accepts:

```bash
S3_ENDPOINT=https://usc1.contabostorage.com S3_BUCKET=myartifact \
S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=... npx tsx scripts/contabo-s3-smoke.mjs
```

It also checks that a presigned PUT refuses a body of another size or type, that an anonymous GET is refused, and
that the content-type and content-disposition overrides work. If it reports a region other than the
`S3_REGION` in `apps/myartifacts/wrangler.jsonc` (`usc1`), change the variable and commit. A step that fails is
named in the output; do not deploy until it passes.

## 2. Provision (once)

```bash
npm run provision:myartifacts                                   # dry run: what exists, what would be created
node scripts/provision-app.mjs myartifacts --apply              # creates D1 and KV, writes the ids into wrangler.jsonc
```

There is no R2 bucket to create. Review the diff to `apps/myartifacts/wrangler.jsonc` and commit it: the deploy
refuses uncommitted changes in `apps/` and `packages/`. The custom domain `myartifacts.zhst.app` is attached on
the first deploy; the zone must be on the same Cloudflare account. Enable Cloudflare Email for the
`myartifacts.zhst.app` sender domain, because sign-in links go through the `EMAIL` binding.

## 3. Secrets and variables

Set from `apps/myartifacts`. Values are typed at the prompt and never committed or echoed.

```bash
npx wrangler secret put BETTER_AUTH_SECRET        # at least 32 random characters: openssl rand -hex 32
npx wrangler secret put S3_ACCESS_KEY_ID          # the Contabo S3 access key
npx wrangler secret put S3_SECRET_ACCESS_KEY      # the matching secret
npx wrangler secret put GOOGLE_CLIENT_ID          # optional, set with the next one or not at all
npx wrangler secret put GOOGLE_CLIENT_SECRET      # redirect URI https://myartifacts.zhst.app/api/auth/callback/google
```

Plain variables in `wrangler.jsonc`: `APP_ORIGIN`, `BETTER_AUTH_URL`, `EMAIL_FROM`, `EMAIL_PROVIDER`,
`ADMIN_EMAILS`, `OWNER_EMAILS`, `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`. Do not set `PAYMENTS_PROVIDER`: there is
no checkout.

- `OWNER_EMAILS` (comma separated) is the only list of people who can sign in, approve a connector or use an API
  key. Anyone else is refused, an empty list admits nobody, and narrowing it cuts off the keys and connectors that
  were issued to a removed address on their next request. The preflight refuses a deploy while it is empty.
- `ADMIN_EMAILS` lists who becomes admin the first time they open `/admin`, and who receives the daily digest.
  It is normally the same address.

`BETTER_AUTH_SECRET` also signs the share-password cookie. Rotating it signs everyone out of the app and makes
every visitor enter a share password again; share links and passwords themselves keep working.

### Rotate the S3 key

Create the new key in Contabo, then `npx wrangler secret put S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`, run
`scripts/smoke-myartifacts.sh` and the Contabo smoke script with the new values, then revoke the old key. Every
presigned link and upload URL signed with the old key stops working when it is revoked, including a download link
that had days left. Share links are not affected: they mint a fresh presigned URL on each visit.

## 4. Check, deploy, smoke

```bash
npm run preflight:myartifacts     # lists exactly what is missing (resource ids, secrets, owner and storage variables)
./deploy-cf.sh myartifacts        # gates, D1 backup + migrations, deploy, then scripts/smoke-myartifacts.sh
```

The script exports D1 before applying migrations (the first deploy has an empty database, so there is nothing to
back up) and prints the version id to roll back to. The smoke test is read-only and writes nothing to storage. It
checks that `/api/v1/health` reports D1 and the object store reachable (a signed request for a key that never
exists must come back "not found"), the landing page and its `noindex`, the security headers, both OAuth metadata
documents, the `/mcp` 401 with a `resource_metadata` challenge, a plain 401 for a bad API key, the REST 401s, an
unknown share token being 404 with `no-store`, `noindex` and its own strict CSP, and the sign-in redirects.

The health route answers 503 when either D1 or the object store is down, and caches the storage answer for 30
seconds so a public route does not call Contabo on every hit.

## 5. First run by hand

Sign in as the owner, then:

1. Add the connector in Claude and run checks 1 to 4 from [the connect guide](connect-guide.md#check-it-works):
   `put_file`, `list_files`, `read_file`, `get_download_link`; `create_upload` with `curl -T` and `complete_upload`
   for a large file; `create_share` with a password and open the link in a private window; `revoke_share`.
2. Open `/account` and `/admin/` and confirm the numbers match.

## 6. Day-to-day controls (`/admin/settings/`)

| Setting | Effect |
|---|---|
| Uploads are on | Off refuses every new upload (presigned, inline and import) with "Uploads are switched off". Reading, links and shares keep working. This is the kill switch. |
| Inline upload limit | Content sent inside one request (`put_file`, `POST /api/v1/files`). Default 4 MB, which is also the most it can be set to: one MCP request carries about 4 MB decoded. |
| Import limit | Files fetched from a public URL. Default 100 MB, at most 500 MB. A source that does not report its size is held in memory and capped at 32 MB whatever this says. |

Every change needs a reason and goes to the append-only audit log (`/admin/audit/`). `/admin/` shows total bytes,
files, active share links, uploads in progress and the last cleanup. There are no accounts, roles or quota pages:
the app has one user and no billing.

## 7. Crons and recovery

| Cron | Does |
|---|---|
| `0 * * * *` | Deletes `ready` files whose expiry has passed (object first, then the row, and the file leaves every share) and uploads that were created but not completed within 24 hours (the object too, if one was PUT). At most 500 of each per run; a larger backlog drains over the next runs. Records a row in `sweep_runs`. |
| `20 3 * * *` | Prunes sweep history older than 30 days, retries failed emails, and emails `ADMIN_EMAILS` a digest: files and megabytes stored, files added, active shares, uploads in progress, what the sweeps removed and how many storage calls failed. |

An expired file stops working at once, in links and shares, even before the hourly run removes its object. A
storage failure leaves that file in place and counted as an error; the next run tries it again, so nothing needs
to be run by hand. An upload older than 24 hours can no longer be completed, which is what keeps completion and
cleanup from racing.

To look at a run: `npx wrangler tail myartifacts-web --format json` and filter on `"evt":"hourly_cron"`,
`"evt":"sweep_storage_error"` or `"evt":"cron_failed"`.

## 8. Operations runbook

**Revoke a share link.** The owner does it on `/account` (or asks the assistant). It answers 410 from the next
request; a visitor who already has a 5-minute presigned URL keeps it until it ends. A raw download link from
`get_download_link` cannot be revoked early: it lasts up to 7 days (default 1 hour). To end one at once, rotate
the S3 key.

**Disconnect everyone (OAuth grants).** Export D1 first (`npx wrangler d1 export myartifacts-web --remote --output
backup.sql`), then run in one `wrangler d1 execute myartifacts-web --remote --command` call:

```sql
UPDATE agent_grants SET active = 0, generation = lower(hex(randomblob(16))), revoked_at = CAST(strftime('%s','now') AS INTEGER) * 1000;
DELETE FROM oauthAccessToken; DELETE FROM oauthRefreshToken; DELETE FROM oauthConsent;
```

The next call from every connector returns 401 and the client asks the owner to sign in again. One app can be
disconnected on `/account`.

**Revoke one API key.** On `/account`. An admin sees prefixes only, never key values.

**Change who can sign in.** Edit `OWNER_EMAILS` (and `ADMIN_EMAILS`) in `wrangler.jsonc`, commit, deploy. Keys and
connectors of a removed address stop working on their next request.

**Storage grows.** Files are kept until deleted, so `/admin/` shows the total. Set an expiry on files that need not
live forever (`set_file_expiry`), or delete them. Contabo's plan size is the real ceiling.

**Check for orphan objects.** The app deletes the object before it marks a row deleted, and the hourly run closes
abandoned uploads, so orphans are not expected. To check, list `ma/` in the bucket with any S3 tool and compare
with `SELECT object_key FROM artifacts WHERE status IN ('pending','ready')`. Objects under `ma/smoke-check/` remain
only if the smoke script was interrupted.

**Roll back.** `cd apps/myartifacts && npx wrangler rollback <version-id> --config dist/server/wrangler.json` (the
deploy script prints the version id). Migrations are additive; restore D1 from the exported backup only if a
migration itself is the problem. To take the app offline without deleting data, remove the Worker route. D1 and
the `ma/` prefix in the bucket remain and can be removed separately after a `wrangler d1 export` backup.

**Back up D1.** `npx wrangler d1 export myartifacts-web --remote --output <file>.sql`. File contents are in
Contabo and are not part of the export.

## 9. Real-client verification (do after the first deploy)

The tests cover the OAuth flow, every tool and route against the app's own code, with a fake object store. They
cannot prove Contabo's behaviour or a real client's. Record each result and the date in
[`connect-guide.md`](connect-guide.md).

| Check | What to look for |
|---|---|
| `scripts/contabo-s3-smoke.mjs` | Signing region accepted, presigned PUT pinned to size and type, overrides applied. |
| Streamed import | `import_from_url` of a file of a few MB from a public host: the size recorded equals the source's size. Deployed Workers send the stream with its declared length through a fixed-length stream. |
| claude.ai web | Add the connector, sign in, `put_file`, `read_file`, `get_download_link`, `create_share` with a password. |
| Claude Code | `create_upload` then `curl -T` then `complete_upload` for a file of several hundred MB: the recorded size is the object's real size. |
| Claude Desktop, ChatGPT | The connector appears or can be added; `put_file` and `get_download_link` work. |
| n8n | HTTP node with an API key: `POST /api/v1/files`, then `GET /api/v1/files/{id}/link`. |
| Browser | A share link with a password in a private window: the password page shows nothing about the file; after the password, a preview and a download that comes from the Contabo host. |
