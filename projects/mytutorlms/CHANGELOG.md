# Changelog

## 0.4.0 — 2026-11-26

- Open courses: a course can be open for free to every signed-in student. The course page offers sign-in (returning to the course afterwards, by code or by the emailed link) or, when signed in, Start learning; the dashboard lists open courses the student has not started. Starting records a complimentary grant (`comp`, `open:{courseId}:{studentId}`, no end date, no email) through the existing entitlement service, audited with the student as actor and rate limited to 20 per student per hour. It is idempotent, and a student whose grant for that course was ever revoked (any kind) is refused; lessons still go through `canAccess`. Draft and invite-only courses can never be started this way. Opening a course takes the right to grant access for it (owners; instructors only where the site lets them grant), a typed confirmation (`OPEN`) and a reason; every access change is audited. Closing a course writes its access first, so a failed save can leave it closed but never open. Start-learning errors are shown in the student's language, and the return to the course survives the emailed link opening in a new tab (30 minutes).
- Lesson resources: up to 10 labelled HTTPS links per lesson in addition to the original resource, which is still shown first. The workspace adds, edits, reorders and removes them; the classroom labels file links (.pdf, .zip, .dmg and similar) as downloads.
- Live sessions: per course, instructors and owners in scope schedule Zoom (or any HTTPS) classes with title, start, duration (15–480 minutes), link, optional passcode and notes, from a new Live sessions screen. Changes are revision-checked and audited without the link or passcode; deleting asks for confirmation. Students with access see upcoming, in-progress and recently ended sessions in their own time zone, with Join Zoom from 15 minutes before the start to the end, the passcode, a Google Calendar link and a client-generated .ics file (RFC 5545, UTC, escaped and folded). Sessions are hidden from students two hours after they end. The public course page shows upcoming titles and times only; links and passcodes are sent only with the classroom state, after the course access check.
- Lesson notes keep blank-line paragraphs and line breaks and link bare `https://` addresses (new tab, `noopener noreferrer`); notes remain plain text rendered by React.
- Compatibility: 0.3.0 reads courses with a strict schema and would reject any record with an unknown field (failing its workspace course list and hiding the course from the catalog). So the course record is unchanged and keeps schema version 1; course access and extra resources live in a new `courseOptions` collection keyed by course, and live sessions in `liveSessions`. Records written by 0.3.0 read as invite-only without extra resources. Rolling back to the 0.3.0 pair keeps working: open courses act as invite-only (students who started keep their grant), extra resources and live sessions are hidden, and nothing is dropped. A 0.3.0 course edit leaves the options untouched; extra resources of a lesson deleted in 0.3.0 are ignored and dropped at the next 0.4.0 save.
- Tests: 116 to 134, including route-level tests for open-course joins, refusals, revocation and rate limits, live session permissions and link visibility, the unchanged course record shape, resource validation, .ics escaping and notes linkify safety.

Not in this release: workspace text in Vietnamese (the new workspace labels show the Vietnamese name beside the English one), a reminder email before live sessions, recurring sessions, and a browser test of the new screens.

## 0.3.0 — 2026-10-22

