import assert from "node:assert/strict";
import test from "node:test";
import type {
  Course,
  DrmPlaybackGrant,
  MediaAssetInput,
  Result,
  WistiaPlaybackGrant,
} from "../src/model.js";
import { MediaCatalog } from "../src/media/catalog.js";
import {
  encryptPolicy,
  mintLicenseToken,
  tokenTimestamp,
} from "../src/media/doverunner.js";
import {
  PlaybackService,
  playbackSchema,
  type MediaSettings,
} from "../src/media/playback.js";
import { LmsService, result } from "../src/service.js";
import { parseInput } from "../src/validation.js";
import { MemoryCollection } from "./support/memory-collection.js";

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const credentials = {
  siteId: "TUTO",
  siteKey: "lU5D8s3PWoLls3PWFWkClULlFWk5D8oC",
  accessKey: "LT2FVJDp2Xr018zf4Di6lzvNOv3DKP20",
};

function data<T>(value: Result<T>): T {
  assert.equal(value.ok, true, JSON.stringify(value));
  return (value as { ok: true; data: T }).data;
}
async function fails(promise: Promise<unknown>, code: string) {
  const outcome = await result(async () => promise);
  assert.equal(outcome.ok, false, JSON.stringify(outcome));
  if (!outcome.ok) assert.equal(outcome.error.code, code);
  return outcome;
}
function decode(token: string) {
  return JSON.parse(atob(token)) as Record<string, string>;
}
function course(): Course {
  return {
    title: "A real course",
    summary: "Summary.",
    description: "",
    instructor: "Instructor",
    status: "published",
    lessons: ["one", "two"].map((id) => ({
      id,
      title: `Lesson ${id}`,
      module: "Foundations",
      durationMinutes: 10,
      body: `Notes ${id}`,
      videoUrl: "",
      resourceUrl: "",
      resourceLabel: "",
    })),
  };
}
const drmInput = (lessonId = "one"): MediaAssetInput => ({
  courseId: "course",
  lessonId,
  locale: "vi",
  role: "original",
  provider: "doverunner",
  contentId: `lesson-${lessonId}`,
  dashUrl: `https://cdn.example.com/${lessonId}/stream.mpd`,
  hlsUrl: `https://cdn.example.com/${lessonId}/master.m3u8`,
  wistiaMediaHashedId: "prod123abc",
  durationSeconds: 600,
});
const wistiaInput = (lessonId = "two"): MediaAssetInput => ({
  courseId: "course",
  lessonId,
  locale: "vi",
  role: "original",
  provider: "wistia",
  contentId: "",
  dashUrl: "",
  hlsUrl: "",
  wistiaMediaHashedId: "abc123xyz9",
  durationSeconds: 300,
});

