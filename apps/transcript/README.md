# TranscriptAnything

> Part of [OpenWork](../../README.md). Shared code lives in [`packages/`](../../packages).

**Use it as a base for:** A job pipeline with leased workers: link classification with an SSRF guard, credit pricing and settlement, a heartbeat-driven worker fleet (home GPU first, VPS fallback), and signed worker release manifests.

Link-first transcription on the shared platform: paste a Drive, OneDrive, Dropbox, YouTube, TikTok
or direct MP3/MP4 link (or upload a file) and get a transcript with timestamps. Media up to 3
minutes is free; longer media costs credits per minute, with a monthly minute cap.

## Run it locally

```bash
cp .dev.vars.example .dev.vars       # then set BETTER_AUTH_SECRET
npx wrangler d1 migrations apply DB --local
npm run preflight                    # offline deploy check (also useful locally)
npm run dev                          # http://localhost:4323
```

Link jobs work without R2 S3 credentials; uploads need `R2_*` because the browser PUTs to a
presigned URL. Leave `TURNSTILE_*` empty locally; set both keys or neither in production.

## Deploy it

Follow [`docs/transcript/deploy-and-operations.md`](../../docs/transcript/deploy-and-operations.md)
in order:

1. Cloudflare resources (D1, KV, two R2 buckets, 24 h lifecycle) and `wrangler.jsonc` ids
2. vars + secrets, including the Turnstile pair
3. migrations, then `./deploy-cf.sh transcript`
4. payments (Stripe or Paddle) and the webhook endpoint
5. home GPU worker (`services/transcriber/deploy/windows/install-worker.ps1`)
6. VPS fallback worker (`services/transcriber/deploy/docker-compose.vps.yml`)
7. the verification matrix and the free-tier soft launch

Configuration reference (bindings, every secret, queue numbers):
[`docs/transcript/README.md`](../../docs/transcript/README.md).

## Layout

```
src/lib/platform.ts     createPlatform() for this product (brand, packs, quotas, scopes, hooks)
src/lib/pricing-core.ts the price table (3 credits/min, ≤180 s free, add-ons)
src/lib/jobs.ts         job lifecycle, pricing, lease completion, settlement
src/lib/workers.ts      heartbeat, lease routing (home first), tokens, slots, remote config
src/lib/worker-alerts.ts sustained CPU/RAM/disk/temperature warnings by email
src/lib/worker-releases.ts release channel and signed download manifests
src/lib/sources.ts      link classification + SSRF guard
src/lib/addons/         OpenRouter summary/filter with credit release on failure
src/pages/api/          public API, uploads, worker API, admin API
src/pages/              landing, pricing, dashboard, transcript view, admin, docs, legal
migrations.src/         app schema; `migrations/` is generated
```

Worker service: [`services/transcriber`](../../services/transcriber/README.md).
Shared core: [`packages/platform`](../../packages/platform/README.md).

## License

[MIT](LICENSE)
