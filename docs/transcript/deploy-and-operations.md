# Deploy and operate TranscriptAnything

One Worker, two machines, one database. This is the complete bring-up: Cloudflare resources,
secrets, payments, the home GPU worker, the VPS fallback and the checks that prove each step.

Nothing here is guessed: commands were checked against the pinned tool versions in the repo
(`wrangler` 4.151.1, Node 24.21, Go 1.26).

```
Browser / API / n8n
      │ HTTPS
      ▼
transcript-web (CF Worker) ── D1 (jobs, leases, workers) ── R2 (media 24 h, results 30 d)
      ▲ outbound long-poll (20 s) + heartbeat (20 s)
      │
 ┌────┴─────────────────────────────┐
 │ home-gpu  (tier=primary)         │  Windows service, whisper.cpp + Vulkan
 │ vps-cpu   (tier=fallback)        │  Docker, whisper.cpp CPU, 6 GB cap
 └──────────────────────────────────┘
```

No inbound port on either worker. Cloudflare Tunnel on the home box is for remote admin only.

---

## 0. Prerequisites

| Thing | Why |
|---|---|
| Cloudflare account with the `zhst.app` zone | custom domain `transcriptanything.zhst.app` |
| `npx wrangler login` | creates D1/KV/R2 and deploys |
| Node 24.21+ | build the app |
| Go 1.26+ (on the machine you build the worker on) | `services/transcriber` |
| Home desktop: Windows 10/11, RX 6800 + Adrenalin, 20 GB free disk | primary worker |
| VPS: 4 vCPU / 8 GB, Docker + compose, 10 GB free disk | fallback worker |
| Stripe **test** keys first | paid flow without real money |
| Optional: OpenRouter key, Turnstile keys | summaries, guest bot check |

Run everything from the repo root unless a step says otherwise.

```bash
npm ci
npm run check:transcript && npm run test:transcript && npm run build:transcript
```

If those are not green, stop: a deploy would ship a build you have not verified.

---

## 1. Cloudflare resources (once)

```bash
cd apps/transcript

npx wrangler d1 create transcript-web
npx wrangler kv namespace create SESSION
npx wrangler r2 bucket create transcript-media
npx wrangler r2 bucket create transcript-outputs

# Media must disappear after 24 h even if the cron misses a run.
npx wrangler r2 bucket lifecycle add transcript-media media-24h --expire-days 1 -y
npx wrangler r2 bucket lifecycle list transcript-media
```

Paste the two ids into `wrangler.jsonc` (`d1_databases[0].database_id`, `kv_namespaces[0].id`). The
checked-in file carries scaffolding placeholders; a deploy against them fails loudly, which is the
intended behaviour.

Result-object retention (30 days) is enforced by the daily cron, because a lifecycle rule would
delete bytes while the row stayed "succeeded". Keep it that way unless you also teach the UI about
missing results.

---

## 2. Vars and secrets

Non-secret configuration goes in `wrangler.jsonc`:

```jsonc
"vars": {
  "APP_ORIGIN": "https://transcriptanything.zhst.app",
  "BETTER_AUTH_URL": "https://transcriptanything.zhst.app",
  "EMAIL_PROVIDER": "cloudflare",
  "EMAIL_FROM": "TranscriptAnything <no-reply@transcriptanything.zhst.app>",
  "ADMIN_EMAILS": "you@example.com"
}
```

Secrets:

```bash
cd apps/transcript
npx wrangler secret put BETTER_AUTH_SECRET          # openssl rand -hex 32
npx wrangler secret put R2_ACCOUNT_ID               # dashboard → R2 → account id
npx wrangler secret put R2_ACCESS_KEY_ID            # R2 API token, Object Read & Write
npx wrangler secret put R2_SECRET_ACCESS_KEY
npx wrangler secret put OPENROUTER_API_KEY          # only if summaries are on
npx wrangler secret put TURNSTILE_SECRET            # only together with TURNSTILE_SITE_KEY
npx wrangler secret put INTERNAL_SWEEP_SECRET       # staging/manual cron
npx wrangler secret put STRIPE_SECRET_KEY           # or PADDLE_* below
npx wrangler secret put STRIPE_WEBHOOK_SECRET
npx wrangler secret list
```