async function setup(overrides: Partial<MediaSettings> = {}) {
  let time = Date.parse("2026-10-21T08:00:00Z");
  const now = () => time;
  const storage = {
    courses: new MemoryCollection(),
    enrollments: new MemoryCollection(),
    progress: new MemoryCollection(),
    submissions: new MemoryCollection(),
    courseOptions: new MemoryCollection(),
  };
  const media = {
    mediaAssets: new MemoryCollection(),
    mediaRouteState: new MemoryCollection(),
    mediaLive: new MemoryCollection(),
  };
  const sessions = new MemoryCollection();
  const slots = new MemoryCollection();
  const settings: MediaSettings = {
    enabled: { doverunner: true, wistia: true },
    doverunner: credentials,
    concurrentStreamLimit: false,
    deviceLimit: 1,
    licenseWindowMinutes: 240,
    studentRefKey: "local-test-reference-key",
    ...overrides,
  };
  const late = {} as { catalog: MediaCatalog };
  const lms = new LmsService(storage, now, (courseId, ids) =>
    late.catalog.playableLessons(courseId, ids, settings.enabled),
  );
  const catalog = (late.catalog = new MediaCatalog(
    media,
    (id) => lms.lessonContent(id),
    now,
  ));
  const playback = new PlaybackService(
    { playbackSessions: sessions, playbackSlots: slots },
    catalog,
    lms,
    settings,
    now,
  );
  data(await lms.saveCourse({ id: "course", revision: null, value: course() }));
  async function student(email: string) {
    const invitation = data(
      await lms.invite({ courseId: "course", name: "Student", email }),
    );
    return data(await lms.exchange({ token: invitation.token }));
  }
  async function publish(id: string, input: MediaAssetInput) {
    const saved = await catalog.save(
      { id, revision: null, value: input },
      "site.example",
    );
    const verified = await catalog.transition({
      mediaAssetId: id,
      revision: saved.revision,
      to: "verified",
      note: "Played on iPhone Safari",
    });
    return catalog.transition({
      mediaAssetId: id,
      revision: verified.revision,
      to: "published",
      note: "",
    });
  }
  const request = (
    lessonId: string,
    drm: "widevine" | "playready" | "fairplay" | null,
    replaceSessionId: string | null = null,
  ) =>
    parseInput(playbackSchema, {
      courseId: "course",
      lessonId,
      locale: "vi",
      drm,
      deviceLabel: "Chrome on Mac",
      replaceSessionId,
    });
  return {
    lms,
    catalog,
    playback,
    settings,
    sessions,
    slots,
    media,
    student,
    publish,
    request,
    advance: (ms: number) => {
      time += ms;
    },
  };
}
const ASSET_A = "a".repeat(32);
const ASSET_B = "b".repeat(32);

test("license token matches DoveRunner's published test vector", async () => {
  const policy = JSON.stringify({
    policy_version: 2,
    playback_policy: { persistent: false },
  });
  assert.equal(
    await encryptPolicy(policy, credentials.siteKey),
    "sX7DEMZ1S2xaMoIt76m+yDwylZRVJ2Gzs2I1b0+mzL0X9FcJ43aAloqI5noG2iyC57AagPl2jY9mxCL/WqNabQ==",
  );
  const now = Date.parse("2021-11-11T07:28:41.123Z");
  assert.equal(tokenTimestamp(now), "2021-11-11T07:28:41Z");
  const token = decode(
    await mintLicenseToken({
      credentials,
      drm: "widevine",
      userId: "test-user",
      contentId: "bigbuckbunny",
      policy: JSON.parse(policy),
      now,
    }),
  );
  assert.deepEqual(token, {
    drm_type: "Widevine",
    site_id: "TUTO",
    user_id: "test-user",
    cid: "bigbuckbunny",
    policy:
      "sX7DEMZ1S2xaMoIt76m+yDwylZRVJ2Gzs2I1b0+mzL0X9FcJ43aAloqI5noG2iyC57AagPl2jY9mxCL/WqNabQ==",
    timestamp: "2021-11-11T07:28:41Z",
    hash: "o6dD1qJbdrQvU86JUxZiKf8WBo0BH6oc+kN8CVNk2rM=",
  });
});