- Student accounts: email code or link sign-in with rate limits (per address, per site, and per IP hash where the host provides a trusted client IP: Cloudflare, or Node with EmDash's trusted proxy headers), login-CSRF protection for links, hashed 30-day device sessions, sign out of one or every device, and profile and language settings. The first verified sign-in ends any session an invitation opened.
- Course access as entitlements with one gate, `canAccess` (entitlement, then lesson). Account requests and 0.2 invitation sessions on linked enrollments go through it; unlinked 0.2 invitation sessions keep their 0.2 rules until they expire or are migrated. Access ending keeps progress and shows on the dashboard.
- Student dashboard at `/learn`, course classroom at `/learn/[courseId]`, account page at `/account`, sign-in pages. Accepting an invitation grants the course to the invited email's account; it signs in only an account that never verified its email, otherwise the student signs in by code. 0.2 invitation sessions keep working and are offered an upgrade. Each reissued invitation is its own grant.
- Workspace roles (owner, instructor, assistant) scoped to courses, enforced on the server; owner bootstrap for EmDash administrators; typed confirmation and a reason for high-impact actions; append-only redacted audit log.
- Workspace screens: Students (directory, access, manual and complimentary grants, sign-out, disable), Team, and Site and records (settings, account upgrade, audit log, email log).
- Transactional email outbox with Vietnamese and English templates, retries with backoff and access-ending notices from cron. Sign-in codes are sent immediately and never stored.
- Owner-run account migration with dry run, resumable pages and a revert escape hatch; an account's active 0.2 invitation is recorded as its grant on first use.
- Operations: `/api/health` and `/api/health/deep`, matched-pair check, GitHub Actions CI, Node and Cloudflare backup scripts with manifests, restore verification, backup runbook, secrets inventory and per-site config with an isolation check.
- An independent security review before release found an invitation-link account takeover, a revoke-during-upgrade race, invitation sessions ignoring account access, instructor student edits, broken re-invites, an untrusted IP header and email resend gaps; all were fixed with regression tests.
- Design system: one token file (`--mt-` colours, type, spacing, motion) shared by the theme and the workspace, light and dark schemes with contrast checked by tests, Vietnamese line heights, self-hosted Newsreader with a Vietnamese subset, and a Lucide icon subset. A creator's accent applies only when it keeps 4.5:1 contrast, and site settings reject one that does not.
- Shared interface pieces for the theme and the workspace: an accessible confirmation dialog (with typed confirmation and a reason where needed), sheet, toast, alerts, status pills and progress. Every `window.confirm`, `alert` and `prompt` is gone; only the browser's own prompt when closing a tab with unsent work remains.
- Classroom redesign: the lesson comes first on every screen size, the curriculum is a column on large screens and a sheet on phones, and Mark complete and Next lesson stay in reach at the bottom of phones. Behaviour is unchanged: drafts, leave guards, session-change protection and sign-out work as before. Sign-out, language and light/dark/auto moved to the header's account menu.
- Vietnamese and English interface for sign-in, invitations, the dashboard (resume card, access status, access-ending notice), the classroom, assignments, video messages and the account page, with dates, numbers and prices formatted per language. The storefront pages stay English for now.
- Workspace navigation: Courses, Students, Grading, Team and Site and records live in the address (`#/students`, `#/courses/{id}/grading`), so Back works and screens can be bookmarked. Grading shows the list and the review side by side on wide screens.
- UX telemetry: `POST /api/events` accepts a fixed list of events with identifier-only properties, rate-limited, written to Cloudflare Workers Analytics Engine when the site names a dataset. Nothing is sent when the browser asks not to be tracked.
- Fixed while testing: the notification and access-ending jobs had names EmDash rejects, so they were never scheduled; unexpected plugin errors were not logged; an unreadable video secret took down the whole classroom instead of only its protected videos.
- An independent review of the redesign found, and this release fixes: the new accent check also ran when stored settings were read, so a site saved with a light accent would have failed on every request (it now applies only when saving); header sign-out left invitation sessions active (the classroom now signs out with its enrollment, failures are shown, and the invitation cookie is cleared); and workspace Back to another admin page skipped the unsaved-changes prompt.
- Tests: 74 to 116.

Not in this release: passkeys (kept off until the real-device gate passes), the Vietnamese storefront and workspace text, a native-speaker review of the Vietnamese strings, funnel events, axe and Lighthouse runs in CI, and a restore drill on a deployed site.

## 0.2.2 — 2026-10-22

- Reads version 2 enrollments (the account-linked format that 0.3 writes) and keeps their student link, so a site can roll back from 0.3 to this release without losing data. Still writes version 1 for new enrollments.
- Revoke, sign-out and progress updates now match on the enrollment's generation and session instead of its schema version, so they also work on version 2 rows.
- Required before upgrading a site to 0.3.

## 0.2.1 — 2026-10-21

- Added lesson video with a per-video provider choice: DoveRunner Multi-DRM (license token minted per playback session, Widevine/PlayReady via DASH, FairPlay via HLS) or Wistia (access-controlled, not DRM). Wistia also remains the production/dub source reference for DoveRunner videos and is never shown to students in that role.
- Added the `playback`/`playbackEnd` routes (`issueVideoPlayback`) gated by the enrollment session, course, lesson, delivery switch and live video; an atomic screen limit with "Watch here instead" (optionally also enforced by DoveRunner CSL); licenses that end before the session, which never outlives access; an HMAC learner reference; a playback ledger; revocation, reissue and sign-out end open sessions.
- Added the instructor **Lesson videos** screen (draft → verified → published → retired, one live video per lesson and language, site-wide pause) and encrypted plugin settings for provider keys.
- Classroom player: on-demand Shaka Player 5.2.12 for DoveRunner, Wistia web component, moving session code, explicit unsupported-device, paused and screen-limit states, no unprotected fallback. `/learn` now sends `strict-origin-when-cross-origin` for Wistia domain restrictions.
- Published lessons may rely on a published lesson video instead of notes (checked on the server).
- One live video per lesson and language through a compare-and-set live pointer; malformed video rows are skipped on student paths; the last video of a lesson without notes cannot be retired.
- Tests: 53 to 72, including DoveRunner's published token test vector, parallel playback starts and parallel publishes.

Not yet implemented: forensic watermarking, CloudFront backup delivery, captions, resume position and the Wistia import/dub pipeline. Real DRM playback has not been tested with DoveRunner credentials.

## 0.2.0 — 2026-10-18

- Added private per-lesson text/HTTPS-link submissions with instructor feedback, Needs revision, Accepted and reopening.
- Added revision-checked review/resubmission, one current attempt per enrollment/lesson, and independent lesson completion.
- Added course-level instructor assignment lists/status filters, feedback editing, stale-write recovery and unsaved-feedback protection.
- Added student draft preservation across failures and lesson switches, explicit feedback refresh, accepted read-only views and safe external links.
- Bound browser writes and local drafts to enrollment identity to prevent another tab's invitation from submitting one student's work as another.
- Added the `submissions` collection without rewriting existing course/enrollment/progress data; documented retained work, overwritten feedback and paired upgrade/rollback.
- Expanded behavioral tests from 30 to 53; exercised the actual Node browser/HTTP and local Worker/D1 assignment loops. See `VERIFICATION.md`.

## 0.1.0 — 2026-10-18

- Added paired EmDash 1.2.0 native LMS plugin and Astro 7.3.5 theme for ZeroHostCMS evaluation.
- Added instructor draft/publish editing with stable lesson IDs and optimistic concurrency; public curriculum never exposes private lesson content.
- Added manually shared, single-use private invitations, hashed credentials, HttpOnly learning sessions, rotation and revocation.
- Added persistent per-lesson progress and instructor enrollment/progress views.
- Added responsive text/video/resource classroom, resume navigation, stale-curriculum recovery, same-page invitation handling, and explicit unavailable/error states.
- Added Node/SQLite and Cloudflare/D1/R2 hosts with persistent local Worker data, isolated production configuration and deployment guidance.
- Added 30 behavioral tests, packed-plugin verification and real browser/HTTP smoke coverage. See `VERIFICATION.md` for exercised surfaces and limits.

This release is source for platform review, not a claim of ZeroHostCMS approval, deployment, payment processing, email delivery or verified production backup recovery.
