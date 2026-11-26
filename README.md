# OpenWork

Open-source projects I built and run for real, collected in one repository so you can read them, run them and
copy what is useful. Each one solves a concrete problem and ships with its own tests, deploy notes and
operating runbooks, not just a demo.

| Project | What it does | Stack | Good base for |
|---|---|---|---|
| [`apps/imagefactory`](apps/imagefactory) | Brand-consistent AI images (Pinterest pins, blog heroes, covers) generated from Claude or ChatGPT through an MCP connector, billed in credits | Astro, Cloudflare Workers, D1, R2, fal.ai | A paid MCP connector with OAuth, wallet and REST API |
| [`apps/myartifacts`](apps/myartifacts) | Private file transfer: save a file from chat, hand someone a view/download link, switch it off later | Astro, Workers, D1, S3-compatible storage | An owner-only MCP + REST service with share links |
| [`apps/ota`](apps/ota) | Over-the-air update server for mobile app bundles, with per-app push tokens and plans | Astro, Workers, D1, KV, R2 | A multi-tenant release-hosting backend |
| [`apps/transcript`](apps/transcript) | Paste a Drive, YouTube, TikTok or MP3 link and get a timestamped transcript; GPU workers do the heavy lifting | Astro, Workers, D1, R2, Go worker | A job queue with leased workers and credit settlement |
| [`projects/mytutorlms`](projects/mytutorlms) | Course publishing: instructor workspace, student accounts, access grants, assignments, DRM video | EmDash CMS theme + plugin, Astro, Node/SQLite or Workers | A small LMS or a CMS plugin with real auth |
| [`projects/chatqa`](projects/chatqa) | QA desktop app that runs Maestro flows on real Android/iOS devices and Playwright flows in browsers | Go, Wails, React, Vite | A Wails desktop app with a local MCP server |
| [`projects/astra-cms`](projects/astra-cms) | Metadata-driven, plugin-first application platform with DocTypes, multi-tenancy and Wasm plugins | Java 25, Quarkus, PostgreSQL, Rust, Seata | Multi-tenant back-office and ERP architecture |
| [`projects/open-lims`](projects/open-lims) | Laboratory information system front end: sample intake, testing, review, approval, report delivery | React, TanStack Start, Fluent UI, Clerk | A role-based, form-heavy internal tool |
| [`projects/asia-maps-twins`](projects/asia-maps-twins) | Address suggest, address resolution and real road distance for Vietnam, plus a 3D city twin proof of concept | Python, FastAPI, PostGIS, Valhalla, OSRM | A self-hosted geocoding and routing API |

The four `apps/` share one platform (`packages/`): auth, wallet and ledger, API keys, OAuth for MCP, admin,
email and migrations. That makes them a monorepo you can build on. Everything under `projects/` is
self-contained and has its own README.

## Quick start (Cloudflare apps)

Requires Node 24.21 or newer.

```bash
npm install
npm run test:imagefactory      # also: test:myartifacts, test:ota, test:transcript, test:platform
npm run dev:imagefactory       # http://localhost:4334 (copy apps/imagefactory/.dev.vars.example to .dev.vars first)
npm run new-app -- my-app      # scaffold another app on the same platform
```

Wrangler files ship with all-zero resource ids. Create your own D1, KV and R2 resources (`npm run
provision:<app>` does a dry run first), then `npm run preflight:<app>` lists what is still missing before
`./deploy-cf.sh <app>`. Each app README has its own steps.

## Layout

```
apps/            Cloudflare Workers apps (imagefactory, myartifacts, ota, transcript)
packages/        Shared platform: platform, contracts, ui, tokens, app-shell
services/        transcriber: Go worker that runs on a home GPU or a VPS
scripts/         preflight, provision, scaffold and smoke-test helpers
docs/            Runbooks and decision records for the apps
projects/        Standalone projects, one folder each
```

The workspace packages keep their original `@templatedesign/*` names, so the apps import them unchanged.

## Using these as a base

- Copy the folder you need. For `apps/*`, also copy `packages/` and the root `package.json`, `turbo.json` and
  `scripts/`, since the apps import the shared packages by workspace name.
- Replace the placeholder ids in `wrangler.jsonc`, the `you@example.com` admin address and the `*.zhst.app`
  hostnames with your own. The hostnames belong to my deployments.
- Secrets are never committed. Only `*.example` files are included; each README lists the values you must set.
- Domain strings in `projects/open-lims` and `projects/mytutorlms` are Vietnamese because those products are
  built for Vietnamese users. Sample customers and addresses are fictional.

## What has been checked

For the four `apps/`, `npm run check:<app>` and `npm run test:<app>` pass, as does `npm run test:platform`.
The projects under `projects/` were copied as they stand and were not rebuilt for this repository, so follow
each README and expect to install dependencies first. GitHub Actions workflows were intentionally left out.

## License

[MIT](LICENSE) for every project in this repository.