test("assets validate per provider and publish only after a device check", async () => {
  const { catalog } = await setup();
  // Schema-level checks happen in route parsing.
  const { saveMediaAssetSchema } = await import("../src/media/catalog.js");
  for (const value of [
    { ...drmInput(), contentId: "has spaces" },
    { ...drmInput(), dashUrl: "", hlsUrl: "" },
    { ...drmInput(), dashUrl: "http://cdn.example.com/a.mpd" },
    { ...wistiaInput(), wistiaMediaHashedId: "" },
    { ...wistiaInput(), dashUrl: "https://cdn.example.com/a.mpd" },
    { ...wistiaInput(), wistiaMediaHashedId: "<script>" },
  ])
    assert.equal(
      saveMediaAssetSchema.safeParse({ id: ASSET_A, revision: null, value })
        .success,
      false,
      JSON.stringify(value),
    );
  await fails(
    catalog.save(
      { id: ASSET_A, revision: null, value: drmInput("missing") },
      "site",
    ),
    "NOT_FOUND",
  );
  const saved = await catalog.save(
    { id: ASSET_A, revision: null, value: drmInput() },
    "site",
  );
  assert.equal(saved.state, "draft");
  assert.equal(saved.wistia?.mediaHashedId, "prod123abc");
  await fails(
    catalog.transition({
      mediaAssetId: ASSET_A,
      revision: saved.revision,
      to: "published",
      note: "",
    }),
    "NOT_READY",
  );
  const verified = await catalog.transition({
    mediaAssetId: ASSET_A,
    revision: saved.revision,
    to: "verified",
    note: "",
  });
  assert.ok(verified.routes.primary.smokeTestedAt);
  // Editing after verification requires a new device check.
  const edited = await catalog.save(
    { id: ASSET_A, revision: verified.revision, value: drmInput() },
    "site",
  );
  assert.equal(edited.state, "draft");
  assert.equal(edited.routes.primary.smokeTestedAt, null);
  await fails(
    catalog.save(
      { id: ASSET_A, revision: verified.revision, value: drmInput() },
      "site",
    ),
    "CONFLICT",
  );
});

test("publishing replaces the live video and locks it against edits", async () => {
  const { catalog, publish } = await setup();
  const first = await publish(ASSET_A, drmInput());
  await fails(
    catalog.save(
      { id: ASSET_A, revision: first.revision, value: drmInput() },
      "site",
    ),
    "PUBLISHED_LOCKED",
  );
  const second = await publish(ASSET_B, { ...wistiaInput("one") });
  assert.equal(second.mediaRevision, 2);
  const assets = await catalog.assets("course");
  assert.deepEqual(
    assets.map((asset) => [asset.id, asset.state]),
    [
      [ASSET_B, "published"],
      [ASSET_A, "retired"],
    ],
  );
});

test("playback requires a valid enrolled session for the lesson's course", async () => {
  const { playback, publish, request, student, lms } = await setup();
  await publish(ASSET_A, drmInput());
  await fails(
    playback.issue(request("one", "widevine"), undefined, "site"),
    "ACCESS_DENIED",
  );
  await fails(
    playback.issue(
      request("one", "widevine"),
      "f".repeat(64) + "." + "0".repeat(64),
      "site",
    ),
    "ACCESS_DENIED",
  );
  const session = await student("a@example.com");
  await fails(
    playback.issue(
      { ...request("one", "widevine"), courseId: "other" },
      session.sessionToken,
      "site",
    ),
    "ACCESS_DENIED",
  );
  await fails(
    playback.issue(
      { ...request("nope", "widevine") },
      session.sessionToken,
      "site",
    ),
    "NOT_FOUND",
  );
  data(
    await lms.saveCourse({
      id: "course",
      revision: (await lms.courses({})).ok
        ? data(await lms.courses({}))[0]!.revision
        : null,
      value: { ...course(), status: "draft" },
    }),
  );
  await fails(
    playback.issue(request("one", "widevine"), session.sessionToken, "site"),
    "ACCESS_DENIED",
  );
});

