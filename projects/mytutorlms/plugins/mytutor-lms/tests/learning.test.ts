import assert from "node:assert/strict";
import test from "node:test";
import type { Course, LearningState, Result } from "../src/model.js";
import { MediaCatalog } from "../src/media/catalog.js";
import { PlaybackService, playbackSchema } from "../src/media/playback.js";
import { AccountService, type SiteRules } from "../src/services/accounts.js";
import { AuditLog } from "../src/services/audit.js";
import { EntitlementService } from "../src/services/entitlements.js";
import { StudentLearning } from "../src/services/learning.js";
import { AccountMigration, integrity } from "../src/services/migration.js";
import { NotificationService } from "../src/services/notifications.js";
import { RateLimiter } from "../src/services/rate-limit.js";
import { key, result } from "../src/services/shared.js";
import { StudentDirectory } from "../src/services/students.js";
import { LmsService } from "../src/service.js";
import { parseInput } from "../src/validation.js";
import { MemoryCollection } from "./support/memory-collection.js";

const DAY = 24 * 60 * 60 * 1000;
const owner = { type: "owner" as const, id: "u-owner", label: "Owner" };
const origin = {
  binding: "a".repeat(64),
  clientHash: "",
  userAgent: "Mozilla/5.0 (Macintosh; Mac OS X) Chrome/140",
};
const site: SiteRules = {
  siteName: "Studio",
  verifyUrl: "https://studio.example/sign-in/verify",
  selfSignup: true,
  locales: ["vi", "en"],
  dailySignInEmailCap: 500,
};

function data<T>(value: Result<T>): T {
  assert.equal(value.ok, true, JSON.stringify(value));
  return (value as { ok: true; data: T }).data;
}
async function fails(promise: Promise<unknown>, code: string) {
  const outcome = await result(async () => promise);
  assert.equal(outcome.ok, false, JSON.stringify(outcome));
  if (!outcome.ok) assert.equal(outcome.error.code, code);
}
function course(id: string): Course {
  return {
    title: `Course ${id}`,
    summary: "Summary",
    description: "",
    instructor: "Teacher",
    status: "published",
    lessons: ["one", "two"].map((lesson) => ({
      id: lesson,
      title: lesson,
      module: "M",
      durationMinutes: 5,
      body: "Notes",
      videoUrl: "",
      resourceUrl: "",
      resourceLabel: "",
    })),
  };
}

