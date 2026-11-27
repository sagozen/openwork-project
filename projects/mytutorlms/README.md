# MyTutor LMS

> Part of [OpenWork](../../README.md).

A course publishing **theme and native plugin** for the ZeroHostCMS / EmDash 1.2.0 extension contract. Instructors
publish courses and lessons from a workspace inside the CMS admin. Students sign in with an emailed code (no
password), see every course they can access, work through lessons, and submit assignments. There is no checkout
yet: payments are collected outside the site.

**Use it as a base for:** a small LMS, or any EmDash plugin that needs real accounts. It shows course access as
time-limited grants checked in one place, per-course invitations, role scoping with an audit log, a transactional
email outbox with retries, protected video playback, and upgrade and rollback notes between plugin versions.

## Layout

```
plugins/mytutor-lms/     The native plugin: courses, lessons, enrollments, grants, assignments, video
themes/mytutor/          Astro theme: public pages, student classroom, account, instructor workspace
deploy/sites/example/    Per-site configuration template and the script that renders it
ops/                     Backup and restore runbook and scripts, version-pair check, secrets inventory
docs/courses/chatqa/     A complete real course (Vietnamese) as content-as-code, with media build tools
```

## What works

- Instructor workspace inside EmDash: draft/publish/unpublish courses; add, edit, remove and reorder lessons; optional direct HTTPS video and resource links.
- Public course overview and curriculum, with lesson bodies and media links kept private.
- Student accounts: sign in with an emailed 6-digit code or link (no password), a dashboard of every course, `/account` with signed-in devices and "sign out everywhere".
- Course access as time-limited grants (`invite`, `manual`, `comp`; `sepay` and `whop` reserved for checkout) checked by one gate, `canAccess`. Progress is kept when access ends.
- Per-course invitations, reissue and revocation. Accepting an invitation grants the course to the invited email's account; it signs in only accounts that never verified their email (otherwise the student signs in by code).
- Workspace roles: owner, instructor and assistant, scoped to courses, with an audit log of every privileged action and typed confirmation for high-impact ones.
- Transactional email (sign-in code, invitation, access granted, ending and ended) through the site's EmDash email provider, with an outbox and retries.
- Responsive student classroom with lesson navigation and persistent completion.
- Private text or HTTPS-link assignments, instructor feedback, revision requests and acceptance.
- Lesson video per lesson from **DoveRunner Multi-DRM** (protected) or **Wistia** (enrolled students only, not DRM), with playback granted per session, a screen limit, a site-wide pause switch and a playback ledger.
- Standalone Node/SQLite host and a Cloudflare Workers/D1/R2 build target.

## Run locally

Requires Node `^24.15.0 || >=26.0.0` and npm. From this directory:

```sh
npm --prefix plugins/mytutor-lms ci
npm --prefix plugins/mytutor-lms run build
npm --prefix themes/mytutor ci
npm --prefix themes/mytutor run secrets:generate
npm --prefix themes/mytutor run build
npm --prefix themes/mytutor run preview
```

**Open `http://localhost:4321/`**, not the IP address, for administrator passkeys. `npm run preview` sets a local canonical origin. Skip secret generation if `.env` already exists; never replace a key protecting existing data.

1. Visit `http://localhost:4321/_emdash/admin/` and complete setup with your own administrator identity and passkey.
2. Open **MyTutor workspace → New course**.
3. Add your title, instructor name, summary and lessons. Put each assignment's instructions in its lesson notes. Save a draft first.
4. Choose **Published**, then **Publish course**. Review the public curriculum.
5. Open **Students & invitations**, enter a student's name/email, and create a private invitation.
6. Copy the link and send it privately. Nothing is emailed automatically.
7. Repeat for your 20 students. The roster shows their saved lesson completion.

The fresh installation contains **no invented course or student content**. Add your actual teaching material before inviting students. Development uses `npm --prefix themes/mytutor run dev`; Astro 7 can daemonize it, so stop it with `npm --prefix themes/mytutor exec -- astro dev stop` before previewing a build on the same port.