test("DoveRunner grants carry a per-DRM token for an opaque learner and the matching manifest", async () => {
  const { playback, publish, request, student } = await setup();
  await publish(ASSET_A, drmInput());
  const session = await student("Learner@Example.com");
  const widevine = (await playback.issue(
    request("one", "widevine"),
    session.sessionToken,
    "site",
  )) as DrmPlaybackGrant;
  assert.equal(widevine.provider, "doverunner");
  assert.equal(widevine.manifestUrl, "https://cdn.example.com/one/stream.mpd");
  assert.equal(widevine.licenseHeader, "pallycon-customdata-v2");
  const token = decode(widevine.drm.widevine!.token);
  assert.equal(token.drm_type, "Widevine");
  assert.equal(token.cid, "lesson-one");
  assert.equal(token.site_id, "TUTO");
  assert.match(token.user_id!, /^[a-f0-9]{32}$/);
  const serialized = JSON.stringify(widevine);
  assert.ok(!serialized.toLowerCase().includes("learner@example.com"));
  assert.ok(!serialized.includes(credentials.siteKey));
  assert.ok(!serialized.includes(credentials.accessKey));
  assert.ok(
    !serialized.includes("prod123abc"),
    "Wistia production IDs stay private",
  );

  const fairplay = (await playback.issue(
    request("one", "fairplay", widevine.sessionId),
    session.sessionToken,
    "site",
  )) as DrmPlaybackGrant;
  assert.equal(fairplay.manifestUrl, "https://cdn.example.com/one/master.m3u8");
  assert.match(fairplay.drm.fairplay!.certificateUrl!, /siteId=TUTO$/);
  assert.equal(decode(fairplay.drm.fairplay!.token).drm_type, "FairPlay");
});

test("missing DRM support or manifest is refused without an unprotected fallback", async () => {
  const { playback, publish, request, student } = await setup();
  await publish(ASSET_A, { ...drmInput(), hlsUrl: "" });
  const session = await student("a@example.com");
  await fails(
    playback.issue(request("one", "fairplay"), session.sessionToken, "site"),
    "UNSUPPORTED_DEVICE",
  );
  await fails(
    playback.issue(request("one", null), session.sessionToken, "site"),
    "UNSUPPORTED_DEVICE",
  );
});

test("Wistia grants expose only the media ID and only when Wistia playback is allowed", async () => {
  const allowed = await setup();
  await allowed.publish(ASSET_A, wistiaInput());
  const session = await allowed.student("a@example.com");
  const grant = (await allowed.playback.issue(
    allowed.request("two", null),
    session.sessionToken,
    "site",
  )) as WistiaPlaybackGrant;
  assert.deepEqual(Object.keys(grant).sort(), [
    "audioLocales",
    "expiresAt",
    "mediaHashedId",
    "provider",
    "sessionId",
    "visibleMark",
  ]);
  assert.equal(grant.mediaHashedId, "abc123xyz9");
  const library = data(await allowed.lms.library({}, session.sessionToken));
  assert.deepEqual(library.videoLessonIds, ["two"]);
  assert.ok(!JSON.stringify(library).includes("abc123xyz9"));

  const off = await setup({ enabled: { doverunner: true, wistia: false } });
  await off.publish(ASSET_A, wistiaInput());
  const other = await off.student("b@example.com");
  await fails(
    off.playback.issue(off.request("two", null), other.sessionToken, "site"),
    "MEDIA_NOT_READY",
  );
  assert.deepEqual(
    data(await off.lms.library({}, other.sessionToken)).videoLessonIds,
    [],
  );
});

test("screen limit blocks a second screen until the learner replaces it", async () => {
  const { playback, publish, request, student } = await setup();
  await publish(ASSET_A, drmInput());
  await publish(ASSET_B, wistiaInput());
  const session = await student("a@example.com");
  const first = await playback.issue(
    request("one", "widevine"),
    session.sessionToken,
    "site",
  );
  const blocked = await fails(
    playback.issue(request("one", "widevine"), session.sessionToken, "site"),
    "DEVICE_LIMIT",
  );
  assert.ok(!blocked.ok);
  if (!blocked.ok)
    assert.deepEqual(
      blocked.error.details?.sessions?.map((item) => [
        item.id,
        item.deviceLabel,
      ]),
      [[first.sessionId, "Chrome on Mac"]],
    );
  // Moving to another lesson in the same tab replaces its own session.
  const second = await playback.issue(
    request("two", null, first.sessionId),
    session.sessionToken,
    "site",
  );
  await fails(
    playback.issue(request("one", "widevine"), session.sessionToken, "site"),
    "DEVICE_LIMIT",
  );
  // Ending the session frees the screen; another learner cannot end it.
  const stranger = await student("b@example.com");
  await fails(
    playback.endPlayback(
      { sessionId: second.sessionId },
      stranger.sessionToken,
    ),
    "ACCESS_DENIED",
  );
  assert.deepEqual(
    await playback.endPlayback(
      { sessionId: second.sessionId },
      session.sessionToken,
    ),
    { ended: true },
  );
  await playback.issue(
    request("one", "widevine"),
    session.sessionToken,
    "site",
  );
});

