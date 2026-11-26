# MyTutor LMS native plugin

`@mytutor/plugin-mytutor-lms`, runtime ID `mytutor-lms`, version `0.3.0`. Pinned to **EmDash 1.2.0**. Independent native implementation for ZeroHostCMS source review; not a pre-approved platform installation.

## Build and register

```sh
npm ci
npm run typecheck
npm test
npm run build
npm pack
```

The package exports `mytutorLmsPlugin()` and the native `createPlugin` factory. The React admin entry is `@mytutor/plugin-mytutor-lms/admin`. Its workspace is `/_emdash/admin/plugins/mytutor-lms/workspace`, with screens in the URL hash so Back works.

The design system is exported for the theme: `./tokens.css` (the single token source; `npm run tokens:json` mirrors it for design tools), `./ui` and `./ui.css` (dialog, sheet, toast, alerts and other primitives shared with the workspace), `./icons` (a Lucide subset; `npm run icons:build` regenerates it) and `./contrast`.

```js
import { mytutorLmsPlugin } from '@mytutor/plugin-mytutor-lms';
// Add to the host's existing emdash integration; retain its DB/storage/react setup.
emdash({ /* host configuration */, plugins: [mytutorLmsPlugin()] });
```

Use the paired [`../../themes/mytutor`](../../themes/mytutor/README.md) host. Install a packed tarball for independent distribution. Keep `dist`, `src/admin`, shared types/validation, and this README in the package; the admin source is deliberately compiled by the Astro host.

## Authority and data

The declaration in [`src/index.ts`](src/index.ts) owns routes and storage. Native execution has host authority and is **not sandboxed**. Native format is used for the published React admin integration and atomic plugin-storage operations. No filesystem, external network, CMS content, user-directory, payment, or email capabilities are used by this plugin. DoveRunner license tokens are minted locally with Web Crypto; the plugin itself makes no outbound request. Video provider keys are EmDash `secret` settings, encrypted with `EMDASH_ENCRYPTION_KEY` and never returned to the browser.

- Administrative routes require EmDash's `plugins:manage` permission and its cookie-CSRF header. Students are **not CMS users**.
- The public `catalog` route projects only published course metadata and curriculum. Never put private lesson material in public summary/description fields.
- Public `exchange`, `library`, `complete`, `submit`, `playback`, `playbackEnd`, `logout` endpoints implement their own enrollment credentials. Their `public` declaration is a transport requirement, not permission to read private content without a valid credential.
- The theme calls only declared-public plugin routes on the server, supplies the `x-mytutor-session` header from an HttpOnly cookie, and requires same-origin browser requests plus a custom header. Browser submit/complete/logout calls also carry `X-MyTutor-Enrollment`, checked against the captured cookie's enrollment prefix. This is a stale-tab precondition, never an authorization credential or caller-selected storage owner.
- Tokens contain 256-bit random secrets; only SHA-256 hashes are persisted. Invitation consumption/session issuance share one compare-and-set on the enrollment. Reissue invalidates previous invitations/sessions. Revocation blocks subsequent access immediately.
- Logout invalidates the server token. The theme intentionally does not expire the shared browser cookie in a logout response: a delayed response must not erase a newer session issued in another tab. The invalid cookie cannot authorize access and is overwritten by the next invitation.

Plugin-owned collections:

| Collection | Contents |
| --- | --- |
| `courses` | Schema-versioned course/lesson aggregate and revision |
| `enrollments` | Course, student name/email, active state, credential hashes/expiry, activity timestamp |
| `progress` | Independent completion record per enrollment/lesson |
| `submissions` | Current text/link attempt and review per enrollment/lesson, indexed by enrollment and course |
| `mediaAssets` | Lesson video per lesson, language and version: provider, DoveRunner content ID and manifests or Wistia media ID, state |
| `mediaLive` | Live pointer per course, lesson and language naming the published video |
| `mediaRouteState` | Site-wide video delivery switch (live or paused) with reason |
| `playbackSessions` | Playback ledger: opaque learner reference, enrollment, lesson, video, provider, device label, issue/expiry/end times |
| `playbackSlots` | Open sessions per enrollment, used to enforce the screen limit atomically |
| `courseOptions` | Per course (0.4): who may start it (`invite` or `open`) and extra lesson resources |
| `liveSessions` | Live classes per course (0.4): title, start, duration, join link, passcode, notes |

The stable course/normalized-email key prevents duplicate concurrent enrollments. Independent progress writes prevent simultaneous completion of different lessons from overwriting each other. Course writes use optimistic revisions: reload on conflict instead of overwriting another instructor's work.

