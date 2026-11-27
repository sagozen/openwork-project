<div align="center">

# OpenWork

**Production-grade open-source projects you can read, run and build on.**

Nine real products (paid MCP connectors, a transcription pipeline, an OTA update server, an LMS, a LIMS, a
geocoding API and more), each with tests, deploy notes and operating runbooks. Not demos.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)
[![Node](https://img.shields.io/badge/node-%3E%3D24.21-339933?logo=node.js&logoColor=white)](.nvmrc)
[![GitHub stars](https://img.shields.io/github/stars/sagozen/openwork-project?style=social)](https://github.com/sagozen/openwork-project/stargazers)

[Projects](#projects) · [Quick start](#quick-start) · [Find a starting point](#find-a-starting-point) · [Contributing](#contributing)

</div>

---

## Why this repository

Most open-source examples stop at "hello world". The hard parts of a real product (sign-in, tenant isolation,
billing and credits, background jobs, migrations, deploys, what to do when a worker dies) are usually missing.

Every project here is something its author built and runs, so those parts are included:

- **Real auth and multi-tenancy:** OAuth for AI clients, API keys, role-based access, isolation tests.
- **Real money paths:** credit wallets with reservation and settlement, Stripe or Paddle webhooks.
- **Real operations:** preflight checks, provisioning scripts, runbooks, failure codes and troubleshooting.
- **MIT licensed:** copy a whole project or a single pattern into your own work.

## Projects

| Project | What it does | Stack | Good base for |
|---|---|---|---|
| [ImageFactory](apps/imagefactory) | Brand-consistent AI images (Pinterest pins, blog heroes, covers) generated from Claude or ChatGPT through an MCP connector, billed in credits | Astro, Cloudflare Workers, D1, R2, fal.ai | A paid MCP connector with OAuth, wallet and REST API |
| [MyArtifacts](apps/myartifacts) | Private file transfer: save a file from chat, hand someone a view/download link, switch it off later | Astro, Workers, D1, S3-compatible storage | An owner-only MCP + REST service with share links |
| [OTA](apps/ota) | Over-the-air update server for mobile app bundles, with per-app push tokens and plans | Astro, Workers, D1, KV, R2 | A multi-tenant release-hosting backend |
| [TranscriptAnything](apps/transcript) | Paste a Drive, YouTube, TikTok or MP3 link and get a timestamped transcript; GPU workers do the heavy lifting | Astro, Workers, D1, R2, Go worker | A job queue with leased workers and credit settlement |
| [MyTutor LMS](projects/mytutorlms) | Course publishing: instructor workspace, student accounts, access grants, assignments, DRM video | EmDash CMS theme + plugin, Astro, Node/SQLite or Workers | A small LMS or a CMS plugin with real auth |
| [ChatQA](projects/chatqa) | QA desktop app that runs Maestro flows on real Android/iOS devices and Playwright flows in browsers | Go, Wails, React, Vite | A Wails desktop app with a local MCP server |
| [Astra CMS](projects/astra-cms) | Metadata-driven, plugin-first application platform with DocTypes, multi-tenancy and Wasm plugins | Java 25, Quarkus, PostgreSQL, Rust, Seata | Multi-tenant back-office and ERP architecture |
| [Open LIMS](projects/open-lims) | Laboratory information system front end: sample intake, testing, review, approval, report delivery | React, TanStack Start, Fluent UI, Clerk | A role-based, form-heavy internal tool |
| [Asia maps and twins](projects/asia-maps-twins) | Address suggest, address resolution and real road distance for Vietnam, plus a 3D city twin proof of concept | Python, FastAPI, PostGIS, Valhalla, OSRM | A self-hosted geocoding and routing API |

## Find a starting point

| I want to build... | Start with |
|---|---|
| An MCP server that Claude or ChatGPT can connect to, with OAuth | [ImageFactory](apps/imagefactory), [MyArtifacts](apps/myartifacts), [`packages/platform`](packages/platform) |
| A SaaS with credits, a wallet and payments | [ImageFactory](apps/imagefactory), [TranscriptAnything](apps/transcript) |
| A background job queue with workers on my own GPU | [TranscriptAnything](apps/transcript) + [`services/transcriber`](services/transcriber) |
| A self-hosted alternative to a paid OTA update service | [OTA](apps/ota) |
| An AI-driven test runner for mobile and web | [ChatQA](projects/chatqa) |
| A multi-tenant ERP or back-office platform | [Astra CMS](projects/astra-cms) |
| A large role-based internal tool with many forms | [Open LIMS](projects/open-lims) |
| An online course site | [MyTutor LMS](projects/mytutorlms) |
| My own geocoding and routing API instead of Google Maps | [Asia maps and twins](projects/asia-maps-twins) |

## Quick start

The four Cloudflare apps live in one npm workspace and share a platform (`packages/`): auth, wallet and ledger,
API keys, OAuth for MCP, admin, email and migrations. You do not need a Cloudflare account to run them locally.

```bash
git clone https://github.com/sagozen/openwork-project.git
cd openwork-project
nvm use                         # Node 24.21 or newer
npm install
npm run test:imagefactory       # also: test:myartifacts, test:ota, test:transcript, test:platform
cp apps/imagefactory/.dev.vars.example apps/imagefactory/.dev.vars
npm run dev:imagefactory        # http://localhost:4334
npm run new-app -- my-app       # scaffold your own app on the same platform
```

Everything under `projects/` is self-contained, with its own toolchain and README. Open the project folder and
follow its "Run it" section.

### Deploying a Cloudflare app

Wrangler files ship with all-zero resource ids. Create your own D1, KV and R2 resources (`npm run
provision:<app>` does a dry run first), then `npm run preflight:<app>` lists what is still missing before
`./deploy-cf.sh <app>`. Each app README and the [docs](docs/README.md) have the full runbook.

## Repository layout

```
apps/            Cloudflare Workers apps (imagefactory, myartifacts, ota, transcript)
packages/        Shared platform: platform, contracts, ui, tokens, app-shell
services/        transcriber: Go worker that runs on a home GPU or a VPS
scripts/         preflight, provision, scaffold and smoke-test helpers
docs/            Runbooks and decision records for the apps
projects/        Standalone projects, one folder each
```

The workspace packages keep their original `@templatedesign/*` names, so the apps import them unchanged.

## Using a project as a base

- Copy the folder you need. For `apps/*`, also copy `packages/` and the root `package.json`, `turbo.json` and
  `scripts/`, since the apps import the shared packages by workspace name.
- Replace the placeholder ids in `wrangler.jsonc`, the `you@example.com` admin address and the `*.zhst.app`
  hostnames with your own. The hostnames belong to the maintainer's deployments.
- Secrets are never committed. Only `*.example` files are included; each README lists the values you must set.
- Domain strings in `projects/open-lims` and `projects/mytutorlms` are Vietnamese because those products are
  built for Vietnamese users. Sample customers and addresses are fictional.

## What has been checked

For the four `apps/`, `npm run check:<app>` and `npm run test:<app>` pass, as does `npm run test:platform`.
The projects under `projects/` were copied as they stand and were not rebuilt for this repository, so follow
each README and expect to install dependencies first. GitHub Actions workflows are not included yet.

## Contributing

Contributions of every size are welcome, from a typo fix to a new project. Start here:

1. Read [CONTRIBUTING.md](CONTRIBUTING.md) for setup and the checks each project needs.
2. Look for issues labelled [`good first issue`](https://github.com/sagozen/openwork-project/labels/good%20first%20issue).
3. Open a pull request using the template.

Please follow the [Code of Conduct](CODE_OF_CONDUCT.md), and report security problems privately as described in
[SECURITY.md](SECURITY.md).

## Support the project

If one of these projects saved you time, **give the repository a star**. It helps other developers find it and
tells the maintainer which projects to keep investing in.

## License

[MIT](LICENSE) for every project in this repository.