Bind the R2 token to **both** buckets only. It exists to sign upload/download URLs; the Worker
itself uses the `MEDIA`/`OUTPUTS` bindings.

> **Turnstile: set both keys or neither.** The secret alone makes every guest preview fail with
> `turnstile_required` because the landing page has no widget. With neither, guests are protected
> only by the per-IP/per-cookie rate limits.

Optional overrides: `MEDIA_BUCKET_NAME`, `OUTPUTS_BUCKET_NAME`, `OPENROUTER_MODELS`.

Email: with `EMAIL_PROVIDER=cloudflare` the `send_email` binding is used and the domain must be
onboarded to Cloudflare Email. For Resend/Postmark set `EMAIL_PROVIDER` and `RESEND_API_KEY` or
`POSTMARK_TOKEN` instead.

---

## 3. Database

```bash
cd apps/transcript
node ../../packages/platform/scripts/compose-migrations.mjs . --check
npx wrangler d1 migrations apply transcript-web --remote
npx wrangler d1 migrations list transcript-web --remote   # must say "No migrations to apply"
```

`--check` is the guard from the platform extraction: TranscriptAnything's migrations are generated
from `packages/platform/migrations` + `migrations.src`, and templatedesign's history is frozen by
hash. Never edit `migrations/` by hand.

Before the first production migrate, export the database (it is empty, but establish the habit):

```bash
npx wrangler d1 export DB --remote --output ../../transcript-d1-$(date -u +%Y%m%dT%H%M%SZ).sql
```

---

## 4. Deploy the Worker

```bash
./deploy-cf.sh transcript          # gates → migration check → deploy → smoke test
# or, by hand:
npm run build:transcript
cd apps/transcript && npx wrangler deploy --config dist/server/wrangler.json
```

The route in `wrangler.jsonc` creates the custom domain on first deploy. Confirm:

```bash
curl -s https://transcriptanything.zhst.app/api/v1/health
curl -s https://transcriptanything.zhst.app/api/v1/capabilities | jq '.limits'
```

Then sign in with the `ADMIN_EMAILS` address, open `/admin` once (this bootstraps the audited admin
role), and continue.

---

## 5. Payments

Only one provider is active: `PAYMENTS_PROVIDER=stripe` or `paddle`, with that provider's keys.

**Stripe** (prices are inline from `apps/transcript/src/lib/packs.ts`, so nothing is created in the
dashboard):

1. Developers → Webhooks → add endpoint
   `https://transcriptanything.zhst.app/api/v1/payment-webhooks/stripe`.
2. Events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
   `checkout.session.async_payment_failed`, `checkout.session.expired`, `charge.refunded`,
   `charge.dispute.created`.
3. Copy the signing secret into `STRIPE_WEBHOOK_SECRET`; set `STRIPE_SECRET_KEY`.
4. Buy the smallest pack with a test card, then confirm in Admin → Overview that the ledger is
   balanced and the wallet shows the credits.

**Paddle** (one product, prices inline):

1. Create a product "TranscriptAnything credits" → copy its id to `PADDLE_PRODUCT_ID`.
2. Notification destination → `…/api/v1/payment-webhooks/paddle`, secret to
   `PADDLE_WEBHOOK_SECRET`.
3. Events: `transaction.completed`, `transaction.paid`, `transaction.canceled`,
   `transaction.payment_failed`, `adjustment.created`, `adjustment.updated`.
4. `PADDLE_ENVIRONMENT=sandbox` until the E2E above passes.

Checkout can be paused independently: Admin → Incidents → `pause.checkout`.

---

## 6. Home GPU worker (primary)

Build on any machine, then run the installer **on the Windows box** in an elevated PowerShell.

```bash
# from the repo root
cd services/transcriber
GOOS=windows GOARCH=amd64 go build -trimpath -o deploy/windows/transcriber.exe ./cmd/transcriber
```

Register the worker first, so you have the token the installer needs: Admin → Workers → name
`home-gpu`, tier `primary` → **Register** → copy the `wkr_…` token (shown once).

