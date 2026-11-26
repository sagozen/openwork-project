# MyTutor theme and standalone host

An editorial course storefront and focused student classroom. Astro **7.3.5**, EmDash **1.2.0**, React **19.3.0**. Paired with `@mytutor/plugin-mytutor-lms`. The theme uses system fonts, original CSS and an original SVG favicon; no remote font, analytics, image or advertising service is loaded. Lesson video loads third-party code only on lessons that have one: Shaka Player 5.2.12 (bundled, loaded on demand) for DoveRunner, or Wistia's `fast.wistia.com` player scripts for Wistia lessons.

## Local Node host

Build the sibling plugin first, then:

```sh
npm ci
npm run secrets:generate # only on a fresh clone without .env
npm run typecheck
npm run build
npm run preview
```

Open **http://localhost:4321/**; the Node adapter may print `127.0.0.1`, but use `localhost` for administrator passkeys. `scripts/preview.mjs` supplies the local origin and binds to loopback. The fresh seed has no sample courses/students. Complete the built-in admin setup and open **MyTutor workspace**. Keep `.env`, `.data`, `.astro` and generated builds private.

Development: `npm run dev`. Astro 7 may start a background process; use `npx astro dev stop` before starting preview. Production: `npm start` after setting `EMDASH_SITE_URL` to the real HTTPS origin and providing a private generated `EMDASH_ENCRYPTION_KEY`. Use a process supervisor and trusted HTTPS reverse proxy. Never use `npm run dev` as the production server. Canonical-origin changes after passkey registration need EmDash's domain migration procedure.

Node state is `.data/emdash.db` and `.data/media`, relative to this theme's working directory. Start from this directory. Back up the database/media/key together; see the plugin's recovery notes. `seed/seed.json` is first-install metadata, not a migration or automatic course import.

## Cloudflare build and local runtime

```sh
npm run cloudflare:build
npm run cloudflare:preview -- --port 8787 --var EMDASH_SITE_URL:http://localhost:8787
```

Local Worker data persists under `.wrangler/state`, outside the generated build directory. When using D1 maintenance commands, pass the same `--persist-to .wrangler/state` flag alongside `--local` and `--config dist-cloudflare/server/wrangler.json`; never add `--remote` for smoke fixtures. Rebuilding does not intentionally reset student data.

The cloud build is separate (`dist-cloudflare`). `astro.cloudflare.config.mjs` uses the official D1/R2 adapters; `src/worker.ts` connects the official request and scheduled handlers. The pinned Wrangler/workerd supports compatibility date **2026-10-13**; a newer date initially failed locally. Strict server module execution order is required by the Kysely dependency graph, matching the community OTA host configuration.

`wrangler.jsonc` declares local resource names only. No production database IDs, account IDs or credentials are included. Astro adds `SESSION` KV and `IMAGES` bindings to the generated Worker config; inspect that generated config as part of platform evaluation. LMS media playback itself uses the instructor's external direct video links, not Cloudflare Images.

**No deployment script runs automatically.** ZeroHostCMS maintainers must select/review the exact source revision, evaluate it on isolated platform resources and approve a separate promotion before publication. For an approved deployment they must provide the canonical HTTPS origin, private encryption key, persistent D1/R2/KV bindings and scheduler, confirm core migrations, and test backup/restore. Building or running Wrangler locally is not evidence of production/platform approval. Never make the media/backup bucket public wholesale.