A completion or submission already authorized before an overlapping revocation can persist its write: the public storage API has no transaction spanning enrollment/course and progress/submission records. Final authorization and current-lesson checks withhold private responses; requests starting after revocation are denied. Revocation cannot retract text/video/work already delivered to a browser.

## Content and enrollment limits

Executable limits live in [`src/validation.ts`](src/validation.ts): up to 100 lessons, 512 KiB per course save, 20,000 characters per lesson body, and 160-character titles/labels. Published courses need a title, summary, instructor and at least one complete lesson. Lessons need title/module and text, a direct video, or a published lesson video (checked on the server). Duration is an integer from 0 to 1,440 minutes. Drafts may be incomplete.

Text is escaped plain text, not HTML or Markdown. Videos require HTTPS direct `.mp4`, `.webm`, `.ogg`, `.ogv`, or `.m4v` URLs; query signatures are allowed. Resource links require HTTPS and a label. No arbitrary iframes or YouTube/Vimeo watch-page embedding. Providers receive the student's network request when they play/open a resource. Use only content you have rights to distribute, provide transcripts in lesson notes, and configure provider access rules. Shared/signed URLs are not DRM.

One enrollment has one current 30-day session. Invitations expire after 7 days and are single-use. New devices, sign-out, expiry and lost browser cookies require instructor reissue. Progress survives reissue/revocation and is counted only against current stable lesson IDs. New materially different lessons should receive new IDs instead of reusing a removed lesson's ID.

## Lesson video (DoveRunner or Wistia)

Each lesson can have a **lesson video** from one of two providers, chosen per video in **MyTutor workspace → Lesson videos**:

| Provider | Protection | Students receive |
| --- | --- | --- |
| DoveRunner Multi-DRM | Encrypted stream; a license token per playback session, bound to the content ID, for a streaming (not offline) license whose duration ends before the session does | Manifest URL and a license token for the browser's DRM (Widevine, PlayReady or FairPlay) |
| Wistia | **Access-controlled, not DRM.** Only enrolled students are given the media ID, but anyone holding that ID can play it | Wistia media ID for the Wistia player |

Wistia stays the production and dubbing source for DoveRunner videos (an optional production media ID on a DoveRunner video is never sent to students). Use DoveRunner for paid content; Wistia playback suits free or low-risk lessons.

**Settings** (EmDash → Plugins → mytutor-lms → Settings): `Enable DoveRunner secure video`, site ID, site key and access key (secrets), `Allow Wistia playback (not DRM)`, `Let DoveRunner enforce the screen limit` (needs Concurrent Stream Limiting enabled in DoveRunner Console), screens per student (1–5, default 1) and playback session length (15–720 minutes, default 240). A provider that is off, or DoveRunner without valid keys, makes its lessons unplayable instead of falling back to anything unprotected.

**Video states:** draft → verified (the instructor confirms a real-device playback) → published → retired. Editing returns a video to draft; published videos cannot be edited. Each lesson and language has one live pointer, moved with compare-and-set: publishing points it at the new video first, then retires the previous one, whichever provider it used. The classroom plays the student's browser language when it is live, else the original, else any live language. The last live video of a published lesson without notes or a direct link cannot be retired. **Pause all video playback** stops new sessions site-wide (vendor incident); there is no backup delivery route yet.

**Playback** (`playback`): the server checks the session, course and lesson (`canAccess`), the delivery switch and the live video, then claims a screen in the learner's slot record with compare-and-set, so parallel requests cannot exceed the limit. A refused screen gets `DEVICE_LIMIT` with the other screens' coarse device labels; **Watch here instead** ends that session. The classroom replaces its own previous session when switching lessons or reloading, and ends it when the page closes. Each session ends at the earlier of the session length and the learner's access expiry; a DoveRunner license lasts that long minus the 600-second token window, so it cannot outlive the session. Access, the delivery switch and the live video are checked again after the ledger write; any change ends the new session. `playbackEnd` lets a student end only their own session. Revoking, reissuing an invitation and signing out end the learner's open sessions. DoveRunner receives an opaque learner reference (an HMAC with a per-site random key), never an email.

Limits to state honestly: the server's screen limit applies when a video starts. A screen that is replaced or revoked keeps playing what it already holds (a Wistia stream, or a DoveRunner license until its end time) unless **Let DoveRunner enforce the screen limit** is on and CSL is enabled in DoveRunner Console. DoveRunner tokens are valid for 600 seconds after issue and can be replayed by whoever holds one in that window. Forensic watermarking, caption delivery, resume position and the CloudFront backup route are not implemented; the visible session code over the player is a deterrent, not forensic evidence. Device and DRM behaviour (C08), revocation timing (C09) and site isolation (B07) must be proven on real accounts and devices before selling protected courses.

## Assignment review