On the home desktop, copy `services/transcriber/deploy/windows/` (script + `transcriber.exe`) to
`C:\Temp\transcriber-install`, then:

```powershell
powershell -ExecutionPolicy Bypass -File install-worker.ps1 `
  -ApiUrl "https://transcriptanything.zhst.app" `
  -WorkerToken "wkr_..." `
  -WhisperModel "large-v3-turbo-q5_0" `
  -Concurrency 1
```

The script installs whisper.cpp (Vulkan build), ffmpeg/ffprobe, yt-dlp, the model, writes
`%ProgramData%\TranscriptWorker\worker.env`, and registers the **TranscriptWorker** service through
NSSM so it starts at boot without a login. It also installs **TranscriptWorkerSensors**
(LibreHardwareMonitor, for CPU/GPU temperatures) and writes the dashboard, metrics and auto-update
settings. It downloads ~4 GB; expect it to take a while.

Workers installed before this version have no `AUTO_UPDATE`, `DASHBOARD_ADDR` or sensor service.
Rerun the installer once with the same worker token (or add those keys to `worker.env` and register
LibreHardwareMonitor yourself); after that, releases apply automatically.

Verify:

```powershell
Get-Service TranscriptWorker                                  # Running, Automatic
Get-Content "$env:ProgramData\TranscriptWorker\worker.log" -Tail 30
```

The log must show `worker_started` with `tier:"primary"`, then a heartbeat every 20 s. Admin →
Workers must show the worker `online`, a version, `maxAudioSeconds`, `canDownloadYoutube=yes`, and
CPU/RAM/disk values.

Open **http://127.0.0.1:8787/** on the desktop (it is loopback-only) for the local dashboard: live
metrics with an hour of history, the running and finished jobs, the applied remote config and the
log tail. In Admin → Workers, edit **Remote configuration** to set the tier, slots, audio cap, download
flags, minimum free disk, auto-update and warning thresholds; the worker applies them on the next
heartbeat (~20 s), and concurrency is resized without a restart.

Check the sensor source once:

```powershell
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8085/data.json | Select-Object StatusCode
```

It must return `200`; the JSON tree contains `GPU Core` and a CPU package/Tctl sensor. The installer
writes those settings and the URL reservation. If it fails, start **TranscriptWorkerSensors** and
read `sensors.log`. Without it the worker falls back to WMI (older builds) and ACPI and reports GPU
temperature as unavailable — transcription is unaffected.

**Prove the GPU is used before trusting throughput:** run one short job and check the whisper log
line names `AMD Radeon RX 6800`. If it says CPU, the Vulkan runtime or the Adrenalin driver is
missing — the worker still works, but the model is far too slow to be the primary.

Set once on this machine:

- BIOS → "Restore on AC power loss" = Power On.
- Windows → sleep and hibernate off; active hours at night.
- AMD Adrenalin installed and up to date (Vulkan ICd must be present).
- No inbound firewall rule is needed: the worker only makes outbound HTTPS.

### Publish a worker release (auto-update)

```bash
cd services/transcriber
GOOS=windows GOARCH=amd64 go build -trimpath -ldflags="-s -w" \
  -o deploy/windows/transcriber.exe ./cmd/transcriber
```

In **Admin → Workers → Worker releases**, enter a version (`1.9.0`), choose the `.exe` and publish.
The browser computes the SHA-256, uploads the binary directly to the outputs bucket, and the Worker
verifies the object size and records the release metadata. The outputs bucket needs a CORS rule for
this origin before the first upload:

- Allowed origin: `https://transcriptanything.zhst.app`
- Allowed method: `PUT`
- Allowed headers: `*`

Downloads are signed by the Worker for one hour, so workers never need bucket credentials.

The worker picks up the release on the next heartbeat, verifies the checksum, and only applies it
when no job is running. `update-worker.ps1` stops the service, keeps `transcriber.previous.exe`,
writes `version.txt`, restarts and rolls back if the service does not stay up; the log is
`%ProgramData%\TranscriptWorker\update.log`. Auto-update can be turned off per worker in the same
form; it is always off in the VPS container (deploy a new image there instead).