test("sessions expire with the playback window and never outlive access", async () => {
  const { playback, publish, request, student, advance } = await setup({
    licenseWindowMinutes: 60,
  });
  await publish(ASSET_A, drmInput());
  const session = await student("a@example.com");
  const grant = (await playback.issue(
    request("one", "widevine"),
    session.sessionToken,
    "site",
  )) as DrmPlaybackGrant;
  assert.equal(
    Date.parse(grant.expiresAt) - Date.parse("2026-10-21T08:00:00Z"),
    60 * MINUTE,
  );
  const policy = decode(grant.drm.widevine!.token).policy!;
  assert.ok(policy.length > 0);
  advance(61 * MINUTE);
  // The expired session no longer counts toward the screen limit.
  await playback.issue(
    request("one", "widevine"),
    session.sessionToken,
    "site",
  );
});

test("the playback window is capped by the learner's remaining access", async () => {
  const { playback, publish, request, student, advance } = await setup();
  await publish(ASSET_A, drmInput());
  const session = await student("a@example.com");
  advance(30 * DAY - 30 * MINUTE);
  const grant = await playback.issue(
    request("one", "widevine"),
    session.sessionToken,
    "site",
  );
  assert.equal(grant.expiresAt, session.expiresAt);
});

test("paused delivery, disabled DRM and revocation stop new playback", async () => {
  const { playback, publish, request, student, catalog, lms, sessions } =
    await setup();
  await publish(ASSET_A, drmInput());
  const session = await student("a@example.com");
  await catalog.setRoute({ to: "paused", reason: "Vendor incident" });
  await fails(
    playback.issue(request("one", "widevine"), session.sessionToken, "site"),
    "VIDEO_PAUSED",
  );
  await fails(
    catalog.setRoute({ to: "backup", reason: "Try backup" }),
    "BACKUP_NOT_READY",
  );
  await catalog.setRoute({ to: "primary", reason: "Resolved" });
  const grant = await playback.issue(
    request("one", "widevine"),
    session.sessionToken,
    "site",
  );

  const students = data(await lms.students({ courseId: "course" }));
  data(await lms.revoke({ id: students[0]!.id }));
  await playback.endForEnrollment(students[0]!.id);
  const ended = await sessions.getVersioned(grant.sessionId);
  assert.equal((ended?.value as { endReason: string }).endReason, "revoked");
  await fails(
    playback.issue(request("one", "widevine"), session.sessionToken, "site"),
    "ACCESS_DENIED",
  );

  const off = await setup({ enabled: { doverunner: false, wistia: true } });
  await off.publish(ASSET_A, drmInput());
  const other = await off.student("b@example.com");
  await fails(
    off.playback.issue(
      off.request("one", "widevine"),
      other.sessionToken,
      "site",
    ),
    "MEDIA_NOT_READY",
  );
});

test("revocation during issuance ends the new session and denies the grant", async () => {
  const fixture = await setup();
  await fixture.publish(ASSET_A, drmInput());
  const session = await fixture.student("a@example.com");
  const id = data(await fixture.lms.students({ courseId: "course" }))[0]!.id;
  fixture.sessions.beforePut = async () => {
    fixture.sessions.beforePut = undefined;
    data(await fixture.lms.revoke({ id }));
  };
  await fails(
    fixture.playback.issue(
      fixture.request("one", "widevine"),
      session.sessionToken,
      "site",
    ),
    "ACCESS_DENIED",
  );
  const rows = [...fixture.sessions.rows.values()].map(
    (row) => row.value as { endReason: string | null },
  );
  assert.deepEqual(
    rows.map((row) => row.endReason),
    ["revoked"],
  );
});

