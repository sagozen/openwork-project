# TranscriptAnything: configuration reference

Step-by-step deployment (Cloudflare → payments → home GPU worker → VPS worker → verification) is in
[`deploy-and-operations.md`](deploy-and-operations.md). This page is the reference those steps use.

## Bindings

| Binding | Kind | Name | Notes |
|---|---|---|---|
| `DB` | D1 | `transcript-web` | Own database. Accounts are **not** shared with templatedesign (MVP non-goal). |
| `SESSION` | KV | — | Astro session storage (the adapter enables it). |
| `MEDIA` | R2 | `transcript-media` | Uploaded source media. Lifecycle: delete after 24 h. |
| `OUTPUTS` | R2 | `transcript-outputs` | Transcript JSON + add-on results. Daily cron deletes after 30 days. |
| `EMAIL` | send_email | — | Magic links and account emails. |

```bash
npx wrangler r2 bucket lifecycle add transcript-media media-24h --expire-days 1 -y
```

Results are purged by the cron, not by a lifecycle rule: deleting bytes while the row stayed
`succeeded` would show users a transcript that cannot be downloaded.

## Vars (in `wrangler.jsonc`)

| Name | Example |
|---|---|
| `APP_ORIGIN` | `https://transcriptanything.zhst.app` |
| `BETTER_AUTH_URL` | same as `APP_ORIGIN` (a mismatch breaks cookies and magic links) |
| `EMAIL_PROVIDER` | `cloudflare` \| `resend` \| `postmark` |
| `EMAIL_FROM` | `TranscriptAnything <no-reply@transcriptanything.zhst.app>` |
| `ADMIN_EMAILS` | bootstrap admin address; the first `/admin` visit creates the audited role |
| `PAYMENTS_PROVIDER` | `stripe` \| `paddle` |

## Secrets

| Name | Required | Purpose |
|---|---|---|
| `BETTER_AUTH_SECRET` | yes | 32+ random bytes. |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | yes | Sign upload/download URLs. Scope the token to the two buckets. |
| `MEDIA_BUCKET_NAME`, `OUTPUTS_BUCKET_NAME` | no | Only if you renamed the buckets. |
| `OPENROUTER_API_KEY` | for summaries | Without it the add-on reports unavailable and releases credits. |
| `OPENROUTER_MODELS` | no | Comma list; the admin `llm.models` setting wins. |
| `TURNSTILE_SITE_KEY` + `TURNSTILE_SECRET` | recommended | **Set both or neither.** The site key renders the widget; the secret verifies it. |
| `PAYMENTS_PROVIDER` + `STRIPE_*` / `PADDLE_*` | for paid | Separate provider products and webhook secrets from templatedesign. |
| `ADMIN_EMAILS` | yes | Operator alerts + bootstrap admin. |
| `INTERNAL_SWEEP_SECRET` | staging | Manual cron trigger. |

## Scripts

| Command | What it does |
|---|---|
| `npm run preflight:transcript` | offline deploy check: placeholder ids, composed migrations, Turnstile pairing, secret length, model file |
| `npm run check:transcript` | `astro check` + migration composition check |
| `npm run test:transcript` | pricing, quota, job lifecycle, lease protocol, sources, add-ons (50 tests) |
| `npm run build:transcript` | production build |
| `npm run compose:migrations` | regenerate `migrations/` from `packages/platform/migrations` + `migrations.src/` |
| `npm run check:migrations` | CI: frozen hashes (templatedesign) + generated output current (transcript) |
| `./deploy-cf.sh transcript` | preflight → gates → migrations → wrangler deploy → smoke test |

`preflight` never calls Cloudflare. What it cannot check — remote migrations, the R2 lifecycle rule,
uploaded secrets, worker heartbeats, payment webhooks — is listed at the end of its output and covered
by the runbook's verification matrix.

## Accounts and identity

Separate D1 and separate accounts from templatedesign is deliberate for the MVP. Shared login (one
identity across products) would need one auth database or an identity service and is a later decision.

## Queue and lease protocol

| Value | Setting | Default |
|---|---|---|
| Lease TTL | `PRICING.leaseSeconds` | **180 s** |
| Worker extends every | `EXTEND_SECONDS` | 60 s |
| Requeue scan | minute cron | ≤ 60 s after expiry |
| Worst case before a crashed job is retried | TTL + one cron tick | **≈ 4 min** |
| Free-job ageing (anti-starvation) | `transcript.free_starvation_seconds` | 900 s |
| Paid minutes per month | `transcript.monthly_cap_minutes` | 600 |
| Free minutes accepted per day | `transcript.free_queue_minutes_per_day` | 300 |

- **Lease token.** Every claim writes a random `lease_token`. `extend`, `complete` and `fail` must
  present it, so a completion from an earlier attempt cannot win even if the *same* worker leases the
  job again after a requeue (`lease_superseded`).
- **Cancellation reaches the worker.** `extend` returns 409 with `{ reason: "cancelled" }`; the Go
  worker kills the `whisper-cli`/`ffmpeg` process group, so a cancelled job stops burning GPU within
  one extend interval.
- **Slots are enforced twice.** The worker advertises `concurrency`; the lease endpoint also refuses
  a worker that already holds that many live leases.
- **Long-poll cost.** Each lease request holds up to 20 s and polls D1 internally: one fast poll
  (≈1 s, for the link preview), then ~2.5 s intervals, with the primary heartbeat cached for 5 s —
  roughly 8 passes per request for two workers. If the fleet grows, move the waiting list into a
  Durable Object so D1 is only touched when a job is handed out.
- **Money movement.** Completion writes the job transition, pricing transition, wallet and ledger in
  **one** `db.batch`, keyed on a per-completion `settlement_id`; a retried completion finds no match
  and changes nothing. The credit *reservation* before the job runs is still two compensating writes
  (platform `reserveCredits`, then the minute reservation); if the second fails the first is released
  and platform reconciliation reports any drift.

## Worker fleet operations

- Each heartbeat carries CPU %, RAM, disk free, CPU/GPU temperature and the active job count. One
  minute-granular sample is stored per worker for 14 days (`worker_metrics`); the admin Workers page
  renders the last two hours and the current warning state.
- Threshold warnings are transition-based: two consecutive minutes over a per-worker threshold
  emails the operator once, and three minutes under threshold minus 5 points sends one recovery.
  Thresholds, tier, slots, audio cap, download flags, minimum free disk and auto-update are remote
  config — see the Workers page.
- The worker's own dashboard is loopback-only (`http://127.0.0.1:8787`) and shows live metrics,
  jobs, applied config, updater state and the log tail.
- Releases are published in Admin → Workers → Worker releases and downloaded by the worker only
  when idle; checksum, swap and rollback live in `services/transcriber/internal/update`.

## Operational notes

- **Retention**: media 24 h (lifecycle + cron), transcripts 30 days (cron; the endpoint then 404s).
- **Deletion**: account deletion removes product rows (jobs, uploads, usage) at request time, hard
  deletes after 30 days and keeps anonymised ledger records.
- **Free queue guard**: `transcript.free_queue_minutes_per_day` (default 300),
  `transcript.free_queue_max_wait_seconds` (default 600) and the anti-starvation
  `transcript.free_starvation_seconds` (default 900) in Admin → Quotas.
- **Monthly cap**: `transcript.monthly_cap_minutes` (default 600), overridable per tenant.
- **Source kill switches**: `source.<kind>.enabled`; disabling a source returns a typed
  `source_disabled` error and leaves uploads working.
- **LLM budget**: per model per day in `llm_usage`; Admin → LLM budget shows usage and edits the
  fallback list.
