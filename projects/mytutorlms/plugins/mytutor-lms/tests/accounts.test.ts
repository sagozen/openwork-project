import assert from "node:assert/strict";
import test from "node:test";
import type { Course } from "../src/model.js";
import { AccountService, type SiteRules } from "../src/services/accounts.js";
import { AuditLog, redact } from "../src/services/audit.js";
import { EntitlementService } from "../src/services/entitlements.js";
import { NotificationService } from "../src/services/notifications.js";
import { RateLimiter } from "../src/services/rate-limit.js";
import { key, result } from "../src/services/shared.js";
import { requireConfirmation, StaffService } from "../src/services/staff.js";
import { StudentDirectory } from "../src/services/students.js";
import { LmsService } from "../src/service.js";
import { MemoryCollection } from "./support/memory-collection.js";

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const system = { type: "system" as const, id: "test", label: "Test" };
const origin = {
  binding: "a".repeat(64),
  clientHash: "ip-hash",
  userAgent: "Mozilla/5.0 (iPhone) Safari/605.1",
};
const site: SiteRules = {
  siteName: "Studio",
  verifyUrl: "https://studio.example/sign-in/verify",
  selfSignup: true,
  locales: ["vi", "en"],
  dailySignInEmailCap: 500,
};

async function fails(promise: Promise<unknown>, code: string) {
  const outcome = await result(async () => promise);
  assert.equal(outcome.ok, false, JSON.stringify(outcome));
  if (!outcome.ok) assert.equal(outcome.error.code, code);
}
function course(status: Course["status"] = "published"): Course {
  return {
    title: "Course",
    summary: "Summary",
    description: "",
    instructor: "Teacher",
    status,
    lessons: [
      {
        id: "one",
        title: "One",
        module: "M",
        durationMinutes: 5,
        body: "Notes",
        videoUrl: "",
        resourceUrl: "",
        resourceLabel: "",
      },
    ],
  };
}

function setup(options: { transport?: boolean } = {}) {
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
    staff: c(),
    rateLimits: c(),
  };
  const sent: { to: string; subject: string; text: string }[] = [];
  const transport =
    options.transport === false
      ? null
      : {
          send: async (message: {
            to: string;
            subject: string;
            text: string;
          }) => {
            sent.push(message);
          },
        };
  const audit = new AuditLog(storage.auditEvents, "studio", now);
  const students = new StudentDirectory(storage, now);
  const notifications = new NotificationService(
    storage.notifications,
    students,
    transport,
    { locale: "vi", replyTo: "" },
    now,
  );
  const limits = new RateLimiter(storage.rateLimits, now);
  const accounts = new AccountService(
    storage,
    students,
    notifications,
    limits,
    audit,
    now,
  );
  const entitlements = new EntitlementService(storage, students, audit, now);
  const staff = new StaffService(storage.staff, audit, now);
  const lms = new LmsService(storage, now);
  const codeFrom = (index = sent.length - 1) =>
    /(\d{6})/.exec(sent[index]!.text)![1]!;
  const linkFrom = (index = sent.length - 1) =>
    /#t=([a-f0-9.]+)/.exec(sent[index]!.text)![1]!;
  return {
    storage,
    audit,
    students,
    notifications,
    limits,
    accounts,
    entitlements,
    staff,
    lms,
    sent,
    codeFrom,
    linkFrom,
    advance: (ms: number) => {
      time += ms;
    },
    now,
  };
}
async function signIn(
  fx: ReturnType<typeof setup>,
  email = "learner@example.com",
) {
  await fx.accounts.start({ email, locale: "vi" }, origin, site);
  return fx.accounts.verifyCode({ email, code: fx.codeFrom() }, origin, "vi");
}

test("audit is append-only per key and never stores credentials or raw emails", async () => {
  const fx = setup();
  const input = {
    actor: system,
    action: "entitlement.grant",
    subject: { type: "entitlement", id: "e1" },
    after: {
      tokenHash: "x",
      sessionToken: "y",
      code: "123456",
      email: "learner@example.com",
      nested: { secret: "z", ok: 1 },
    },
    key: "fixed",
  };
  await fx.audit.record(input);
  await fx.audit.record({ ...input, reason: "a replay must not overwrite" });
  const stored = fx.storage.auditEvents.rows.get("fixed")!.value as {
    after: unknown;
    reason: string;
  };
  assert.deepEqual(stored.after, {
    email: "l***@example.com",
    nested: { ok: 1 },
  });
  assert.equal(stored.reason, "");
  assert.deepEqual(redact({ big: "x".repeat(5000) }), { truncated: true });
});

