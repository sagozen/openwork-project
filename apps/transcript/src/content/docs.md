# TranscriptAnything docs

Transcribe from the API or n8n: send a link or upload a file, receive a webhook, download TXT, SRT, VTT or JSON. Media up to {{freeMinutes}} minutes is free; longer media costs {{creditsPerMinute}} credits per started minute.

- Base URL: `https://transcriptanything.zhst.app`
- Contract: [OpenAPI 3.1](/openapi.yaml) · this page as text: [llms-full.txt](/llms-full.txt) · live values: [capabilities](/api/v1/capabilities), [packs](/api/v1/packs)

## Quickstart

Sign in on the [home page](/), open **API keys** from the account menu, create a key and copy it once. Then:

```bash
export TA_API_KEY="tt_live_...your key..."
curl https://transcriptanything.zhst.app/api/v1/transcriptions -H "Authorization: Bearer $TA_API_KEY" -H "Idempotency-Key: episode-0042" -H "Content-Type: application/json" -d '{"link":"https://www.youtube.com/watch?v=VIDEO_ID"}'
curl https://transcriptanything.zhst.app/api/v1/transcriptions/trj_.../result?format=srt -H "Authorization: Bearer $TA_API_KEY"
```

Creating a job returns `201` with the job, its price and status. Poll `GET /api/v1/transcriptions/{id}` until `status` is `succeeded`, or register a [webhook](#webhooks), then download the result in the format you need.

## Authentication

```text
Authorization: Bearer tt_live_...   # or tt_test_...
Idempotency-Key: episode-0042
Content-Type: application/json
```

- Keys are created and revoked from **API keys** in the account menu. They are hashed at rest and shown once.
- Scopes: `transcriptions:write`, `transcriptions:read` and `usage:read`. A missing scope returns `403 forbidden`.
- Keep keys server-side. Never put a key in browser code or a public repo.
- Always send an `Idempotency-Key` when creating a job: a retry with the same key returns the original job instead of charging twice.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/v1/transcriptions` | Create from a `link`, `upload_id`, `probe_id` or `items[]` |
| GET | `/api/v1/transcriptions` | List transcriptions |
| GET | `/api/v1/transcriptions/{id}` | Status and price |
| GET | `/api/v1/transcriptions/{id}/result?format=` | `json`, `txt`, `srt` or `vtt` |
| POST | `/api/v1/transcriptions/{id}/cancel` | Cancel (idempotent) |
| POST | `/api/v1/transcriptions/batch` | Create many jobs with one Idempotency-Key |
| POST | `/api/v1/links/preview` | Preview: title, duration, price, playlist items |
| POST | `/api/v1/uploads` | Presigned PUT for a media file |
| GET | `/api/v1/key` | Introspect the key: scopes and mode |
| GET | `/api/v1/capabilities` | Public: sources, limits and prices |
| GET | `/api/v1/packs` | Public: the packs used by checkout |
| GET | `/api/v1/health` | Liveness |

### Create a transcription

```bash
curl https://transcriptanything.zhst.app/api/v1/transcriptions \
  -H "Authorization: Bearer $TA_API_KEY" \
  -H "Idempotency-Key: episode-0042" \
  -H "Content-Type: application/json" \
  -d '{
    "link": "https://www.youtube.com/watch?v=VIDEO_ID",
    "options": { "word_timestamps": true, "summary": { "preset": "bullets" } }
  }'
```

```json
{
  "transcription": {
    "id": "trj_…",
    "status": "queued",
    "stage": "probe",
    "credits": 41,
    "free": false
  }
}
```

Options: `language` (ISO code, or omit to detect), `word_timestamps`, `use_creator_captions` and `summary` (see [Add-ons](#add-ons)). A playlist or folder link previews its items; send the ones you want as `items[]` (at most {{maxLinksPerBatch}}). Set `confirm_above` to park any job that would cost more than that many credits in `awaiting_confirmation` instead of charging it.

### Poll

```bash
curl https://transcriptanything.zhst.app/api/v1/transcriptions/trj_… \
  -H "Authorization: Bearer $TA_API_KEY"
