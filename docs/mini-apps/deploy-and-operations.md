# Mini apps deploy and operations guide

> In this repository only `ota` is included; `restaurant`, `erp` and `apps/web` are mentioned for context.

Status: **`ota`, `restaurant` and `erp` are deployed to the production Cloudflare account** (D1, KV,
R2 and custom domains exist; migrations are applied; email sender subdomains are enabled).
Worker secrets are set by the operator, not committed. The new OTA is served from
`ota-multiplatform.zhst.app` because `ota.zhst.app` belongs to the earlier OTA Worker.
`apps/web` has its own guide in `../deploy-and-operations.md`;
TranscriptAnything uses [`../transcript/deploy-and-operations.md`](../transcript/deploy-and-operations.md).

The three mini apps share `@templatedesign/platform` (accounts, wallet, checkout, admin, email) and
`@templatedesign/app-shell` (workspaces, branding, plans). Each app is still its own Worker, D1
database, KV namespace, R2 bucket, domain and billing surface. A workspace belongs to exactly one
app and is served under `https://<app-host>/<workspace-slug>/`.

```
Browser
   │ HTTPS
   ├─ ota-multiplatform.zhst.app Worker ota-web          D1 ota-web + KV SESSION + R2 ota-media
   ├─ emenu.zhst.app        Worker restaurant-web   D1 restaurant-web + KV + R2
   └─ erp.zhst.app          Worker erp-web          D1 erp-web + KV + R2 + Durable Objects
```

## 1. What each app owns

| App | Worker | Public host | D1 | KV | R2 | Extra Cloudflare resources | Cron |
|---|---|---|---|---|---|---|---|
| `ota` | `ota-web` | `ota-multiplatform.zhst.app` | `ota-web` | `SESSION` | `ota-media` | none | `17 3 * * *` |
| `restaurant` | `restaurant-web` | `emenu.zhst.app` | `restaurant-web` | `SESSION` | `restaurant-media` | none | `0 * * * *` |
| `erp` | `erp-web` | `erp.zhst.app` | `erp-web` | `SESSION` | `erp-media` | Durable Object `ErpAccounting` (created by the `migrations` entry) | `17 3 * * *` |

All three bind `DB` (D1), `SESSION` (KV), `MEDIA` (R2) and the Cloudflare email binding `EMAIL`.
`wrangler.jsonc` is the source of truth; `./deploy-cf.sh` reads the D1 name, host and package name
from it (environment variables `D1_NAME` and `APP_URL` still override).

## 2. Before the first deploy

### 2.1 Toolchain

Node 24.21 or newer, npm, Wrangler 4.151.1 (workspace dependency), and access to the `zhst.app`
zone. Check the account before creating anything:

```sh
cd apps/ota
npx wrangler login
npx wrangler whoami
```

### 2.2 Create only the resources this app needs

Run these from the app directory. Every command returns an id that belongs in `wrangler.jsonc`;
do not commit a placeholder.

**Ota**

```sh
cd apps/ota
npx wrangler d1 create ota-web
npx wrangler kv namespace create SESSION
npx wrangler r2 bucket create ota-media
```

**Restaurant**

```sh
cd apps/restaurant
npx wrangler d1 create restaurant-web
npx wrangler kv namespace create SESSION
npx wrangler r2 bucket create restaurant-media
```

**Mini ERP**

```sh
cd apps/erp
npx wrangler d1 create erp-web
npx wrangler kv namespace create SESSION
npx wrangler r2 bucket create erp-media
```

The Durable Object namespace needs no separate command: the `migrations` entry in
`apps/erp/wrangler.jsonc` declares `ErpAccounting` and Wrangler creates it on the first deploy.

Paste the returned ids into `apps/<app>/wrangler.jsonc`:

- `d1_databases[0].database_id` from `wrangler d1 create`
- `kv_namespaces[0].id` from `wrangler kv namespace create`
- `routes[0].pattern` is already the production host; keep it.

The shared preflight catches any id that was missed:

```sh
npm run preflight:ota
npm run preflight:restaurant
npm run preflight:erp
npm run preflight:all          # every app with a wrangler.jsonc, including web
```

Use `node scripts/preflight-app.mjs <app> --plan` to print the exact provisioning commands. The
script never calls Cloudflare; it checks the local config, bindings, crons, Durable Object
declaration, composed migrations and the ERP accounting artifact.

### 2.3 Set secrets

Secrets are per Worker. Set them from the app directory, never in Git:

```sh
cd apps/<app>
npx wrangler secret put BETTER_AUTH_SECRET     # openssl rand -hex 32
npx wrangler secret put BETTER_AUTH_URL        # https://<app-host>
npx wrangler secret put APP_ORIGIN             # https://<app-host>
npx wrangler secret put EMAIL_PROVIDER         # resend, postmark or cloudflare
npx wrangler secret put EMAIL_FROM             # verified sender on the app host
npx wrangler secret put RESEND_API_KEY         # or POSTMARK_TOKEN, when not using the EMAIL binding
```

Add the provider that actually takes payments. Checkout stays unavailable (503) when the selected
provider has no key **and** webhook secret.

```sh
npx wrangler secret put PAYMENTS_PROVIDER      # paddle or stripe
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put STRIPE_WEBHOOK_SECRET
# or
npx wrangler secret put PADDLE_API_KEY
npx wrangler secret put PADDLE_WEBHOOK_SECRET
```

App-specific secrets:

| App | Secret | Purpose |
|---|---|---|
| `ota` | `OTA_SECRET_KEY` | 32-byte key (64 hex characters or base64) that encrypts bring-your-own S3 credentials |
| `restaurant` | none | cash, bank-transfer and card bills are confirmed by hand; set `ADMIN_EMAILS` so cron alerts reach someone ([9.3](#93-alerts-and-the-health-check)) |
| `erp` | none | the accounting books are per Durable Object, not a shared secret |

`EMAIL` is bound in `wrangler.jsonc`, so `EMAIL_PROVIDER=cloudflare` can send through the binding
after the sending domain is onboarded. `ADMIN_EMAILS` is optional; it bootstraps the first admin
role when the `/admin` page is opened.

### 2.4 Check the database migrations

```sh
npm run check:migrations       # from the repo root; composes platform + app SQL
```

Composed output lives in `apps/<app>/migrations/`; edit only `apps/<app>/migrations.src/` or the
shared `packages/platform/migrations/` and `packages/platform/migrations/modules/`. `apps/web` is
frozen and hash-pinned.

Mini ERP has a second schema inside the Durable Object. Its SQL lives in
`apps/erp/accounting-migrations/` and is embedded into
`apps/erp/src/lib/erp/accounting/migration.generated.js`:

```sh
npm run accounting:artifact -w @templatedesign/erp
node apps/erp/scripts/accounting-artifact.mjs --check   # what the preflight runs
```

Do not edit the generated file by hand.

## 3. Deploy

```sh
./deploy-cf.sh ota
./deploy-cf.sh restaurant
./deploy-cf.sh erp
```

The script runs, in order:

1. `preflight:<app>` when it exists, otherwise the shared `scripts/preflight-app.mjs`
2. `check:migrations`, `check:platform`, then the app's `check`, `test` and `build`
3. `wrangler whoami`
4. D1 backup + `wrangler d1 migrations apply` when migrations are pending
5. `wrangler deploy --config dist/server/wrangler.json`
6. `/api/v1/health` and `/` smoke tests

Useful flags: `--skip-tests`, `--yes`, and `--list`. For a first run, do not skip the confirmation.

To deploy by hand:

```sh
npm run build -w @templatedesign/ota
cd apps/ota
npx wrangler deploy --config dist/server/wrangler.json
```

Always deploy `dist/server/wrangler.json`, not the source config: the build emits the bundled
`entry.mjs` with the cron handler.

## 4. Smoke test each app

Common checks (replace the host):

```sh
curl -fsS https://ota-multiplatform.zhst.app/api/v1/health
curl -fsS https://emenu.zhst.app/api/v1/health
curl -fsS https://erp.zhst.app/api/v1/health
```

Then sign in with a magic link and exercise the app:

| App | Check |
|---|---|
| `ota` | Create a workspace, open `/<slug>/admin`, register an app and upload a bundle; fetch `/<slug>/ota/<app>/<platform>/manifest.json` without a session |
| `restaurant` | The full service pass in [9.6](#96-launch-smoke-test): onboard, scan, order, cook, serve, settle in all three methods, refund, close the shift, export |
| `erp` | Create a workspace, add a customer and a quotation; on Pro, open accounting, create the book and post a balanced journal |

Also confirm:

- the custom domain resolves and `/` returns 200 over HTTPS;
- the cron fired (Workers logs or the Cron Events tab show the scheduled invocation);
- a test workspace cannot read another workspace's rows (the app's isolation test covers the
  routes; the manual check is a second signal);
- email arrives from the verified app domain.

## 5. Release and rollback

Every deploy:

```sh
./deploy-cf.sh <app>            # backs up D1 before applying pending migrations
```

Before a migration that can affect reads, export D1 yourself:

```sh
cd apps/<app>
npx wrangler d1 export DB --remote --output ../../templatedesign-backups/d1-<app>-$(date -u +%Y%m%dT%H%M%SZ).sql
```

**Worker rollback:** `npx wrangler rollback <version-id> --config dist/server/wrangler.json` from the
app directory. The deploy script prints the current version before every release.

**Durable Object (ERP):** never delete the `ErpAccounting` namespace to "reset" a ledger. The
object's SQLite storage is the books. Restore from a D1/R2 backup only for the app tables; the
accounting books need their own export/restore procedure.

**Migration rule:** migrations are forward-only. If a release is incompatible with the previous
schema, roll forward with a corrective migration; do not reverse one by hand.

## 6. Shared code means several deploys

`packages/platform` and `packages/app-shell` are vendored into every app at build time. A change
there does not reach production until each affected app is rebuilt and deployed:

```sh
npm run verify:affected
./deploy-cf.sh web
./deploy-cf.sh transcript
./deploy-cf.sh ota
./deploy-cf.sh restaurant
./deploy-cf.sh erp
```

CI runs `check`, `test` and `build` for the affected apps; it does not deploy. A platform fix that
changes auth, the wallet or checkout must be released to every app that serves traffic.

## 7. Known gaps before launch

| Gap | Impact | Mitigation |
|---|---|---|
| No R2 lifecycle rules documented for the three media buckets | Old logos, dish images and bundles can accumulate | Set a lifecycle rule or confirm the app's cron deletes expired objects |
| Email sender subdomains are per app (`ota-multiplatform-sender`, `emenu-sender`, `erp-sender`) | Mail sent from the app host is rejected | Keep `EMAIL_FROM` on the matching `*-sender.zhst.app` address |
| ERP accounting books are per-workspace Durable Objects | A lost object namespace loses books | Treat the namespace as financial data; plan an export before any reset |
| No independent status page | An outage is visible only from Cloudflare and the apps | Add one before paid traffic |

## 8. First-deploy checklist

- [ ] `npx wrangler whoami` points at the intended account and the `zhst.app` zone.
- [ ] D1, KV and R2 created; ids pasted into `wrangler.jsonc`.
- [ ] `npm run preflight:<app>` passes with no placeholder errors.
- [ ] `npm run check:migrations` passes and the app's `check`, `test` and `build` are green.
- [ ] `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `APP_ORIGIN`, email and payment secrets set.
- [ ] App-specific secrets set (`OTA_SECRET_KEY` for Ota).
- [ ] D1 migrations applied remotely; the ERP accounting artifact is current.
- [ ] `/api/v1/health` and `/` return 200 on the custom domain.
- [ ] Sign-in, onboarding, one workspace-scoped write and the app-specific flow pass.
- [ ] Rollback version recorded; D1 backup stored outside the repository.

## 9. Restaurant operations

Product overview, roles and routes: `apps/restaurant/README.md`.

### 9.1 The hourly cron

`0 * * * *` runs `src/worker.ts` → `runScheduledSweep` (`apps/restaurant/src/lib/sweep.ts`):

1. persists the downgrade of workspaces whose paid plan has expired (they already read as free);
2. sweeps every restaurant workspace with one shared budget of 200 visits per run:
   - closes **open** visits past their expiry that have no money attached (no open bill, no
     confirmed unbilled order), rejects their unconfirmed requests, marks the table for cleaning
     and drops the guest sessions;
   - deletes guest sessions of closed visits and command-ledger rows older than 30 days;
   - **leaves `billing` and `paid` visits alone**: money is attached, so a person must settle or
     void the bill. The run counts them as `expiredBilling` / `expiredPaid`;
3. writes one `restaurant_sweep` log line with every count, a `restaurant_counter` line for each
   skipped kind (`sweep_skipped_billing`, `sweep_skipped_paid`), and a last-run mark in the `SESSION`
   KV namespace (`restaurant:sweep:last-run`).

A run that ran out of budget sets `exhausted: true`; the next run continues where it stopped. One
workspace failing is logged (`restaurant_sweep_workspace_failed`) and does not stop the others.
A failed run is re-thrown so the Cron Events tab shows it as failed.

A rising `expiredBilling` across runs means bills are being frozen and never settled: open the
branch's Thu ngân screen and settle or void them.

### 9.2 The business day

A business day runs **04:00 to 03:59 Vietnam time** (`BUSINESS_DAY_START_HOUR` in
`src/domain/data.ts`), so a restaurant that closes at 23:30 or 01:00 keeps its whole night in one
day. The chain dashboard, the reports range and every CSV use it; each CSV says so in its
`business_date (04:00-03:59 …)` header. Sales between 00:00 and 03:59 belong to the previous date.
CSVs downloaded before this boundary was introduced grouped by midnight and will not match a new
export for the same dates.

### 9.3 Logs, counters, alerts and the health check

Every log line is one JSON object with `app: "restaurant"` and an `evt`. Query them in Workers
Observability (`emenu.zhst.app` → Logs):

| `evt` | When | Fields |
|---|---|---|
| `restaurant_request` | every command, and any read that failed or took over 1 s | `requestId` (the `cf-ray`), `workspaceId`, `branchId`, `action`, `outcome` (`ok`, `refused`, `error`, `not_modified`), `status`, `code`, `durationMs` |
| `restaurant_counter` | `SHIFT_REQUIRED`, `IDEMPOTENCY_CONFLICT`, `PLAN_LIMIT`, `RATE_LIMITED` refusals; sweep skips | `counter`, `value`, plus the request fields |
| `restaurant_request_failed`, `restaurant_operation_failed`, `restaurant_api_failed` | an unexpected error (500 / 503) | `requestId`, `workspaceId`, `action`, `errorType`, a trimmed `message` |
| `restaurant_sweep`, `restaurant_sweep_failed`, `restaurant_sweep_gap`, `restaurant_plan_expiry_failed` | the cron | counts, `missedHours`, `errorType` |
| `billing_alert` | an operator alert was raised (see below) | `kind`, `summary` |

Logs never carry guest session or table tokens, bill or transfer references, or emails:
`src/lib/log.ts` drops fields named for them and masks token- or email-shaped text, and
`tests/observability.test.ts` runs a full order-to-settlement flow and fails if any of them appears.
Successful polls are not logged. Client-side poll failures are visible only in the browser
(the "Mất kết nối" indicator); the server sees them only when the request reaches it and fails.

**Alerts.** The cron calls the platform's operator alert (`alertOperators`) when a pass or a
workspace fails (`restaurant_sweep_failed`) and when the previous mark is more than 2 h 15 min old
(`restaurant_sweep_gap`, meaning runs were skipped). It logs at error level and emails `ADMIN_EMAILS`
at most once per kind per hour. Known gap: the platform has only one operator email template, so the
email is titled "Billing alert" and ends with a reconciliation hint that does not apply; the `kind`
in the subject is what matters.

**A cron that stopped running cannot alert about itself.** `GET /api/v1/health` returns
`{"status":"ok","sweep":"…"}`: `ok`, `failing` (the last run failed), `stale` (no run for over
2 h 15 min) or `unknown` (no mark yet: before the first run, or after the KV namespace changed).
Point an uptime monitor at it with a keyword check for `"sweep":"ok"` (allow `unknown` for the first
hour after a fresh namespace). The status code stays 200 whatever the cron does, because
`deploy-cf.sh` rolls a deploy back on anything else and a deploy may be the fix.

`rc_audit` records every command but is readable only through the "Lịch sử & điều chỉnh" CSV.
That is the known gap for launch; there is no audit screen.

### 9.4 Migrations: back up and rehearse first

The restaurant migration rebuilds `rc_visits` and `rc_bills` (table copy and swap). A failure part
way through is not reversible by redeploying. Before applying it, or any later migration, to the
production database:

```sh
cd apps/restaurant
npx wrangler d1 migrations list DB --remote              # what is pending
npx wrangler d1 export DB --remote --output ../../../templatedesign-backups/d1-restaurant-$(date -u +%Y%m%dT%H%M%SZ).sql
```

Then rehearse on a restored copy, never on production:

1. create a scratch D1 (`npx wrangler d1 create restaurant-rehearsal`), import the export into it
   (`npx wrangler d1 execute restaurant-rehearsal --remote --file <export.sql>`);
2. record row counts for every `rc_*` table and a checksum per column of `rc_visits` and `rc_bills`
   (for example `SELECT COUNT(*), SUM(LENGTH(id)), SUM(total), SUM(version) FROM rc_bills`);
3. apply the pending migrations to the scratch database
   (`npx wrangler d1 migrations apply restaurant-rehearsal --remote` with a config whose
   `database_name` points at it);
4. compare the counts and checksums, then run `PRAGMA foreign_key_check;` and expect no rows;
5. delete the scratch database. Only then let `./deploy-cf.sh restaurant` apply the migration.

### 9.5 When service gets stuck

Find the branch first: filter Observability logs on `workspaceId` (and `branchId`) for
`outcome: "refused"` or `"error"` in the last minutes; `code` names the reason and the screens show
the same wording.

| Symptom | Likely `code` | What to do |
|---|---|---|
| **A shift will not close** | `CONFLICT` | Someone else closed it or the screen is stale: refresh Thu ngân. If it shows closed, it is done |
| | `FORBIDDEN` | Only a manager or cashier of that branch (or the owner) may close a shift; check the person's role in Cài đặt › Vai trò |
| | dialog says the expected cash is missing | The expected amount comes from the server read and is never guessed on the device. Refresh; if it stays missing, look for a failed `workspace` read (`restaurant_request` with `outcome: "error"`) for that branch and fix that first. Do not close the drawer blind |
| | dialog asks for a note | The counted cash differs from expected; a note is required for any variance |
| | open bills remain | Closing is allowed, but settle or void the open bills first so their cash lands in this shift |
| Cash cannot be taken | `SHIFT_REQUIRED` | Open a shift (manager or cashier). Transfer and card do not need one |
| A table will not free | `PENDING_ORDERS`, `UNSERVED_DISHES`, `UNBILLED_ORDERS`, `BILL_OPEN` | Confirm or reject pending requests, mark dishes served, then freeze and settle (or void) the bill, then end the visit |
| A bill will not settle | `METHOD_NOT_ACCEPTED`, `CONFLICT` | Pick a method the branch accepts (Cài đặt › Thanh toán) or refresh. A settled bill cannot be voided: refund it |
| Guests cannot order | `RATE_LIMITED`, `PLAN_LIMIT`, `SESSION_CLOSED` | Rate limits clear within 10 minutes; a plan limit needs Pro; a closed visit needs a staff member to open the table |
| A visit stays open overnight | (none) | It has money attached, so the sweep will not close it (`sweep_skipped_billing`): settle or void the bill |

Retrying a command from the screen is safe: every command carries an id and replays, it is not
applied twice. Never edit `rc_*` rows by hand in production; if data must be corrected, back up
first and write the correction as a reviewed SQL file.

### 9.6 Launch smoke test

On `https://emenu.zhst.app`, with a phone and a second device:

1. sign in by magic link, onboard a restaurant through the three steps;
2. print or open a table QR on a phone, join, order two dishes, call a waiter;
3. on the floor: confirm the order, attend the call; in the kitchen: prepare, ready; serve;
4. open a shift; freeze the bill and settle it in cash; repeat on other tables with bank transfer
   (with a reference) and card;
5. refund part of one bill as the manager; void an open bill;
6. close the shift with a counted amount and a note;
7. export each CSV from Báo cáo and open it;
8. after the next full hour, find the `restaurant_sweep` line and check `/api/v1/health` shows
   `"sweep":"ok"`.

### 9.7 Remaining before launch

These cannot be done from the repository and are not done yet:

- [ ] Real-viewport pass on every screen at 390×844, 768×1024 and 1440×900: no horizontal scroll,
      the tab bar reachable one-handed, nothing behind a sticky element, the kitchen readable at arm's
      length, the guest flow usable on a slow connection.
- [ ] Keyboard pass on every screen and dialog (focus visible, no trap, focus returned on close) and a
      screen-reader pass (VoiceOver or TalkBack) on the guest flow and the floor plan, including the
      new-request and new-ticket announcements.
- [ ] `npm run test:a11y` covers the styleguide, not restaurant pages; an axe run against a local
      restaurant build is still to do.
- [ ] Confirm the Cloudflare resources exist (D1 `restaurant-web`, KV `SESSION`, R2
      `restaurant-media`).
- [ ] `npx wrangler d1 migrations list DB --remote` from `apps/restaurant`: note what is pending.
- [ ] `npx wrangler secret list` from `apps/restaurant`: the five secrets (`BETTER_AUTH_SECRET`,
      `BETTER_AUTH_URL`, `APP_ORIGIN`, `EMAIL_PROVIDER`, `EMAIL_FROM`) and `ADMIN_EMAILS` are
      present. Report names only, never values.
- [ ] DNS and the `emenu.zhst.app` custom domain, WAF rules, and the email sender verified.
- [ ] D1 exported; the migration rehearsed on restored data per [9.4](#94-migrations-back-up-and-rehearse-first); `foreign_key_check` clean.
- [ ] `./deploy-cf.sh restaurant`, then the smoke test in [9.6](#96-launch-smoke-test).
- [ ] The first cron run observed with sane counts, and an uptime monitor on `/api/v1/health`.
- [ ] Open questions Q1–Q5 of the launch plan recorded as decided.