test("sign-in answers the same for known and unknown emails and never stores the code", async () => {
  const fx = setup();
  await signIn(fx, "known@example.com");
  const known = await fx.accounts.start(
    { email: "known@example.com", locale: "vi" },
    origin,
    site,
  );
  const unknown = await fx.accounts.start(
    { email: "new@example.com", locale: "vi" },
    origin,
    { ...site, selfSignup: false },
  );
  assert.deepEqual(known, unknown);
  // Self-signup off: an unknown email gets no message at all.
  assert.ok(!fx.sent.some((message) => message.to === "new@example.com"));
  const stored = JSON.stringify([...fx.storage.notifications.rows.values()]);
  for (const message of fx.sent)
    assert.ok(!stored.includes(/(\d{6})/.exec(message.text)![1]!));
  assert.ok(!stored.includes("#t="));
});

test("sign-in email is rate limited per address", async () => {
  const fx = setup();
  for (let index = 0; index < 3; index++)
    await fx.accounts.start(
      { email: "a@example.com", locale: "vi" },
      origin,
      site,
    );
  await fails(
    fx.accounts.start({ email: "a@example.com", locale: "vi" }, origin, site),
    "RATE_LIMITED",
  );
  assert.equal(fx.sent.length, 3);
  fx.advance(16 * MINUTE);
  await fx.accounts.start(
    { email: "a@example.com", locale: "vi" },
    origin,
    site,
  );
  assert.equal(fx.sent.length, 4);
});

test("codes burn after five wrong attempts, even before the right one", async () => {
  const fx = setup();
  await fx.accounts.start(
    { email: "a@example.com", locale: "vi" },
    origin,
    site,
  );
  const right = fx.codeFrom();
  const wrong = right === "000000" ? "111111" : "000000";
  for (let attempt = 0; attempt < 4; attempt++)
    await fails(
      fx.accounts.verifyCode(
        { email: "a@example.com", code: wrong },
        origin,
        "vi",
      ),
      "CODE_INVALID",
    );
  await fails(
    fx.accounts.verifyCode(
      { email: "a@example.com", code: wrong },
      origin,
      "vi",
    ),
    "CHALLENGE_EXPIRED",
  );
  await fails(
    fx.accounts.verifyCode(
      { email: "a@example.com", code: right },
      origin,
      "vi",
    ),
    "CHALLENGE_EXPIRED",
  );
});

test("codes expire after 15 minutes and are single-use; a new code replaces the old one", async () => {
  const fx = setup();
  await fx.accounts.start(
    { email: "a@example.com", locale: "vi" },
    origin,
    site,
  );
  const first = fx.codeFrom();
  await fx.accounts.start(
    { email: "a@example.com", locale: "vi" },
    origin,
    site,
  );
  const second = fx.codeFrom();
  if (first !== second)
    await fails(
      fx.accounts.verifyCode(
        { email: "a@example.com", code: first },
        origin,
        "vi",
      ),
      "CODE_INVALID",
    );
  fx.advance(16 * MINUTE);
  await fails(
    fx.accounts.verifyCode(
      { email: "a@example.com", code: second },
      origin,
      "vi",
    ),
    "CHALLENGE_EXPIRED",
  );
  await fx.accounts.start(
    { email: "a@example.com", locale: "vi" },
    origin,
    site,
  );
  const third = fx.codeFrom();
  const signed = await fx.accounts.verifyCode(
    { email: "a@example.com", code: third },
    origin,
    "vi",
  );
  assert.equal(signed.student.email, "a@example.com");
  assert.equal(signed.student.emailVerified, true);
  await fails(
    fx.accounts.verifyCode(
      { email: "a@example.com", code: third },
      origin,
      "vi",
    ),
    "CHALLENGE_EXPIRED",
  );
});