The [community contribution guide](https://github.com/ZeroHostCMS/zhst-community-themes/blob/main/CONTRIBUTING.md) owns publication requirements. For contribution into separate sibling community repositories, place this folder under `zhst-community-themes/themes/mytutor`, place the plugin under `zhst-community-plugins/plugins/mytutor-lms`, and deliberately update the local package dependency to `file:../../../zhst-community-plugins/plugins/mytutor-lms` with its lockfile; alternatively install the reviewed plugin tarball. This repository's checked-in layout uses `file:../../plugins/mytutor-lms`.

## Routes and browser data

- `/`: public published course catalog and empty/error states.
- `/courses/[id]`: published overview/curriculum; unavailable courses return 404.
- `/join`: invitation entry. Fragment secrets are removed before exchange; same-document hash changes are also handled.
- `/learn`: private student UI, noindex/nofollow.
- `/sign-in`, `/sign-in/verify` (link token in the URL fragment, removed at once), `/learn` (dashboard for accounts; the 0.2 classroom plus an upgrade offer for invitation sessions), `/learn/[courseId]` (account classroom), `/account`.
- `/api/auth/{start,verify-code,verify-link,upgrade,exchange-invitation,logout,logout-all}`: sets the host-only HttpOnly `mytutor_student` cookie (30 days) and the 15-minute `mytutor_signin` binding cookie; clears the 0.2 `mytutor_session` cookie once an account takes over.
- `/api/learn/{exchange,library,complete,submit,playback,playbackEnd,logout,dashboard,classroom,me,me-update,me-revoke-session}`: bounded POST-only same-origin bridge to declared-public plugin routes. Account requests carry `courseId`; the plugin checks the tab's `X-MyTutor-Enrollment` precondition.
- `/api/health`, `/api/health/deep`: version pair and storage health, no student data.
- `/api/events`: UX telemetry (`src/lib/analytics-events.ts` lists every event and property; identifiers only). Written to the Analytics Engine binding `MYTUTOR_EVENTS` when `deploy/sites/<site>/site.json` names `cloudflare.analyticsDataset`; accepted and dropped on Node.
- `/_emdash/admin/plugins/mytutor-lms/workspace`: native instructor workspace. Its screens live in the hash: `#/courses`, `#/students`, `#/grading`, `#/team`, `#/site`, `#/courses/{id}`, `#/courses/{id}/students`, `#/courses/{id}/grading`, `#/courses/{id}/videos`.

Lesson video: the classroom detects the browser's DRM (FairPlay, PlayReady, Widevine), asks `/api/learn/playback` for that lesson, and plays the returned DoveRunner stream through Shaka with the license token in the `pallycon-customdata-v2` header, or mounts `<wistia-player>` for a Wistia video. Without a usable DRM the student sees a "cannot play secure video" notice; there is never an unprotected fallback. A short session code moves around the player every 30 seconds. `/learn` sends `Referrer-Policy: strict-origin-when-cross-origin` (origin only, cross-site) because Wistia domain restrictions need the site origin; every other page keeps `no-referrer`. If you add a Content-Security-Policy, allow `fast.wistia.com`/`*.wistia.com`/`*.wistia.net`, `drm-license.doverunner.com` and your DoveRunner manifest CDN.

Student session secrets are HttpOnly, SameSite=Lax cookies and Secure over HTTPS. No student secrets are placed in localStorage/sessionStorage. Two preferences are not secret: the `mytutor_locale` cookie (interface language, one year) and `mytutor-scheme` in localStorage (light or dark; absent means follow the device). The telemetry session id lives in sessionStorage and is never sent when Do Not Track or Global Privacy Control is on. Lesson selection is a nonsecret query parameter. Private responses use `Cache-Control: private, no-store`; pages use `Referrer-Policy: no-referrer`. Do not add CDN cache rules over private/API/admin routes. Public pages also remain uncached in this initial host.

Assignment drafts are memory-only and keyed by enrollment plus lesson. Submit, complete and logout requests carry the enrollment loaded by the classroom in `X-MyTutor-Enrollment`; if another tab replaces the cookie with a different enrollment, the bridge rejects the write before invoking the plugin. Refreshing can open that enrollment while preserving old unsent work separately for copying, never attaching it to the new student's editor. This nonsecret ID does not grant access: the plugin still authenticates the full session token.

The assignment form supports text/HTTPS links, review status and feedback, explicit refresh/conflict recovery, and navigation warnings. Accepted work is read-only until an instructor requests revision. Native URL links open with `noopener noreferrer`; there is no server-side link preview. Submit bodies are capped at 32 KiB; other student bridge actions retain 8 KiB. See the plugin README for limits, overwrite/retention semantics and authorization.

Only the public overview/curriculum is sent anonymously. Course bodies/media/resource URLs are supplied after enrollment authorization. Text is escaped, not rendered as arbitrary HTML. Optional media/resource providers receive browser requests and may retain their own logs. The theme neither uploads nor transcodes videos. DoveRunner packaging (DASH and HLS with the same content ID) happens outside the site; real playback on each target device must be checked before launch.

## Supported surface

Vietnamese and English student interface (sign-in, invitation, dashboard, classroom, account) with the site's default language first; the storefront pages are English until they move to the catalog in `src/i18n`. Light, dark and device-following schemes from the shared tokens (`@mytutor/plugin-mytutor-lms/tokens.css`); the workspace stays light. Left-to-right only. Responsive from 320px, semantic landmarks, visible keyboard focus, native buttons and forms, a native `<dialog>` for confirmations, and reduced motion. No full WCAG certification is claimed.

Strings live in `src/i18n/{vi,en}.json` with the same keys; the plugin tests fail when a key or placeholder is missing. Vietnamese strings still need a native-speaker review before release.

For 0.1.0 → 0.2.0, stop the host, back up data/media/key, update both packages, rebuild and restart without replacing `.env` or data directories. No course seed/backfill change is required. Refresh old classroom tabs after the paired cutover. Switching away retains plugin data but removes student routes; removing the plugin disables teaching/learning operations. Rollback to a matched earlier pair hides assignment interfaces but does not erase stored work or feedback. Keep a complete backup and paired source/package revision for rollback.

MIT for original theme code. Framework/admin assets keep their upstream licenses. No private platform code or licensed commercial design assets were copied.
