# Ota

> Part of [OpenWork](../../README.md). Shared code lives in [`packages/`](../../packages).

**Use it as a base for:** A multi-tenant release host: per-app push tokens, plans that cap bundle size and retention, encrypted bring-your-own-bucket credentials, and a public manifest endpoint mobile clients poll.

Over-the-air update server for mobile app bundles (mobile clients keep the contract of the update plugin they already use and only change the base URL). It started from the `npm run new-app` scaffold.

```bash
npm run dev -w @templatedesign/ota      # http://localhost:4330
npm run test -w @templatedesign/ota
```

Before the first deploy create the real resources and paste their ids into `wrangler.jsonc`:

```bash
npx wrangler d1 create ota-web
npx wrangler kv namespace create SESSION
npx wrangler r2 bucket create ota-media
```

## OTA server

Mobile clients keep the plugin's contract and only change the base URL to `https://<host>/<workspace>`:

- `GET  /<workspace>/ota/{app}/{platform}/manifest.json` and `GET .../{file}` are public (no session).
- `POST|GET|DELETE /<workspace>/ota/{app}/{platform}/releases` need the app's push token as a bearer.
- Admin: `/<workspace>/admin/{releases,settings,activity,docs}`; JSON API at `/<workspace>/admin/api/*`
  (workspace admins and the owner only).

Deployment settings: `OTA_MAX_BUNDLE_BYTES` and `OTA_RETENTION_DAYS` (vars in `wrangler.jsonc`) and the
`OTA_SECRET_KEY` secret (32 bytes as 64 hex characters or base64) that encrypts bring-your-own bucket
credentials. A plan lowers the bundle ceiling and the retention window; it never raises them above these.

Plans (`src/lib/platform.ts`): free = 2 apps, 100 MB bundles, 30 days, 50 releases a month, shared storage;
pro = 20 apps, 1024 MB bundles (bounded by `OTA_MAX_BUNDLE_BYTES` and a 512 MB in-memory ceiling),
365 days, unlimited releases, bring-your-own S3 bucket. Downgrading never deletes data.

Edit `migrations.src/` and run `npm run compose:migrations`; never edit `migrations/` by hand.
Run `npm run preflight:ota` after pasting the ids (it catches placeholders and missing bindings), then
deploy with `./deploy-cf.sh ota`. The full runbook is
[`docs/mini-apps/deploy-and-operations.md`](../../docs/mini-apps/deploy-and-operations.md).

## Contributing

Issues and pull requests are welcome. Read the [contributing guide](../../CONTRIBUTING.md) first; the checks
for this project are `npm run check:ota && npm run test:ota`, run from the repository root.

## License

[MIT](LICENSE)