## Assignments and feedback

1. A student opens a lesson, finds **Your assignment**, chooses **Text** or **Link**, and selects **Submit privately**.
2. In **MyTutor workspace**, choose the course's **Assignments** button and select a student's work.
3. Write feedback, then choose **Needs revision** or **Accepted**. Revision requests require feedback.
4. Students select **Check for feedback**, review any newer saved version, and revise/resubmit when needed.

Each enrollment has one current submission per lesson. Text and feedback allow 4,000 characters; links must be HTTPS and at most 2,048 characters. A new attempt replaces the previous work and feedback—there is no stored attempt history. Accepted work is read-only until an instructor requests revision. Assignment acceptance does **not** mark a lesson complete.

Unsent drafts are kept only in the current tab, with navigation warnings and enrollment/lesson separation. Copy or submit important work before closing the tab; drafts are not autosaved. There are no uploads or automatic feedback emails.

### Lesson video

1. In **EmDash → Plugins → mytutor-lms → Settings**, add your DoveRunner site ID, site key and access key and/or allow Wistia playback. Keep both off until a real device test passes.
2. Package each DoveRunner video as DASH and HLS with one content ID (outside the site), or upload it to Wistia and set it private with domain restrictions for your site.
3. In **MyTutor workspace → Lesson videos**, add the video to a lesson, play it on a real phone and computer, **Mark verified**, then **Publish to students**.