```

```json
{
  "transcription": {
    "id": "trj_…",
    "status": "succeeded",
    "durationSeconds": 842,
    "billableMinutes": 15,
    "chargedCredits": 41,
    "formats": ["json", "txt", "srt", "vtt"],
    "addons": { "status": "done", "preset": "bullets", "summary": "- …" }
  }
}
```

Statuses: `queued`, `leased`, `preview_ready`, `awaiting_confirmation`, `succeeded`, `failed`, `cancelled`, `expired`. Stages: `probe`, `transcribe`, `addons`.

### Upload a file

```bash
# 1. ask for a presigned PUT
curl -X POST https://transcriptanything.zhst.app/api/v1/uploads \
  -H "Authorization: Bearer $TA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"filename":"call.mp3","content_type":"audio/mpeg","size":18432221}'

# 2. PUT the bytes straight to storage (no auth header: the URL is signed)
curl -X PUT --upload-file call.mp3 "<url from step 1>"

# 3. queue it
curl -X POST https://transcriptanything.zhst.app/api/v1/transcriptions \
  -H "Authorization: Bearer $TA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"upload_id":"upl_…","options":{"language":"vi"}}'
```

## Webhooks

Register an endpoint from **API keys & webhooks** in the account menu. Every delivery is signed with HMAC-SHA256 over `timestamp.body` and retried five times with backoff.

Events:

- `transcription.completed`
- `transcription.failed`
- `webhook.test` (sent by the test button)

### Envelope

```text
POST https://your-app.com/hooks/transcriptanything
x-td-event: transcription.completed
x-td-delivery: evt_…
x-td-signature: t=1761600000,v1=5f2c…

{
  "id": "evt_…",
  "type": "transcription.completed",
  "created_at": "2026-10-27T09:00:00.000Z",
  "data": {
    "transcription_id": "trj_…",
    "status": "succeeded",
    "duration_seconds": 842,
    "charged_credits": 41,
    "result": {
      "json": "/api/v1/transcriptions/trj_…/result?format=json",
      "srt": "/api/v1/transcriptions/trj_…/result?format=srt",
      "txt": "/api/v1/transcriptions/trj_…/result?format=txt",
      "vtt": "/api/v1/transcriptions/trj_…/result?format=vtt"
    }
  }
}
```

### Verify the signature

The secret is returned once when the endpoint is created. Reject timestamps older than five minutes and compare before parsing the body.

```js
const [timestampPart, signaturePart] = header.split(",");
const timestamp = Number(timestampPart.split("=")[1]);
const signature = signaturePart.split("=")[1];
if (Math.abs(Date.now() / 1000 - timestamp) > 300) return reject("stale");