async function setup() {
  let time = Date.parse("2026-10-22T03:00:00Z");
  const now = () => time;
  const c = () => new MemoryCollection();
  const storage = {
    courses: c(),
    enrollments: c(),
    progress: c(),
    submissions: c(),
    courseOptions: c(),
    students: c(),
    studentEmails: c(),
    studentSessions: c(),
    signInChallenges: c(),
    entitlements: c(),
    auditEvents: c(),
    notifications: c(),
    rateLimits: c(),
    mediaAssets: c(),
    mediaRouteState: c(),
    mediaLive: c(),
    playbackSessions: c(),
    playbackSlots: c(),
  };
  const sent: { to: string; text: string }[] = [];
  const audit = new AuditLog(storage.auditEvents, "studio", now);
  const students = new StudentDirectory(storage, now);
  const notifications = new NotificationService(
    storage.notifications,
    students,
    {
      send: async (message) => {
        sent.push(message);
      },
    },
    { locale: "vi", replyTo: "" },
    now,
  );
  const accounts = new AccountService(
    storage,
    students,
    notifications,
    new RateLimiter(storage.rateLimits, now),
    audit,
    now,
  );
  const entitlements = new EntitlementService(storage, students, audit, now);
  const late = {} as { learning: StudentLearning; catalog: MediaCatalog };
  const enabled = { doverunner: false, wistia: true };
  const lms = new LmsService(
    storage,
    now,
    (courseId, ids) => late.catalog.playableLessons(courseId, ids, enabled),
    {
      enrollment: (token, courseId) =>
        late.learning.enrollment(token, courseId),
      studentId: (token) => late.learning.studentId(token),
      allowed: (studentId, courseId) =>
        late.learning.allowed(studentId, courseId),
    },
  );
  const learning = (late.learning = new StudentLearning(
    accounts,
    students,
    entitlements,
    lms,
    audit,
    now,
  ));
  const catalog = (late.catalog = new MediaCatalog(
    storage,
    (id) => lms.lessonContent(id),
    now,
  ));
  const playback = new PlaybackService(
    storage,
    catalog,
    lms,
    {
      enabled,
      doverunner: null,
      concurrentStreamLimit: false,
      deviceLimit: 1,
      licenseWindowMinutes: 240,
      studentRefKey: "k",
    },
    now,
  );
  const migration = new AccountMigration(
    storage.enrollments,
    students,
    entitlements,
    audit,
    now,
  );
  for (const id of ["course", "other"])
    data(await lms.saveCourse({ id, revision: null, value: course(id) }));
  const signIn = async (email: string) => {
    await accounts.start({ email, locale: "vi" }, origin, site);
    return accounts.verifyCode(
      { email, code: /(\d{6})/.exec(sent.at(-1)!.text)![1]! },
      origin,
      "vi",
    );
  };
  return {
    storage,
    lms,
    accounts,
    entitlements,
    learning,
    playback,
    catalog,
    migration,
    students,
    signIn,
    sent,
    now,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

test("a student account studies each granted course with its own progress", async () => {
  const fx = await setup();
  const signed = await fx.signIn("learner@example.com");
  const credential = (courseId: string) => ({
    student: signed.sessionToken,
    courseId,
  });
  const before = await fx.lms.library({}, credential("course"));
  assert.equal(!before.ok && before.error.code, "ACCESS_ENDED");
  for (const courseId of ["course", "other"])
    await fx.entitlements.grant({
      studentId: signed.student.id,
      courseId,
      source: "manual",
      sourceRef: `g-${courseId}`,
      expiresAt: null,
      actor: owner,
    });
  data(
    await fx.lms.complete(
      { lessonId: "one", completed: true },
      credential("course"),
    ),
  );
  const submitted = data(
    await fx.lms.submit(
      { lessonId: "two", revision: null, kind: "text", content: "Work" },
      credential("course"),
    ),
  );
  assert.equal(submitted.submissions.length, 1);
  const other = data(await fx.lms.library({}, credential("other")));
  assert.deepEqual(other.completedLessonIds, []);
  const dashboard = await fx.learning.dashboard(signed.sessionToken);
  assert.deepEqual(
    dashboard.courses
      .map((item) => [
        item.courseId,
        item.completedCount,
        item.nextLessonId,
        item.access.status,
      ])
      .sort(),
    [
      ["course", 1, "two", "active"],
      ["other", 0, "one", "active"],
    ],
  );
  // A second student never sees the first one's courses or work.
  const stranger = await fx.signIn("stranger@example.com");
  assert.deepEqual(
    (await fx.learning.dashboard(stranger.sessionToken)).courses,
    [],
  );
  const stolen = await fx.lms.library(
    {},
    { student: stranger.sessionToken, courseId: "course" },
  );
  assert.equal(stolen.ok, false);
});

test("revoking access ends classroom and playback but keeps progress for the dashboard", async () => {
  const fx = await setup();
  const signed = await fx.signIn("learner@example.com");
  const { entitlement } = await fx.entitlements.grant({
    studentId: signed.student.id,
    courseId: "course",
    source: "whop",
    sourceRef: "o1",
    expiresAt: fx.now() + 30 * DAY,
    actor: owner,
  });
  const credential = { student: signed.sessionToken, courseId: "course" };
  data(await fx.lms.complete({ lessonId: "one", completed: true }, credential));
  const saved = await fx.catalog.save(
    {
      id: "a".repeat(32),
      revision: null,
      value: {
        courseId: "course",
        lessonId: "one",
        locale: "vi",
        role: "original",
        provider: "wistia",
        contentId: "",
        dashUrl: "",
        hlsUrl: "",
        wistiaMediaHashedId: "abc123xyz9",
        durationSeconds: 60,
      },
    },
    "site",
  );
  const verified = await fx.catalog.transition({
    mediaAssetId: saved.id,
    revision: saved.revision,
    to: "verified",
    note: "",
  });
  await fx.catalog.transition({
    mediaAssetId: saved.id,
    revision: verified.revision,
    to: "published",
    note: "",
  });
  const request = parseInput(playbackSchema, {
    courseId: "course",
    lessonId: "one",
    locale: "vi",
    drm: null,
    deviceLabel: "Mac",
    replaceSessionId: null,
  });
  const grant = await fx.playback.issue(request, credential, "site");
  // The playback window never outlives the entitlement.
  assert.ok(Date.parse(grant.expiresAt) <= fx.now() + 30 * DAY);
  assert.deepEqual(
    await fx.playback.endPlayback({ sessionId: grant.sessionId }, credential),
    { ended: true },
  );
  await fx.entitlements.revoke({
    entitlementId: entitlement.id,
    reason: "Refund",
    actor: owner,
  });
  const denied = await fx.lms.library({}, credential);
  assert.equal(!denied.ok && denied.error.code, "ACCESS_ENDED");
  await fails(fx.playback.issue(request, credential, "site"), "ACCESS_ENDED");
  const dashboard = await fx.learning.dashboard(signed.sessionToken);
  assert.deepEqual(
    dashboard.courses.map((item) => [item.completedCount, item.access.status]),
    [[1, "revoked"]],
  );
});

test("an invitation becomes a student account and keeps its 0.2 progress", async () => {
  const fx = await setup();
  const invitation = data(
    await fx.lms.invite({
      courseId: "course",
      name: "Learner",
      email: "learner@example.com",
    }),
  );
  const legacy = data(await fx.lms.exchange({ token: invitation.token }));
  data(
    await fx.lms.complete(
      { lessonId: "one", completed: true },
      legacy.sessionToken,
    ),
  );
  const reissued = data(
    await fx.lms.invite({
      courseId: "course",
      name: "Learner",
      email: "learner@example.com",
    }),
  );
  const signed = await fx.learning.exchangeInvitation(
    reissued.token,
    origin.userAgent,
    "vi",
  );
  assert.equal(signed.courseId, "course");
  // A never-verified account may sign in by invitation.
  assert.ok("sessionToken" in signed);
  await fails(
    fx.learning.exchangeInvitation(reissued.token, origin.userAgent, "vi"),
    "INVALID_INVITATION",
  );
  const state = data(
    await fx.lms.library(
      {},
      { student: signed.sessionToken, courseId: "course" },
    ),
  );
  assert.equal(state.enrollmentId, invitation.student.id);
  assert.deepEqual(state.completedLessonIds, ["one"]);
  // Signing in later by email reaches the same student and progress.
  const again = await fx.signIn("learner@example.com");
  assert.equal(again.student.id, signed.student.id);
});

test("a legacy invitation session upgrades to an account by email code", async () => {
  const fx = await setup();
  const invitation = data(
    await fx.lms.invite({
      courseId: "course",
      name: "Learner",
      email: "learner@example.com",
    }),
  );
  const legacy = data(await fx.lms.exchange({ token: invitation.token }));
  data(
    await fx.lms.complete(
      { lessonId: "two", completed: true },
      legacy.sessionToken,
    ),
  );
  const started = await fx.learning.startUpgrade(
    legacy.sessionToken,
    origin,
    site,
  );
  assert.equal(started.maskedEmail, "l***@example.com");
  const verified = await fx.accounts.verifyCode(
    {
      email: "learner@example.com",
      code: /(\d{6})/.exec(fx.sent.at(-1)!.text)![1]!,
    },
    origin,
    "vi",
  );
  assert.equal(verified.upgradeEnrollmentId, invitation.student.id);
  await fx.learning.completeUpgrade(
    verified.student.id,
    verified.upgradeEnrollmentId!,
  );
  const old = await fx.lms.library({}, legacy.sessionToken);
  assert.equal(old.ok, false);
  const state = data(
    await fx.lms.library(
      {},
      { student: verified.sessionToken, courseId: "course" },
    ),
  );
  assert.deepEqual(state.completedLessonIds, ["two"]);
});

test("account migration: dry run, idempotent run, revoked rows get no access, revert escape hatch", async () => {
  const fx = await setup();
  const a = data(
    await fx.lms.invite({
      courseId: "course",
      name: "A",
      email: "a@example.com",
    }),
  );
  const b = data(
    await fx.lms.invite({
      courseId: "other",
      name: "A",
      email: "a@example.com",
    }),
  );
  const c = data(
    await fx.lms.invite({
      courseId: "course",
      name: "C",
      email: "c@example.com",
    }),
  );
  data(await fx.lms.revoke({ id: c.student.id }));
  const backupConfirmedAt = new Date(fx.now() - 60_000).toISOString();
  await fails(
    fx.migration.run(
      {
        dryRun: true,
        backupConfirmedAt: new Date(fx.now() - 2 * DAY).toISOString(),
      },
      owner,
    ),
    "VALIDATION",
  );
  // The migration works one page per call and returns a cursor to resume from.
  const all = async (input: { dryRun: boolean; revertToV1?: boolean }) => {
    const total = {
      v1Enrollments: 0,
      distinctEmails: 0,
      studentsToCreate: 0,
      entitlementsToCreate: 0,
      migrated: 0,
      reverted: 0,
    };
    let cursor: string | undefined;
    do {
      const page = await fx.migration.run(
        { ...input, backupConfirmedAt, ...(cursor ? { cursor } : {}) },
        owner,
      );
      for (const name of Object.keys(total) as (keyof typeof total)[])
        total[name] += page.report[name];
      cursor = page.cursor ?? undefined;
    } while (cursor);
    return { report: total };
  };
  const dry = await all({ dryRun: true });
  assert.deepEqual(
    [
      dry.report.v1Enrollments,
      dry.report.entitlementsToCreate,
      dry.report.migrated,
    ],
    [3, 2, 0],
  );
  assert.ok(
    dry.report.studentsToCreate >= 2 && dry.report.studentsToCreate <= 3,
    "distinct per page",
  );
  assert.equal(
    (await integrity({ enrollments: fx.storage.enrollments })).v1Enrollments,
    3,
  );
  const run = await all({ dryRun: false });
  assert.equal(run.report.migrated, 3);
  const rerun = await all({ dryRun: false });
  assert.equal(rerun.report.migrated, 0);
  assert.equal(
    (await integrity({ enrollments: fx.storage.enrollments })).v1Enrollments,
    0,
  );
  const student = (await fx.students.byEmail("a@example.com"))!;
  assert.equal((await fx.entitlements.forStudent(student.id)).length, 2);
  const revoked = (await fx.students.byEmail("c@example.com"))!;
  assert.equal(
    (
      await fx.entitlements.canAccess({
        studentId: revoked.id,
        courseId: "course",
      })
    ).allowed,
    false,
  );
  // The old invitation sessions and progress keys are unchanged.
  assert.ok(
    fx.storage.enrollments.rows.has(a.student.id) &&
      fx.storage.enrollments.rows.has(b.student.id),
  );
  const reverted = await all({ dryRun: false, revertToV1: true });
  assert.equal(reverted.report.reverted, 3);
  assert.equal(
    (await integrity({ enrollments: fx.storage.enrollments })).v1Enrollments,
    3,
  );
  const exchanged = data(await fx.lms.exchange({ token: a.token }));
  data(await fx.lms.library({}, exchanged.sessionToken));
  assert.equal(await key("course", "a@example.com"), a.student.id);
});

test("library still serves legacy LearningState shapes", async () => {
  const fx = await setup();
  const invitation = data(
    await fx.lms.invite({
      courseId: "course",
      name: "L",
      email: "l@example.com",
    }),
  );
  const legacy = data(await fx.lms.exchange({ token: invitation.token }));
  const state: LearningState = data(
    await fx.lms.library({}, legacy.sessionToken),
  );
  assert.equal(state.course.id, "course");
});

test("an unmigrated invitation stays open after the dashboard and classroom link it", async () => {
  const fx = await setup();
  const invitation = data(
    await fx.lms.invite({
      courseId: "course",
      name: "L",
      email: "l@example.com",
    }),
  );
  const signed = await fx.signIn("l@example.com");
  const first = await fx.learning.dashboard(signed.sessionToken);
  assert.deepEqual(
    first.courses.map((item) => [item.courseId, item.access.status]),
    [["course", "active"]],
  );
  const credential = { student: signed.sessionToken, courseId: "course" };
  data(await fx.lms.complete({ lessonId: "one", completed: true }, credential));
  const again = await fx.learning.dashboard(signed.sessionToken);
  assert.deepEqual(
    again.courses.map((item) => [item.access.status, item.completedCount]),
    [["active", 1]],
  );
  const grants = await fx.entitlements.forStudent(signed.student.id);
  assert.deepEqual(
    grants.map((item) => [item.source, item.sourceRef, item.status]),
    [
      [
        "invite",
        `${invitation.student.id}:${Date.parse(invitation.student.invitedAt)}`,
        "active",
      ],
    ],
  );
});

test("a linked invitation without its grant is re-granted, but a revoked grant is never revived", async () => {
  const fx = await setup();
  const invitation = data(
    await fx.lms.invite({
      courseId: "course",
      name: "L",
      email: "l@example.com",
    }),
  );
  const signed = await fx.signIn("l@example.com");
  // Simulate a crash after linking but before granting.
  const student = (await fx.students.get(signed.student.id))!;
  const row = fx.storage.enrollments.rows.get(invitation.student.id)!;
  await fx.storage.enrollments.put(invitation.student.id, {
    ...(row.value as object),
    schemaVersion: 2,
    studentId: student.id,
  });
  const credential = { student: signed.sessionToken, courseId: "course" };
  data(await fx.lms.library({}, credential));
  const [grant] = await fx.entitlements.forStudent(student.id);
  await fx.entitlements.revoke({
    entitlementId: grant!.id,
    reason: "Refunded",
    actor: owner,
  });
  const denied = await fx.lms.library({}, credential);
  assert.equal(!denied.ok && denied.error.code, "ACCESS_ENDED");
  assert.equal(
    (await fx.learning.dashboard(signed.sessionToken)).courses[0]!.access
      .status,
    "revoked",
  );
});

test("an invitation cannot sign in to an account whose email was verified", async () => {
  const fx = await setup();
  const victim = await fx.signIn("victim@example.com");
  data(
    await fx.lms.invite({
      courseId: "other",
      name: "Victim",
      email: "victim@example.com",
    }),
  );
  const invitation = data(
    await fx.lms.invite({
      courseId: "course",
      name: "Victim",
      email: "victim@example.com",
    }),
  );
  const outcome = await fx.learning.exchangeInvitation(
    invitation.token,
    origin.userAgent,
    "vi",
  );
  assert.ok(!("sessionToken" in outcome));
  assert.deepEqual(outcome, {
    signInRequired: true,
    courseId: "course",
    maskedEmail: "v***@example.com",
  });
  // The victim gets the course through their own sign-in.
  data(
    await fx.lms.library(
      {},
      { student: victim.sessionToken, courseId: "course" },
    ),
  );
});

test("sessions opened by invitation end when the email's owner first signs in", async () => {
  const fx = await setup();
  const invitation = data(
    await fx.lms.invite({
      courseId: "course",
      name: "L",
      email: "l@example.com",
    }),
  );
  const opened = await fx.learning.exchangeInvitation(
    invitation.token,
    origin.userAgent,
    "vi",
  );
  assert.ok("sessionToken" in opened);
  const owner = await fx.signIn("l@example.com");
  await fails(fx.accounts.access(opened.sessionToken), "AUTH_REQUIRED");
  await fx.accounts.access(owner.sessionToken);
});

test("revoking an invitation during an upgrade grants nothing", async () => {
  const fx = await setup();
  const invitation = data(
    await fx.lms.invite({
      courseId: "course",
      name: "L",
      email: "l@example.com",
    }),
  );
  const legacy = data(await fx.lms.exchange({ token: invitation.token }));
  await fx.learning.startUpgrade(legacy.sessionToken, origin, site);
  data(await fx.lms.revoke({ id: invitation.student.id }));
  const verified = await fx.accounts.verifyCode(
    { email: "l@example.com", code: /(\d{6})/.exec(fx.sent.at(-1)!.text)![1]! },
    origin,
    "vi",
  );
  await fx.learning.completeUpgrade(
    verified.student.id,
    verified.upgradeEnrollmentId!,
  );
  assert.deepEqual(await fx.entitlements.forStudent(verified.student.id), []);
  const denied = await fx.lms.library(
    {},
    { student: verified.sessionToken, courseId: "course" },
  );
  assert.equal(denied.ok, false);
});

test("an invitation session on a linked enrollment follows the account's access", async () => {
  const fx = await setup();
  const invitation = data(
    await fx.lms.invite({
      courseId: "course",
      name: "L",
      email: "l@example.com",
    }),
  );
  const legacy = data(await fx.lms.exchange({ token: invitation.token }));
  const account = await fx.signIn("l@example.com");
  data(
    await fx.lms.library(
      {},
      { student: account.sessionToken, courseId: "course" },
    ),
  );
  data(await fx.lms.library({}, legacy.sessionToken));
  const [grant] = await fx.entitlements.forStudent(account.student.id);
  await fx.entitlements.revoke({
    entitlementId: grant!.id,
    reason: "Refunded",
    actor: owner,
  });
  const denied = await fx.lms.library({}, legacy.sessionToken);
  assert.equal(!denied.ok && denied.error.code, "ACCESS_DENIED");
});

test("re-inviting after a revoke restores access with a new grant", async () => {
  const fx = await setup();
  const first = data(
    await fx.lms.invite({
      courseId: "course",
      name: "L",
      email: "l@example.com",
    }),
  );
  const signed = await fx.learning.exchangeInvitation(
    first.token,
    origin.userAgent,
    "vi",
  );
  assert.ok("sessionToken" in signed);
  const [grant] = await fx.entitlements.forStudent(signed.student.id);
  await fx.entitlements.revoke({
    entitlementId: grant!.id,
    reason: "Paused",
    actor: owner,
  });
  data(await fx.lms.revoke({ id: first.student.id }));
  fx.advance(1000);
  const second = data(
    await fx.lms.invite({
      courseId: "course",
      name: "L",
      email: "l@example.com",
    }),
  );
  const again = await fx.learning.exchangeInvitation(
    second.token,
    origin.userAgent,
    "vi",
  );
  assert.ok("sessionToken" in again);
  data(
    await fx.lms.library(
      {},
      { student: again.sessionToken, courseId: "course" },
    ),
  );
});