Wistia videos are not copy-protected: anyone given the media ID can play them. Use DoveRunner for paid lessons. See the [plugin README](plugins/mytutor-lms/README.md#lesson-video-doverunner-or-wistia) for states, limits and what is not yet implemented.

### Open courses, resources and live sessions (0.4.0)

- **Open a course for free:** in the course editor tick **Open for free to every signed-in student** (Mở miễn phí cho mọi học viên đã đăng nhập), type `OPEN` and give a reason, then publish. The course page shows **Đăng nhập để học miễn phí** (sign in and come back to the course) or, when signed in, **Bắt đầu học**; signed-in students also find it on their dashboard. Starting gives free, open-ended access, recorded as a complimentary grant you can revoke under **Students**. Invite-only and draft courses can never be started this way. With self sign-up off, only existing student accounts can sign in.
- **More lesson resources:** under each lesson, **Add resource** adds up to 10 labelled HTTPS links after the original resource. Students see **Tải về** (Download) for files such as .pdf, .zip or .dmg and **Mở** (Open) for web pages.
- **Live sessions:** the course's **Live sessions** button schedules Zoom classes (title, start, duration, link, optional passcode and notes). Students with access see them in the classroom in their own time zone, with **Vào Zoom** from 15 minutes before the start until the end, the passcode, **Thêm vào Google Calendar** and an .ics download. The public course page lists upcoming titles and times only. Sessions disappear for students two hours after they end.
- **Lesson notes** keep their paragraphs and turn bare `https://` addresses into links that open in a new tab. Notes stay plain text.

### Upgrading to 0.4.0

Additive: back up, then deploy the matched 0.4.0 pair; EmDash provisions two new collections and no existing record is rewritten. Rolling back to the 0.3.0 pair is safe: open courses become invite-only (students who already started keep access), and extra resources and live sessions are hidden but kept for the next upgrade. See the [plugin README](plugins/mytutor-lms/README.md#lifecycle-and-recovery).

### Upgrading to 0.3.0 (student accounts)

0.3.0 writes account-linked (version 2) enrollments, so every site must run **0.2.2 first**: 0.2.2 reads them and is the rollback target. Then:

1. Back up and verify (`ops/runbooks/backup-restore.md`). Never regenerate `EMDASH_ENCRYPTION_KEY`.
2. Configure an email provider for the site (Cloudflare Email Service binding, or an EmDash email provider plugin on Node) and use **Site and records → Settings → Send test**. Without a provider, sign-in codes cannot be delivered.
3. Deploy the matched 0.3.0 theme and plugin pair; `/api/health` must report `versionsMatch: true`.
4. Existing invitation sessions keep working until they expire. Students are offered "Keep your progress on any device", and an account that signs in with the invited email gets its course automatically.
5. When ready, run **Site and records → Account upgrade**: dry run first, then upgrade. It is resumable and has a revert escape hatch.

Owners are EmDash administrators. Add instructors and assistants by inviting them as EmDash users (Contributor or higher), then choosing their role and courses under **Team**. Passkeys for students stay off until the passkey gate (real-device WebAuthn tests) passes.

### Upgrading to 0.2.2

Reader-only release: it reads version 2 enrollments and keeps their account link. Deploy it to every site before 0.3.0.

### Upgrading from 0.2.0

Back up the database/media/key. Update both packages to 0.2.1 and rebuild without regenerating secrets. EmDash provisions the new video collections; nothing plays until a provider is enabled. Roll back only as a matched pair, after adding notes to every published lesson that relies on lesson video alone (0.2.0 cannot read such a course, which breaks its whole course list).

### Upgrading from 0.1.0

Back up the database/media/key and stop the host. Update **both** packages to 0.2.0, keep your existing `.env` and data directories, then run the install/build commands above without regenerating secrets. EmDash provisions the additional `submissions` collection; existing courses, invitations and progress require no backfill. Refresh old classroom tabs after upgrading: writes now carry a nonsecret enrollment precondition to prevent another tab's invitation from silently changing the recipient of submitted work. Rollback must use a matched theme/plugin pair; it does not erase retained assignments.


## Deliverables

| Path | Purpose |
| --- | --- |
| [`themes/mytutor`](themes/mytutor/README.md) | Standalone Astro theme, Node and Cloudflare hosts, installation details |
| [`plugins/mytutor-lms`](plugins/mytutor-lms/README.md) | Native plugin, domain storage, instructor UI, security/lifecycle details |

## Before teaching real students

- Obtain ZeroHostCMS maintainer evaluation/promotion for the exact source/package revision. A community theme/plugin is **not automatically a supported gallery installation**.
- Set the canonical HTTPS origin and private `EMDASH_ENCRYPTION_KEY` before production administrator setup. Do not deploy the development server.
- Publish your real course and check every lesson, video and resource on a phone.
- Back up the database, media and encryption key; perform a recovery rehearsal before taking student data.
- Test one real private invitation end-to-end, then send the remaining invitations.

Invitations grant one course and one current browser session per enrollment. Returning students use **My learning** in the same browser. After sign-out, expiry, browser-data clearing or a device change, reissue their invitation; existing progress is retained. Opening an invitation for another course replaces the current browser's course session. Not yet included: payments and checkout (0.4), drip release and localization (0.5), quizzes and certificates (0.6), the AI tutor (0.7), forensic watermarking and video transcoding.

## Verification commands

```sh
npm --prefix plugins/mytutor-lms run typecheck
npm --prefix plugins/mytutor-lms test
npm --prefix plugins/mytutor-lms run build
npm --prefix themes/mytutor run typecheck
npm --prefix themes/mytutor run build
npm --prefix themes/mytutor run cloudflare:build
```

Production deployment, domain and DNS changes, real student onboarding and ZeroHostCMS gallery publication are outside what this repository verifies.

## Provenance

Original implementation against the public [community theme contract](https://github.com/ZeroHostCMS/zhst-community-themes/blob/main/CONTRIBUTING.md), [community plugin contract](https://github.com/ZeroHostCMS/zhst-community-plugins/blob/main/CONTRIBUTING.md), and [EmDash native plugin API](https://docs.emdashcms.com/plugins/creating-native-plugins/your-first-native-plugin/). No private ZeroHostCMS code, credentials, or customer exports are included. Each package includes an MIT license; dependency licenses remain their own.

## Contributing

Issues and pull requests are welcome. Read the [contributing guide](../../CONTRIBUTING.md) first; the checks
for this project are the commands under [Verification commands](#verification-commands).

## License

[MIT](LICENSE)