Full config reference and troubleshooting: [`services/transcriber/README.md`](../../services/transcriber/README.md).

---

## 7. VPS worker (fallback)

```bash
# on the VPS, in a checkout of this repo
cd services/transcriber
cp deploy/docker-compose.vps.yml deploy/docker-compose.yml   # optional; keep the path you like

cat > deploy/.env <<'ENV'
TRANSCRIBER_API_URL=https://transcriptanything.zhst.app
TRANSCRIBER_WORKER_TOKEN=wkr_...        # Admin → Workers → Register, tier=fallback
TRANSCRIBER_NAME=vps-cpu
MAX_AUDIO_SECONDS=3600
CONCURRENCY=1
ENV
chmod 600 deploy/.env

docker compose -f deploy/docker-compose.vps.yml build
docker compose -f deploy/docker-compose.vps.yml up -d
docker compose -f deploy/docker-compose.vps.yml logs -f transcriber
```

`deploy/.env` must never be committed (the plan repo already ignores `.env`).

Download the model into the named volume, once:

```bash
docker compose -f deploy/docker-compose.vps.yml run --rm --entrypoint sh transcriber -c \
  'apt-get update && apt-get install -y curl && \
   curl -L -o /models/ggml-large-v3-turbo-q5_0.bin \
   https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin'
```

(Or copy it from the home machine; either way it lands in `models/` and survives rebuilds.)

Verify:

```bash
docker stats --no-stream transcript-transcriber-transcriber-1   # under the 6 GB cap
docker compose -f deploy/docker-compose.vps.yml logs --tail 30 transcriber | grep worker_started
```

Admin → Workers: the VPS worker is `online`, `tier=fallback`. **It must not take work while the
primary is fresh** — that is the routing rule, and the fastest way to see it is to watch
`/admin/jobs` while a job runs on the GPU.

Operational details:

- Update `yt-dlp` when a source breaks: `docker compose … exec transcriber yt-dlp -U` (or rebuild).
- Log rotation is configured in the compose file (10 MB × 3).
- If the queue-age alert repeats for a week, move to a larger VPS before raising `CONCURRENCY`.

---

## 8. Verification matrix

Map each acceptance criterion to one command or click.

| # | Criterion | Check |
|---|---|---|
| 1 | templatedesign unchanged | `npm run check:web && npm run test:web && npm run build:web` |
| 2 | Shared platform fix reaches both apps | edit a string in `packages/platform/src/emails/templates.ts` → both `build:*` pick it up |
| 3 | ≤3 min YouTube / Drive / OneDrive / direct / upload → txt/srt/vtt/json, free | five guest jobs on staging; each result endpoint returns four formats |
| 4 | 20-minute file reserves `ceil(min) × 3`, settles once, releases on failure | create the job, watch the wallet (`reserved`), then Admin → Accounts → ledger has one reserve + one settle |
| 5 | Home stopped → VPS picks up within 90 s; home running → VPS idle | stop the Windows service, queue a job, watch `/admin/jobs` |
| 6 | Kill a worker mid-job → requeued, no double charge | `Stop-Service TranscriptWorker` mid-job; ledger shows one settle after completion |
| 7 | Add-ons charge only on success | unset `OPENROUTER_API_KEY`, run a summary job: transcript delivered, add-on credits released |
| 8 | API key + `transcription.completed` webhook from n8n | import `docs/transcript/n8n/transcribe-link.json`, set the key, run it |
| 9 | Paste-to-preview: title < 1 s, price < 5 s; playlist/folder checklist; private Drive fix | paste each link type on staging |
| 10 | Local dashboard shows all metrics and jobs | open `http://127.0.0.1:8787` on the desktop during a job; CPU/RAM/disk/temps, active and finished jobs, config version and logs are present |
| 11 | CPU/RAM/disk/temperature warning emails | lower the CPU threshold to 50 in Admin → Workers, run a job, wait 2 minutes: one `worker_alert` email; raise it again: one recovery email |
| 12 | Remote config reaches the worker | change slots 1 → 2 in Admin → Workers; within 20 s the dashboard shows `applied vN`, and two leases can run at once |
| 13 | Auto-update applies a published release | publish a newer build, leave the worker idle: within ~2 minutes `update.log` says `update ok`, the version changes, and the old exe is `transcriber.previous.exe` |