test("a published course may rely on lesson video instead of notes", async () => {
  const { lms, publish } = await setup();
  const bare = {
    ...course(),
    lessons: course().lessons.map((lesson) => ({ ...lesson, body: "" })),
  };
  const current = data(await lms.courses({}))[0]!;
  const rejected = await lms.saveCourse({
    id: "course",
    revision: current.revision,
    value: bare,
  });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.error.code, "VALIDATION");
  await publish(ASSET_A, drmInput("one"));
  await publish(ASSET_B, wistiaInput("two"));
  data(
    await lms.saveCourse({
      id: "course",
      revision: current.revision,
      value: bare,
    }),
  );
});

async function policyOf(token: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(credentials.siteKey),
    { name: "AES-CBC" },
    false,
    ["decrypt"],
  );
  const cipher = Uint8Array.from(atob(decode(token).policy!), (c) =>
    c.charCodeAt(0),
  );
  return JSON.parse(
    new TextDecoder().decode(
      await crypto.subtle.decrypt(
        { name: "AES-CBC", iv: new TextEncoder().encode("0123456789abcdef") },
        key,
        cipher,
      ),
    ),
  );
}
const ASSET_C = "c".repeat(32);

test("licenses end before the session does and can carry DoveRunner's stream limit", async () => {
  const plain = await setup({ licenseWindowMinutes: 60 });
  await plain.publish(ASSET_A, drmInput());
  const a = await plain.student("a@example.com");
  const grant = (await plain.playback.issue(
    plain.request("one", "widevine"),
    a.sessionToken,
    "site",
  )) as DrmPlaybackGrant;
  assert.deepEqual(await policyOf(grant.drm.widevine!.token), {
    policy_version: 2,
    playback_policy: { persistent: false, license_duration: 3600 - 600 },
  });
  const limited = await setup({ concurrentStreamLimit: true, deviceLimit: 2 });
  await limited.publish(ASSET_A, drmInput());
  const b = await limited.student("b@example.com");
  const capped = (await limited.playback.issue(
    limited.request("one", "widevine"),
    b.sessionToken,
    "site",
  )) as DrmPlaybackGrant;
  assert.equal(
    (await policyOf(capped.drm.widevine!.token)).playback_policy
      .max_stream_per_user,
    2,
  );
});

test("the learner reference is a keyed hash, stable per site and different across sites", async () => {
  const first = await setup();
  await first.publish(ASSET_A, drmInput());
  const session = await first.student("a@example.com");
  const firstGrant = (await first.playback.issue(
    first.request("one", "widevine"),
    session.sessionToken,
    "site",
  )) as DrmPlaybackGrant;
  const one = decode(firstGrant.drm.widevine!.token).user_id;
  const secondGrant = (await first.playback.issue(
    first.request("one", "widevine", firstGrant.sessionId),
    session.sessionToken,
    "site",
  )) as DrmPlaybackGrant;
  const again = decode(secondGrant.drm.widevine!.token).user_id;
  assert.match(one!, /^[a-f0-9]{32}$/);
  assert.equal(one, again);
  const other = await setup({ studentRefKey: "another-site-key" });
  await other.publish(ASSET_A, drmInput());
  const elsewhere = await other.student("a@example.com");
  const there = decode(
    (
      (await other.playback.issue(
        other.request("one", "widevine"),
        elsewhere.sessionToken,
        "site",
      )) as DrmPlaybackGrant
    ).drm.widevine!.token,
  ).user_id;
  assert.notEqual(one, there);
});