test("a sign-in link opened in another browser asks for confirmation", async () => {
  const fx = setup();
  await fx.accounts.start(
    { email: "a@example.com", locale: "vi" },
    origin,
    site,
  );
  const token = fx.linkFrom();
  const elsewhere = { ...origin, binding: "b".repeat(64) };
  assert.deepEqual(await fx.accounts.verifyLink({ token }, elsewhere, "vi"), {
    confirm: { maskedEmail: "a***@example.com" },
  });
  const signed = await fx.accounts.verifyLink(
    { token, confirm: true },
    elsewhere,
    "vi",
  );
  assert.ok("sessionToken" in signed);
  await fails(
    fx.accounts.verifyLink({ token }, origin, "vi"),
    "CHALLENGE_EXPIRED",
  );
});

test("sessions: hashed at rest, 30-day absolute expiry, logout and logout-all", async () => {
  const fx = setup();
  const a = await signIn(fx);
  const stored = JSON.stringify([...fx.storage.studentSessions.rows.values()]);
  assert.ok(!stored.includes(a.sessionToken.split(".")[1]!));
  const current = await fx.accounts.access(a.sessionToken);
  assert.equal(current.session.value.deviceLabel, "Safari on iPhone");
  const b = await signIn(fx);
  await fx.accounts.logout(a.sessionToken);
  await fails(fx.accounts.access(a.sessionToken), "AUTH_REQUIRED");
  await fx.accounts.access(b.sessionToken);
  await fx.accounts.logoutAll(await fx.accounts.access(b.sessionToken));
  await fails(fx.accounts.access(b.sessionToken), "AUTH_REQUIRED");
  const c = await signIn(fx);
  fx.advance(30 * DAY);
  await fails(fx.accounts.access(c.sessionToken), "AUTH_REQUIRED");
  await fails(fx.accounts.access("not-a-token"), "AUTH_REQUIRED");
});

test("one student per email even under concurrent creation; old email is reusable after a change", async () => {
  const fx = setup();
  const input = {
    email: "same@example.com",
    name: "",
    locale: "vi" as const,
    createdBy: "self" as const,
    verified: true,
  };
  const [x, y] = await Promise.all([
    fx.students.resolveOrCreate(input),
    fx.students.resolveOrCreate(input),
  ]);
  assert.equal(x.student.id, y.student.id);
  const moved = await fx.students.changeEmail(x.student, "moved@example.com");
  assert.equal((await fx.students.byEmail("moved@example.com"))?.id, moved.id);
  assert.equal(await fx.students.byEmail("same@example.com"), null);
  const fresh = await fx.students.resolveOrCreate(input);
  assert.notEqual(fresh.student.id, x.student.id);
  await fails(
    fx.students.changeEmail(fresh.student, "moved@example.com"),
    "CONFLICT",
  );
});

test("grants are idempotent, never reactivated, and conflict on different terms", async () => {
  const fx = setup();
  await fx.lms.saveCourse({ id: "course", revision: null, value: course() });
  const { student } = await signIn(fx);
  const grant = {
    studentId: student.id,
    courseId: "course",
    source: "manual" as const,
    sourceRef: "req-1",
    expiresAt: null,
    actor: system,
  };
  const first = await fx.entitlements.grant(grant);
  const replay = await fx.entitlements.grant(grant);
  assert.equal(first.created, true);
  assert.equal(replay.created, false);
  assert.equal(replay.entitlement.id, first.entitlement.id);
  await fx.entitlements.revoke({
    entitlementId: first.entitlement.id,
    reason: "Refund",
    actor: system,
  });
  const again = await fx.entitlements.grant(grant);
  assert.equal(again.entitlement.status, "revoked");
  await fails(
    fx.entitlements.grant({ ...grant, expiresAt: fx.now() + DAY }),
    "CONFLICT",
  );
  await fails(
    fx.entitlements.grant({
      ...grant,
      source: "sepay",
      sourceRef: "order-1",
      expiresAt: null,
    }),
    "VALIDATION",
  );
  assert.equal(
    (
      await fx.entitlements.revoke({
        entitlementId: first.entitlement.id,
        reason: "x",
        actor: system,
      })
    ).changed,
    false,
  );
  const audits = [...fx.storage.auditEvents.rows.values()].map(
    (row) => (row.value as { action: string }).action,
  );
  assert.deepEqual(
    audits.filter((action) => action === "entitlement.grant").length,
    1,
  );
});