Staging tip: run the same steps against a second Worker (`wrangler deploy --name transcript-staging`
with the same D1) before the production soft launch.

---

## 9. Soft launch

1. Keep `pause.checkout` on (default) for the first 3 days: free tier only.
2. Watch the minute cron alerts and Admin → Overview (failure rate, queue age, LLM budget).
3. Enable checkout, announce, then keep the first week's refund policy manual.
4. Only then consider raising `transcript.monthly_cap_minutes`; the GPU is the real limit.

---

## 10. Day-2 operations

| Task | Command |
|---|---|
| Deploy the Worker | `./deploy-cf.sh transcript` |
| Apply migrations | `cd apps/transcript && npx wrangler d1 migrations apply transcript-web --remote` |
| Tail logs | `cd apps/transcript && npx wrangler tail transcript-web` |
| Manual cron (staging) | `curl -X POST -H "Authorization: Bearer $INTERNAL_SWEEP_SECRET" "https://…/api/v1/internal/sweep?scope=daily"` |
| Rotate a worker token | Admin → Workers → New token (the old one stays valid 24 h), update the machine, restart it |
| Disable a source | Admin → Quotas → `source.<kind>.enabled` |
| Raise a tenant's cap | Admin → Accounts → search → override `transcript.monthly_cap_minutes` |
| Check the money | Admin → Reconciliation; the ledger/wallet invariant must read 0 |

### Incidents

**No primary heartbeat (`transcript_no_primary`).** Jobs still complete on the VPS.

1. `Get-Service TranscriptWorker`; read `worker.log`.
2. Rebooted? Confirm it started without a login and the BIOS AC-power setting is on.
3. Driver updated? Run one job and check the whisper line names the RX 6800.

**No worker at all (`transcript_no_workers`).** Queue grows, users see "queued".

1. `docker compose ps` / `logs` on the VPS; check outbound HTTPS to `/api/v1/health`.
2. Disable downloader-only sources so uploads keep working.

**Queue age > 15 min (`transcript_queue_age`).** Usually one long job on the single GPU slot. A
crashed worker costs at most 4 minutes (180 s lease + one cron tick), so 3–5 minutes of "running" is
normal failover, not a stuck job. Confirm nothing was charged: a requeued job keeps its reservation.

**OpenRouter exhausted.** Admin → LLM budget shows per-model requests; add models or wait for the
daily reset. Transcripts are unaffected and add-on credits were released.

**YouTube downloads failing.**

1. `yt-dlp -U` on both workers.
2. If only the VPS is blocked, set `CAN_DOWNLOAD_YOUTUBE=false` there.
3. If both are blocked, disable `source.youtube.enabled` (users are coached to upload).

### Retention

| Data | Where | Lifetime |
|---|---|---|
| Uploaded media | `transcript-media` | 24 h (R2 lifecycle + daily cron) |
| Transcript JSON / add-ons | `transcript-outputs` | 30 days (daily cron; endpoint then 404s) |
| Jobs, workers, usage | D1 | kept; account deletion removes product rows |
| Ledger / payments | D1 | retained, anonymised after deletion |

### Backups

D1 is the only stateful store. `deploy-cf.sh` exports it before applying migrations; keep those
exports at least as long as the payment-retention requirement. R2 is derived from jobs, so a lost
result is a 404, not a lost account.

### Alerts

| Kind | Trigger |
|---|---|
| `transcript_no_primary` | no primary heartbeat for 10 min |
| `transcript_no_workers` | no heartbeat of any tier for 2 min |
| `transcript_queue_age` | oldest queued job older than 15 min |
| `transcript_failure_rate` | >20 % failures in the last hour (min 5 jobs) |
| `worker_cpu` / `worker_memory` / `worker_disk` | two consecutive minutes over the per-worker threshold (defaults 95 %, 92 %, ≤10 % free) |
| `worker_cpu_temp` / `worker_gpu_temp` | two consecutive minutes over 90 °C (editable per worker) |
| `worker_*_recovered` | three consecutive minutes under threshold minus 5 points |
| `job_abuse_blocked` | a subject went over the hourly job-abuse threshold and was blocked (see below) |
| `payment_*` | platform reconciliation alerts |