test("parallel playback starts cannot exceed the screen limit", async () => {
  const { playback, publish, request, student, slots } = await setup();
  await publish(ASSET_A, drmInput());
  const session = await student("a@example.com");
  let arrived = 0;
  let release!: () => void;
  const both = new Promise<void>((resolve) => (release = resolve));
  slots.beforeCas = async () => {
    if (++arrived === 2) release();
    if (arrived <= 2) await both;
  };
  const outcomes = await Promise.all([
    result(() =>
      playback.issue(request("one", "widevine"), session.sessionToken, "site"),
    ),
    result(() =>
      playback.issue(request("one", "widevine"), session.sessionToken, "site"),
    ),
  ]);
  assert.deepEqual(
    outcomes.map((outcome) => (outcome.ok ? "ok" : outcome.error.code)).sort(),
    ["DEVICE_LIMIT", "ok"],
  );
});

test("parallel publishes leave exactly one live video, and mixed providers never both play", async () => {
  const { catalog, playback, publish, request, student, settings } =
    await setup();
  await publish(ASSET_A, drmInput());
  const verified = async (id: string, input: MediaAssetInput) => {
    const saved = await catalog.save(
      { id, revision: null, value: input },
      "site",
    );
    return catalog.transition({
      mediaAssetId: id,
      revision: saved.revision,
      to: "verified",
      note: "",
    });
  };
  const b = await verified(ASSET_B, { ...wistiaInput("one"), role: "dub" });
  const c = await verified(ASSET_C, {
    ...drmInput(),
    contentId: "lesson-one-v2",
  });
  await Promise.all([
    result(() =>
      catalog.transition({
        mediaAssetId: ASSET_B,
        revision: b.revision,
        to: "published",
        note: "",
      }),
    ),
    result(() =>
      catalog.transition({
        mediaAssetId: ASSET_C,
        revision: c.revision,
        to: "published",
        note: "",
      }),
    ),
  ]);
  const live = await catalog.select("course", "one", "vi", settings.enabled);
  assert.ok(live);
  const published = (await catalog.assets("course")).filter(
    (asset) => asset.state === "published",
  );
  assert.deepEqual(
    published.map((asset) => asset.id),
    [live!.id],
  );
  const session = await student("a@example.com");
  const grant = await playback.issue(
    request("one", live!.value.provider === "wistia" ? null : "widevine"),
    session.sessionToken,
    "site",
  );
  assert.equal(grant.provider, live!.value.provider);
});

test("malformed video rows are skipped instead of breaking the classroom", async () => {
  const { publish, student, lms, media } = await setup();
  await publish(ASSET_A, drmInput());
  await publish(ASSET_B, wistiaInput());
  await media.mediaAssets.put(ASSET_A, { schemaVersion: 99, broken: true });
  const session = await student("a@example.com");
  const state = data(await lms.library({}, session.sessionToken));
  assert.deepEqual(state.videoLessonIds, ["two"]);
});

test("the last live video of a lesson without notes cannot be retired", async () => {
  const { catalog, publish, lms } = await setup();
  const live = await publish(ASSET_A, drmInput());
  const current = data(await lms.courses({}))[0]!;
  const bare = {
    ...course(),
    lessons: course().lessons.map((lesson) =>
      lesson.id === "one" ? { ...lesson, body: "" } : lesson,
    ),
  };
  data(
    await lms.saveCourse({
      id: "course",
      revision: current.revision,
      value: bare,
    }),
  );
  await fails(
    catalog.transition({
      mediaAssetId: ASSET_A,
      revision: live.revision,
      to: "retired",
      note: "",
    }),
    "NOT_READY",
  );
  const replacement = await publish(ASSET_B, {
    ...drmInput(),
    contentId: "lesson-one-v2",
  });
  assert.equal(replacement.state, "published");
  assert.equal(
    (await catalog.assets("course")).find((asset) => asset.id === ASSET_A)
      ?.state,
    "retired",
  );
});