test("canAccess explains every outcome and picks the latest end date", async () => {
  const fx = setup();
  await fx.lms.saveCourse({ id: "course", revision: null, value: course() });
  const { student } = await signIn(fx);
  const ask = (lessonId?: string) =>
    fx.entitlements.canAccess({
      studentId: student.id,
      courseId: "course",
      lessonId,
    });
  assert.equal((await ask()).reason, "no_entitlement");
  const base = { studentId: student.id, courseId: "course", actor: system };
  await fx.entitlements.grant({
    ...base,
    source: "manual",
    sourceRef: "future",
    startsAt: fx.now() + DAY,
    expiresAt: fx.now() + 2 * DAY,
  });
  assert.equal((await ask()).reason, "not_started");
  const short = await fx.entitlements.grant({
    ...base,
    source: "whop",
    sourceRef: "o1",
    expiresAt: fx.now() + DAY,
  });
  const long = await fx.entitlements.grant({
    ...base,
    source: "sepay",
    sourceRef: "o2",
    expiresAt: fx.now() + 10 * DAY,
  });
  const open = await ask("one");
  assert.equal(open.allowed, true);
  assert.equal(open.entitlementId, long.entitlement.id);
  assert.equal((await ask("missing")).reason, "lesson_not_found");
  fx.advance(11 * DAY);
  assert.equal((await ask()).reason, "ended");
  await fx.entitlements.revoke({
    entitlementId: short.entitlement.id,
    reason: "r",
    actor: system,
  });
  await fx.entitlements.revoke({
    entitlementId: long.entitlement.id,
    reason: "r",
    actor: system,
  });
  const all = await fx.entitlements.forStudent(student.id);
  for (const item of all.filter((item) => item.status === "active"))
    await fx.entitlements.revoke({
      entitlementId: item.id,
      reason: "r",
      actor: system,
    });
  assert.equal((await ask()).reason, "revoked");
  await fx.lms.saveCourse({
    id: "course",
    revision: (await fx.storage.courses.getVersioned("course"))!.revision,
    value: course("draft"),
  });
  assert.equal((await ask()).reason, "course_unavailable");
  const disabled = await fx.students.update(
    (await fx.students.get(student.id))!,
    { status: "disabled" },
  );
  assert.equal(disabled.value.status, "disabled");
  assert.equal((await ask()).reason, "student_disabled");
});