Alerts are JSON lines in Workers Observability plus at most one email per kind per hour to
`ADMIN_EMAILS` (worker warnings: three per kind per hour). Worker warnings use the `worker_alert`
email template; the admin Workers page keeps the last 14 days of minute metrics and the current
state per metric, and lists every metric currently in warning at the top.

### Customers and sales emails

`/admin/customers/` shows the customer journey (signed up, first successful transcription, pressed
buy, paid), the stuck and abandoned-checkout lists and the last 6 hours of usage. The same inbox
gets one email when a customer presses buy, one when the purchase is confirmed, and a usage email
every 6 hours from the `0 */6 * * *` Cron Trigger (00, 06, 12 and 18 UTC). The inbox is
`SALES_ALERT_EMAIL` (comma-separated, optional) and falls back to `ADMIN_EMAILS`. Each event is
claimed in `crm_notices` before sending, so replays and repeated ticks send nothing twice. Tables
`crm_events` and `crm_notices` arrive with migration `0007_crm.sql`; they hold ids, step names and
pack, amount and provider only. The code is shared with the web app in `packages/platform/src/crm.ts`.

Worker warnings stay alert-only: nothing is changed automatically. The warning email links to
`/admin/workers/?worker=<id>&action=disable`, which opens a confirm panel for a signed-in admin:
**Confirm** disables the worker (running jobs finish, the other tier takes over), **Limit to 1 job at a
time** sets its concurrency to 1, **Dismiss** does nothing. Both go through the audited worker PATCH
(`admin.worker.disabled` / `admin.worker.config_updated`). Recovery emails link to
`/admin/workers/?worker=<id>`. Links use `APP_ORIGIN` (falling back to `BETTER_AUTH_URL`).

### Job abuse blocks

Job creation (`POST /api/v1/transcriptions`, `/api/v1/links/preview`, `/api/v1/uploads`) is checked
against `abuse_blocks` before Turnstile and rate limits. A signed-in tenant is judged on its own; a
guest by guest id and by `cf-connecting-ip`. Over 120 jobs (each probe counts) or 30 rate-limit
rejections in one clock hour blocks the subject for 60 minutes (platform defaults in
`packages/platform/src/abuse.ts`): it gets 429 with `retry-after`, its `queued`, `preview_ready` and
`awaiting_confirmation` jobs are cancelled through the normal cancel path (credit holds, minutes and
free slots are released; `leased` jobs finish), and operators get one `abuse_alert` email (at most ten
per hour). Jobs do not store the creator IP, so an IP block only stops new jobs.

The email links to Admin → Abuse (`/admin/abuse/?block=<id>`), where an admin releases the block,
extends it 24 h from now, or keeps it until released. The page also lists this hour's top job
creators with Block 1 h / 24 h and a manual block form. Every action is audited
(`admin.abuse.blocked`, `admin.abuse.released`, `admin.abuse.extended`). For a paying account that is
abusing the service, suspend it from Admin → Accounts instead; the abuse page links there. The table
comes from `migrations.src/0300_abuse.sql`, a copy of `packages/platform/sql/abuse_blocks.sql`.

## Customer routes

Customers see three pages: `/` (landing and tool), `/docs` and `/legal`. Old URLs (`/app/*`, `/pricing`, `/transcript/:id`, `/docs/*`, `/legal/terms|privacy`) answer 301 from `packages/platform/src/legacy-redirects.ts`; keep them at least 90 days. Checkout returns to `/?payment=<id>`, a cancelled checkout to `/?topup=1&checkout=cancelled`. In the payment dashboard, set the terms, privacy and refund URLs to `/legal#terms`, `/legal#privacy` and `/legal#refunds`.