Write the task in the lesson notes. Each current lesson supports one private text or HTTPS-link submission per enrollment. `submit` derives ownership from the authenticated session and takes only lesson ID, prior revision, kind and content. `admin/submissions` and `admin/review-submission` require `plugins:manage`; reviews include an expected course and submission revision. The source declarations and schemas are authoritative.

New work is **Submitted**. Instructors choose **Needs revision** (nonblank feedback required) or **Accepted**. Students can replace submitted/needs-revision work with a new attempt; prior feedback is cleared. Accepted work cannot be changed by the student until an instructor requests revision. Submissions and instructor reviews share a compare-and-set record, so concurrent review/resubmission cannot silently overwrite each other. A conflict requires explicitly loading the latest saved version before deciding again.

Text/feedback: 4,000 characters; URL: 2,048 characters; native submit/review request: 32 KiB. Content is escaped plain text. HTTPS URLs cannot contain credentials, whitespace/control characters or malformed escapes. The server never fetches a submitted URL; a person opening it sends a normal browser request to that external site. There are no uploads, marks/grades, email notifications, required-assignment gates or stored attempt history. Lesson completion stays independent.

Students see only their current enrollment's work on published/current lessons. Administrators can review current-lesson work even while a course is unpublished or enrollment revoked; review does not restore student access. Removed lessons' records are retained but hidden, and reusing a stable lesson ID restores that association. Reissuing an invitation retains assignments, feedback and progress.


## Student accounts and access (0.3)

Services live in `src/services/`; routes in `src/routes/student.ts` and `src/routes/admin.ts`; `src/context.ts` builds them per request.

- **Accounts:** one student per email (an email claim record makes this atomic). Sign-in codes are 6 digits, 15 minutes, 5 attempts, compared in equal time; links are bound to the requesting browser and ask for confirmation elsewhere. Sessions are random tokens stored as SHA-256 hashes, 30 days absolute; rotating the student's generation signs out every device.
- **Access:** `grantEntitlement` is idempotent on `(source, sourceRef)` and never reactivates a revoked grant; invite grants are keyed per invitation (`enrollment:invitedAt`), so a reissued invitation is a new grant. `canAccess` is the gate for account requests and for 0.2 invitation sessions on linked enrollments (entitlement, then lesson; release and learning-path checks join in 0.5 and 0.7). An account's active 0.2 invitation becomes its `invite` grant on first use; revoked invitations never do, and linking never reactivates an enrollment.
- **Invitations and accounts:** accepting an invitation signs in only an account whose email was never verified; a verified account gets the grant and signs in by code. The first verified sign-in rotates the account, ending sessions an invitation opened.
- **Staff:** admin routes admit EmDash Contributors and enforce owner/instructor/assistant with course scope in the service. Editing, disabling or signing out a student is owner-only; granting and revoking access can be opened to instructors per site, scoped to their courses. Inviting a new email creates its student record, as in 0.2. EmDash administrators without a staff row are owners. The last owner cannot be removed or demoted. High-impact actions need a typed confirmation and a reason; EmDash does not expose admin sign-in time, so this is not a recent-authentication check.
- **Audit and email:** the audit log is create-only and redacts credentials and emails; email goes through `ctx.email` (capability `email:send`) with an outbox, backoff and cron dispatch. Sign-in and invitation emails carry secrets that are never stored, so they are never retried or resent. Jobs are scheduled on activation and again when an owner opens the workspace.
- **Rate limits:** per address, per site and per IP hash. The IP is EmDash's `requestMeta.ip` (trusted `CF-Connecting-IP` on Workers; on Node set `EMDASH_TRUSTED_PROXY_HEADERS` behind a proxy), else the theme bridge's copy of it. Known limits: counters are checked then counted, so a burst can overshoot slightly; with self-signup off, response timing can differ for unknown emails.

New collections: `site`, `students`, `studentEmails`, `studentSessions`, `signInChallenges`, `entitlements`, `auditEvents`, `notifications`, `staff`, `rateLimits`. `enrollments` gains a `studentId` index and version 2 records.

## Open courses, lesson resources and live sessions (0.4)