test("a 0.2 invitation enrollment grants access until migration and is linked, not duplicated, by a grant", async () => {
  const fx = setup();
  await fx.lms.saveCourse({ id: "course", revision: null, value: course() });
  const invitation = await fx.lms.invite({
    courseId: "course",
    name: "Learner",
    email: "learner@example.com",
  });
  assert.ok(invitation.ok);
  const { student } = await signIn(fx);
  const decision = await fx.entitlements.canAccess({
    studentId: student.id,
    courseId: "course",
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.entitlementId, null);
  await fx.entitlements.grant({
    studentId: student.id,
    courseId: "course",
    source: "invite",
    sourceRef: invitation.ok ? invitation.data.student.id : "",
    expiresAt: null,
    actor: system,
  });
  const legacyKey = await key("course", "learner@example.com");
  const linked = fx.storage.enrollments.rows.get(legacyKey)!.value as {
    schemaVersion: number;
    studentId: string;
  };
  assert.equal(linked.schemaVersion, 2);
  assert.equal(linked.studentId, student.id);
  assert.equal(fx.storage.enrollments.rows.size, 1);
});

test("staff: admins bootstrap as owner, roles follow the matrix, the last owner is protected", async () => {
  const fx = setup();
  const admin = {
    id: "u-admin",
    email: "owner@example.com",
    name: "Owner",
    role: 50,
  };
  const owner = await fx.staff.resolve(admin);
  assert.equal(owner.role, "owner");
  await fails(
    fx.staff.resolve({
      id: "u-new",
      email: "c@example.com",
      name: null,
      role: 20,
    }),
    "FORBIDDEN_ROLE",
  );
  await fails(
    fx.staff.resolve({
      id: "u-sub",
      email: "s@example.com",
      name: null,
      role: 10,
    }),
    "FORBIDDEN_ROLE",
  );
  const contributor = {
    id: "u-teacher",
    email: "teacher@example.com",
    name: "Teacher",
    role: 20,
  };
  await fx.staff.save(
    owner,
    {
      userId: contributor.id,
      revision: null,
      role: "instructor",
      courseIds: ["course"],
      confirmation: contributor.email,
      reason: "Joins the teaching team",
    },
    contributor,
  );
  const teacher = await fx.staff.resolve(contributor);
  fx.staff.authorize(teacher, "course.edit", { courseId: "course" });
  await fails(
    (async () =>
      fx.staff.authorize(teacher, "course.edit", { courseId: "other" }))(),
    "FORBIDDEN_ROLE",
  );
  await fails(
    (async () => fx.staff.authorize(teacher, "entitlement.grant"))(),
    "FORBIDDEN_ROLE",
  );
  fx.staff.authorize(teacher, "entitlement.grant", {
    instructorsMayGrant: true,
  });
  await fails(
    (async () =>
      fx.staff.authorize(teacher, "site.settings", {
        instructorsMayGrant: true,
      }))(),
    "FORBIDDEN_ROLE",
  );
  await fails(
    fx.staff.save(
      owner,
      {
        userId: admin.id,
        revision: fx.storage.staff.rows.get(admin.id)!.revision,
        role: "instructor",
        courseIds: "all",
        confirmation: admin.email,
        reason: "Step down from owner",
      },
      admin,
    ),
    "CONFLICT",
  );
  await fails(
    fx.staff.remove(owner, {
      userId: admin.id,
      confirmation: admin.email,
      reason: "Leaving the company",
    }),
    "CONFLICT",
  );
  await fails(
    fx.staff.save(
      owner,
      {
        userId: "u-x",
        revision: null,
        role: "assistant",
        courseIds: "all",
        confirmation: "wrong",
        reason: "short",
      },
      { id: "u-x", email: "x@example.com", name: null, role: 20 },
    ),
    "CONFIRMATION_REQUIRED",
  );
  assert.throws(() =>
    requireConfirmation({
      confirmation: "a@b.c",
      expected: "a@b.c",
      reason: "too short",
    }),
  );
});

test("notifications: deduplicated, failures recorded, retries back off and sign-in codes never resend", async () => {
  const fx = setup({ transport: false });
  await fx.accounts.start(
    { email: "a@example.com", locale: "vi" },
    origin,
    site,
  );
  const rows = () =>
    [...fx.storage.notifications.rows.values()].map(
      (row) =>
        row.value as { status: string; lastError: string; template: string },
    );
  assert.deepEqual(
    rows().map((row) => [row.template, row.status, row.lastError]),
    [["sign_in_code", "failed", "EMAIL_UNAVAILABLE"]],
  );
  const queued = await fx.notifications.send({
    email: "a@example.com",
    template: "test",
    data: { siteName: "Studio" },
    dedupeKey: "t1",
  });
  const again = await fx.notifications.send({
    email: "a@example.com",
    template: "test",
    data: { siteName: "Studio" },
    dedupeKey: "t1",
  });
  assert.equal(queued.notificationId, again.notificationId);
  assert.equal(queued.status, "queued");
});

test("instructors never edit, disable or sign out students, even when allowed to grant", async () => {
  const fx = setup();
  const owner = await fx.staff.resolve({
    id: "u-admin",
    email: "owner@example.com",
    name: "Owner",
    role: 50,
  });
  const user = { id: "u-t", email: "t@example.com", name: "T", role: 20 };
  await fx.staff.save(
    owner,
    {
      userId: user.id,
      revision: null,
      role: "instructor",
      courseIds: ["course"],
      confirmation: user.email,
      reason: "Teaching this term",
    },
    user,
  );
  const teacher = await fx.staff.resolve(user);
  fx.staff.authorize(teacher, "entitlement.grant", {
    courseId: "course",
    instructorsMayGrant: true,
  });
  await fails(
    (async () =>
      fx.staff.authorize(teacher, "student.update", {
        instructorsMayGrant: true,
      }))(),
    "FORBIDDEN_ROLE",
  );
});

test("invitation emails are never retried or resent, because their links are not stored", async () => {
  const fx = setup({ transport: false });
  const sent = await fx.notifications.send({
    email: "a@example.com",
    template: "invitation",
    data: {
      siteName: "S",
      courseTitle: "C",
      instructor: "T",
      link: "https://x/join#secret",
    },
    dedupeKey: "i1",
    immediate: true,
  });
  assert.equal(sent.status, "failed");
  await fails(fx.notifications.resend(sent.notificationId), "VALIDATION");
  assert.ok(
    !JSON.stringify([...fx.storage.notifications.rows.values()]).includes(
      "secret",
    ),
  );
});