const key = await crypto.subtle.importKey(
  "raw",
  new TextEncoder().encode(secret),
  { name: "HMAC", hash: "SHA-256" },
  false,
  ["sign"],
);
const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(timestamp + "." + rawBody));
const expected = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
if (expected !== signature) return reject("bad signature");
```

### Retries

Return 2xx within 5 seconds. Failed deliveries are retried five times with backoff. Twenty consecutive failures disable the endpoint and you get an email; re-enable it after fixing the receiver. Deliveries are at-least-once, so deduplicate on `x-td-delivery`.

## Limits and pricing {#limits}

Credits are the unit of account; minutes are derived from them.

| Item | Cost |
|---|---|
| Media up to {{freeMinutes}} minutes, no add-ons, from the website | Free |
| Transcription | {{creditsPerMinute}} credits per started minute |
| Creator captions (YouTube) | Free, own daily quota |
| Word timestamps | +{{wordTimestampsCreditsPerMinute}} credit per minute |
| Summary or filter | +{{summaryCredits}} credits, only on success |
| Any job created with an API key | +{{apiSurchargeCredits}} credits |

Credits come in one-time packs, no subscription:

{{packTable}}

| Limit | Value |
|---|---|
| Free jobs per day | {{guestFreeJobs}} for guests, {{userFreeJobs}} when signed in |
| Free caption fetches per day | {{guestFreeCaptions}} for guests, {{userFreeCaptions}} when signed in |
| Monthly minutes per account | {{monthlyCapMinutes}} by default (`402 quota_exceeded` above it) |
| Links per batch or playlist | {{maxLinksPerBatch}} |
| Upload size | {{maxUploadMbFree}} MB free, {{maxUploadGbPaid}} GB with credits |
| Media retention | {{mediaRetentionHours}} hours |
| Result retention | {{resultRetentionDays}} days |

## Errors

Errors use `application/problem+json` with a stable `code`. Branch on `code`, not on the message.

| Code | HTTP | Meaning |
|---|---|---|
| `invalid_input` | 400 | The link, upload or options are missing or invalid. |
| `unauthenticated` | 401 | The key is missing, expired or revoked. |
| `insufficient_credits` | 402 | Top up to continue. No credits were used. |
| `forbidden` | 403 | The key lacks the scope, or the job belongs to another account. |
| `not_found` | 404 | The job does not exist or has expired. |
| `quota_exceeded` | 402 or 429 | 402: the monthly minute cap was reached. 429: a free daily allowance or the free queue is full. |
| `rate_limited` | 429 | Too many requests; wait for `Retry-After`. |
| `dependency_unavailable` | 503 | A source or transcription worker is unavailable; try again shortly. |

Retry `429` after `Retry-After` and `5xx` with backoff. Reusing an `Idempotency-Key` is always safe.

## n8n / automation {#n8n}

The importable example workflow (HTTP Request, Wait, Webhook) lives in `docs/transcript/n8n/transcribe-link.json` in the repository.

1. Create a Header Auth credential: name `Authorization`, value `Bearer tt_live_...`.
2. HTTP Request `POST /api/v1/transcriptions` with the link and an `Idempotency-Key` derived from your own record ID.
3. Either wait for the `transcription.completed` webhook, or poll `GET /api/v1/transcriptions/{id}` every few seconds.
4. Download `result?format=txt` (or `srt`, `vtt`, `json`) with the same credential.

## Sources

Paste a share link or a direct media URL:

- Cloud drives: Google Drive, OneDrive and SharePoint, Dropbox.
- Video and audio sites: YouTube, TikTok, Facebook, Instagram, X, Vimeo, Loom, SoundCloud.
- Direct MP3, MP4 and other media URLs, and podcast RSS feeds.
- File upload, up to {{maxUploadMbFree}} MB free or {{maxUploadGbPaid}} GB with credits.

Playlists and folders expand into a checklist of up to {{maxLinksPerBatch}} items. DRM-protected services (Spotify, Netflix, Apple Music and Apple Podcasts) are not supported. Private and local network addresses are rejected. You must own the media or be licensed to transcribe it.

## Add-ons

| Option | Cost | What you get |
|---|---|---|
| `word_timestamps: true` | +{{wordTimestampsCreditsPerMinute}} credit per minute | A timestamp per word in the JSON result. Not available with creator captions. |
| `summary: { "preset": "short" }` | +{{summaryCredits}} credits | A 3–5 sentence summary. |
| `summary: { "preset": "bullets" }` | +{{summaryCredits}} credits | The key points as bullets. |
| `summary: { "preset": "chapters" }` | +{{summaryCredits}} credits | Chapter headings with start times. |
| `summary: { "preset": "qa" }` | +{{summaryCredits}} credits | Question and answer pairs. |
| `summary: { "preset": "filter", "instruction": "…" }` | +{{summaryCredits}} credits | Only the parts that match your instruction. |
| `use_creator_captions: true` | Free | The creator's existing YouTube captions instead of a new transcription. |

Add-ons run after the transcript is delivered. If an add-on fails, its credits are released and the transcript is still returned with `addons.status` set to `failed`.

## Changelog

- **2026-10-30**: all docs live on this page; old `/docs/*` URLs redirect to the matching section. The full text is at [/llms-full.txt](/llms-full.txt).
- **2026-10-27**: public API, webhooks, uploads, link preview and batch.