- **Course options live beside the course.** 0.3 parses course records strictly, so a new field would make 0.3 reject the course (and its whole workspace list). `access` and the extra lesson `resources` are stored in `courseOptions`, keyed by course ID; the course record keeps its 0.3 shape and schema version 1. The workspace and classroom see one merged course. An options row is written only once a course uses one of these options; a row this release cannot read counts as invite-only without extra resources.
- **Open courses.** `access: "open"` on a published course lets any signed-in student choose Start learning (`join`). It records a `comp` grant with `sourceRef` `open:{courseId}:{studentId}`, actor the student, no end date and no access-granted email; repeating it is a no-op, a student with any revoked grant for that course is refused, and lessons still go through `canAccess`. Draft and invite-only courses refuse with `NOT_OPEN`. Starts are rate limited to 20 per student per hour. Opening a course needs `entitlement.grant` for it (owners; instructors only with `instructorsMayGrant`), the typed phrase `OPEN` and a reason; closing it writes the options row before the course, and other option writes retry once then report `PARTIAL_SAVE`; access changes are audited as `course.access`. Turning it back to invite-only stops new starts; existing grants stay.
- **Lesson resources.** Up to 10 `{label, url}` per lesson (label 1–120 characters on one line, HTTPS URL up to 2,048 characters without credentials), shown after the original `resourceUrl`/`resourceLabel`.
- **Live sessions.** `liveSessions` (indexed by `courseId`): title, start (UTC), 15–480 minutes, HTTPS join link, optional passcode (40) and notes (1,000). Instructors and owners in scope manage them (`course.edit`); create, update and delete are revision-checked and audited without the join link or passcode. The classroom state (`library`/`classroom`, behind the course access check) carries sessions that ended less than two hours ago, with join details; the public `catalog` carries only the titles and times of sessions that have not ended. A session never moves to another course.

## Lifecycle and recovery

Upgrade 0.3.0 → 0.4.0 is additive: EmDash provisions `courseOptions` and `liveSessions`; existing records are not rewritten and no course schema version changes. Back up first, deploy the matched pair. Rolling back to the 0.3.0 pair is safe: 0.3.0 reads every course, ignores both new collections (their rows stay in storage), treats open courses as invite-only, and hides extra resources and live sessions; students who already started an open course keep their `comp` grant. Editing a course in 0.3.0 leaves its options row untouched, so 0.4.0 shows them again after a roll forward; extra resources of a lesson that 0.3.0 removed are ignored and dropped at the next 0.4.0 save.

Upgrade 0.2.x → 0.3.0: deploy 0.2.2 everywhere first (it reads version 2 enrollments), back up, then deploy the 0.3.0 pair and run the owner migration when ready. Rollback is the 0.2.2 pair; the migration's revert mode is an escape hatch and restoring the backup is the last resort. See `ops/runbooks/backup-restore.md`.

Upgrade 0.2.0 → 0.2.1 is additive: EmDash provisions `mediaAssets`, `mediaLive`, `mediaRouteState`, `playbackSessions` and `playbackSlots`; existing records are untouched and no video is enabled until an administrator turns a provider on. Roll back only as a matched theme/plugin pair, and **add notes to every published lesson that relies on lesson video alone first**: 0.2.0 rejects such a course record, which makes the whole 0.2.0 course list fail and blocks saving that course from the 0.2.0 workspace. Video collections are left in place and ignored by 0.2.0.

Upgrade 0.1.0 → 0.2.0 is additive: core EmDash provisions the new declared `submissions` collection and indexes. Existing course/enrollment/progress records remain schema version 1 without backfill; new submissions also carry `schemaVersion: 1`. Unknown record versions fail closed. A prior-version synthetic Node course/enrollment fixture was exercised against the new release; deployed platform migration/recovery remains a maintainer gate. Update the paired theme and refresh existing browser tabs together with the plugin.

Removing registration/deactivating the plugin hides its routes/workspace but **does not delete courses, student information, progress, submissions or feedback**. Rolling back to the matched 0.1.0 pair removes assignment interfaces but does not erase assignment storage. There is no automatic destructive uninstall. Retention and deletion are operator decisions; use reviewed database/plugin-storage tools after backup and authorization. Backups also retain student work and feedback, so include them in your retention policy. Do not expose database backups or storage buckets publicly.

Back up the host database, any media and its encryption key as a coordinated recovery set. For Node, stop the process before copying the database (or use a consistent SQLite backup), then restore to a separate local host first. Restoring old data can restore old invitation/session hashes and revoked enrollments; review/revoke/reissue access before reopening a restored site. Source rollback alone does not roll data back. Deployed D1 recovery and operator approval must be rehearsed separately.

## Dependencies and verification

Runtime: Zod validation plus host peer dependencies EmDash/React. Build/test dependencies and exact versions are in `package.json` and `package-lock.json`; no install/build command publishes, provisions production resources, or collects credentials. The source uses public EmDash APIs and Web Crypto, with no Node-specific domain runtime.

`npm test` covers domain and consumer-visible admin validation/error behavior. These tests do not prove deployed HTTP permission boundaries; paired-host browser and HTTP smoke evidence is documented at the project root. No remote service or real customer data is required for local verification.

MIT for this original implementation. Third-party dependency notices/licenses are retained in their packages; no third-party images/fonts/media are distributed by the plugin.
