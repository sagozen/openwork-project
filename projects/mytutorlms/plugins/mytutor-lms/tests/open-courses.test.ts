import assert from "node:assert/strict";
import test from "node:test";
import type {
  Course,
  CourseRecord,
  CourseSummary,
  Dashboard,
  EntitlementView,
  LearningState,
  LiveSession,
  Result,
} from "../src/model.js";
import { validateCourse } from "../src/admin/course-editor.js";
import {
  parseInput,
  saveSchema,
  storedCourseSchema,
} from "../src/validation.js";
import { routeHarness } from "./support/route-harness.js";

type Harness = ReturnType<typeof routeHarness>;
/** Every audit event matching a filter, across pages. */
async function auditEvents(
  h: Harness,
  filter: { subjectId?: string; action?: string },
) {
  const svc = await h.services();
  const events = [];
  let cursor: string | undefined;
  do {
    const page = await svc.audit.list({ ...filter, cursor });
    events.push(...page.items);
    cursor = page.cursor ?? undefined;
  } while (cursor);
  return events;
}

const owner = {
  id: "u-owner",
  email: "owner@studio.example",
  name: "Owner",
  role: 50,
};
const instructor = {
  id: "u-teacher",
  email: "teacher@studio.example",
  name: "Teacher",
  role: 20,
};
const otherInstructor = {
  id: "u-other",
  email: "other@studio.example",
  name: "Other",
  role: 20,
};
const assistant = {
  id: "u-assistant",
  email: "assistant@studio.example",
  name: "Assistant",
  role: 20,
};

function data<T>(value: Result<unknown>): T {
  assert.equal(value.ok, true, JSON.stringify(value));
  return (value as { ok: true; data: T }).data;
}
function failure(value: Result<unknown>, code: string) {
  assert.equal(value.ok, false, JSON.stringify(value));
  if (!value.ok) assert.equal(value.error.code, code, value.error.message);
}
function course(
  title: string,
  overrides: Partial<Course> = {},
  lessonOverrides: Partial<Course["lessons"][number]> = {},
): Course {
  return {
    title,
    summary: "Summary",
    description: "",
    instructor: "Teacher",
    status: "published",
    lessons: [
      {
        id: "intro",
        title: "Intro",
        module: "Start",
        durationMinutes: 5,
        body: "Notes",
        videoUrl: "",
        resourceUrl: "",
        resourceLabel: "",
        ...lessonOverrides,
      },
    ],
    ...overrides,
  };
}
const openConfirmation = {
  confirmation: "OPEN",
  reason: "Free beginner course for everyone",
};

async function setup() {
  const h = routeHarness();
  // The first admin request bootstraps the owner.
  data(await h.admin("admin/me", {}, owner));
  const save = (id: string, value: Course, extra: object = {}) =>
    h.admin(
      "admin/save-course",
      { id, revision: null, value, ...extra },
      owner,
    );
  data(
    await save("free", course("Free", { access: "open" }), openConfirmation),
  );
  data(await save("invite", course("Invite only")));
  data(
    await save(
      "draft",
      course("Draft", { status: "draft", access: "open" }),
      openConfirmation,
    ),
  );
  const staff = h.collections.get("staff")!;
  for (const [user, role, courseIds] of [
    [instructor, "instructor", ["free"]],
    [otherInstructor, "instructor", ["invite"]],
    [assistant, "assistant", ["free"]],
  ] as const)
    await staff.put(user.id, {
      schemaVersion: 1,
      userId: user.id,
      displayName: user.name,
      email: user.email,
      role,
      courseIds: [...courseIds],
      active: true,
      createdAt: 0,
      updatedBy: owner.id,
    });
  return h;
}

test("opening a course takes a typed confirmation and is audited; the course record keeps the 0.3 shape", async () => {
  const h = routeHarness();
  data(await h.admin("admin/me", {}, owner));
  const value = course(
    "Free",
    { access: "open" },
    {
      resources: [
        { label: "  Installer  ", url: "https://cdn.example/app.dmg" },
      ],
    },
  );
  failure(
    await h.admin(
      "admin/save-course",
      { id: "free", revision: null, value },
      owner,
    ),
    "CONFIRMATION_REQUIRED",
  );
  failure(
    await h.admin(
      "admin/save-course",
      {
        id: "free",
        revision: null,
        value,
        confirmation: "open",
        reason: "short",
      },
      owner,
    ),
    "CONFIRMATION_REQUIRED",
  );
  const saved = data<CourseRecord>(
    await h.admin(
      "admin/save-course",
      { id: "free", revision: null, value, ...openConfirmation },
      owner,
    ),
  );
  assert.equal(saved.value.access, "open");
  assert.deepEqual(saved.value.lessons[0]!.resources, [
    { label: "Installer", url: "https://cdn.example/app.dmg" },
  ]);
  // 0.3 parses the course record strictly: it must not gain any field.
  const row = h.collections.get("courses")!.rows.get("free")!.value as {
    course: Record<string, unknown> & { lessons: Record<string, unknown>[] };
  };
  assert.deepEqual(Object.keys(row.course).sort(), [
    "description",
    "instructor",
    "lessons",
    "status",
    "summary",
    "title",
  ]);
  assert.deepEqual(Object.keys(row.course.lessons[0]!).sort(), [
    "body",
    "durationMinutes",
    "id",
    "module",
    "resourceLabel",
    "resourceUrl",
    "title",
    "videoUrl",
  ]);
  assert.equal(storedCourseSchema.safeParse(row).success, true);
  // Saving again without a change needs no confirmation; closing it neither.
  const again = data<CourseRecord>(
    await h.admin(
      "admin/save-course",
      { id: "free", revision: saved.revision, value: saved.value },
      owner,
    ),
  );
  const closed = data<CourseRecord>(
    await h.admin(
      "admin/save-course",
      {
        id: "free",
        revision: again.revision,
        value: { ...again.value, access: "invite" },
      },
      owner,
    ),
  );
  assert.equal(closed.value.access, "invite");
  const actions = (await auditEvents(h, { subjectId: "free" }))
    .filter((event) => event.action === "course.access")
    .map((event) => JSON.stringify([event.before, event.after, event.reason]))
    .sort();
  assert.deepEqual(
    actions,
    [
      [{ access: "invite" }, { access: "open" }, openConfirmation.reason],
      [{ access: "open" }, { access: "invite" }, ""],
    ]
      .map((entry) => JSON.stringify(entry))
      .sort(),
  );
});

test("records written by 0.3 read as invite-only without extra resources; an unreadable options row never opens a course", async () => {
  const h = routeHarness();
  data(await h.admin("admin/me", {}, owner));
  const legacy = course("Legacy");
  await h.collections
    .get("courses")!
    .put("legacy", { schemaVersion: 1, course: legacy });
  const [record] = data<CourseRecord[]>(
    await h.admin("admin/courses", {}, owner),
  );
  assert.equal(record!.value.access, "invite");
  assert.deepEqual(record!.value.lessons[0]!.resources, []);
  await h.collections
    .get("courseOptions")!
    .put("legacy", { schemaVersion: 9, access: "open" });
  const [summary] = data<CourseSummary[]>(await h.catalog());
  assert.equal(summary!.access, "invite");
  const { token } = await h.signIn("learner@example.com");
  failure(await h.student("join", { courseId: "legacy" }, token), "NOT_OPEN");
  // A save replaces the unreadable row.
  const saved = data<CourseRecord>(
    await h.admin(
      "admin/save-course",
      { id: "legacy", revision: record!.revision, value: record!.value },
      owner,
    ),
  );
  assert.equal(saved.value.access, "invite");
  assert.equal(
    (
      h.collections.get("courseOptions")!.rows.get("legacy")!.value as {
        schemaVersion: number;
      }
    ).schemaVersion,
    1,
  );
});

test("starting an open course grants access once, quietly, as a complimentary grant", async () => {
  const h = await setup();
  const { token, studentId } = await h.signIn("learner@example.com");
  const sentBefore = h.sent.length;
  const dashboard = data<Dashboard>(await h.student("dashboard", {}, token));
  assert.deepEqual(
    dashboard.openCourses?.map((item) => item.courseId),
    ["free"],
  );
  failure(
    await h.student("classroom", { courseId: "free" }, token),
    "ACCESS_ENDED",
  );
  assert.deepEqual(data(await h.student("join", { courseId: "free" }, token)), {
    courseId: "free",
    joined: true,
  });
  assert.deepEqual(data(await h.student("join", { courseId: "free" }, token)), {
    courseId: "free",
    joined: false,
  });
  const svc = await h.services();
  const grants = await svc.entitlements.forStudent(studentId);
  assert.equal(grants.length, 1);
  assert.equal(grants[0]!.source, "comp");
  assert.equal(grants[0]!.sourceRef, `open:free:${studentId}`);
  assert.equal(grants[0]!.expiresAt, null);
  assert.equal(grants[0]!.grantedBy.type, "student");
  assert.equal(h.sent.length, sentBefore, "no access-granted email");
  const audit = await auditEvents(h, { action: "entitlement.grant" });
  assert.equal(audit.filter((event) => event.actor.id === studentId).length, 1);
  const state = data<LearningState>(
    await h.student("classroom", { courseId: "free" }, token),
  );
  assert.equal(state.course.id, "free");
  const after = data<Dashboard>(await h.student("dashboard", {}, token));
  assert.deepEqual(after.openCourses, []);
  assert.deepEqual(
    after.courses.map((item) => item.courseId),
    ["free"],
  );
});

test("invite-only, draft and missing courses can never be self-joined, and joining needs an account", async () => {
  const h = await setup();
  const { token, studentId } = await h.signIn("learner@example.com");
  for (const courseId of ["invite", "draft", "missing"])
    failure(await h.student("join", { courseId }, token), "NOT_OPEN");
  failure(await h.student("join", { courseId: "free" }), "AUTH_REQUIRED");
  failure(
    await h.student("join", { courseId: "free", extra: true }, token),
    "VALIDATION",
  );
  const svc = await h.services();
  assert.deepEqual(await svc.entitlements.forStudent(studentId), []);
  failure(
    await h.student("classroom", { courseId: "invite" }, token),
    "ACCESS_ENDED",
  );
  // Unpublishing an open course closes it to new students too.
  const [free] = data<CourseRecord[]>(
    await h.admin("admin/courses", {}, owner),
  );
  data(
    await h.admin(
      "admin/save-course",
      {
        id: "free",
        revision: free!.revision,
        value: { ...free!.value, status: "draft" },
      },
      owner,
    ),
  );
  failure(await h.student("join", { courseId: "free" }, token), "NOT_OPEN");
});

test("a revoked open-course grant is never revived, and closing a course keeps existing students", async () => {
  const h = await setup();
  const first = await h.signIn("first@example.com");
  data(await h.student("join", { courseId: "free" }, first.token));
  const svc = await h.services();
  const [grant] = await svc.entitlements.forStudent(first.studentId);
  data(
    await h.admin(
      "admin/revoke-entitlement",
      {
        entitlementId: grant!.id,
        confirmation: "first@example.com",
        reason: "Removed from the free course",
      },
      owner,
    ),
  );
  failure(
    await h.student("join", { courseId: "free" }, first.token),
    "ACCESS_ENDED",
  );
  const [still] = await svc.entitlements.forStudent(first.studentId);
  assert.equal((still as EntitlementView).status, "revoked");

  const second = await h.signIn("second@example.com");
  data(await h.student("join", { courseId: "free" }, second.token));
  const free = data<CourseRecord[]>(
    await h.admin("admin/courses", {}, owner),
  ).find((record) => record.id === "free")!;
  data(
    await h.admin(
      "admin/save-course",
      {
        id: "free",
        revision: free.revision,
        value: { ...free.value, access: "invite" },
      },
      owner,
    ),
  );
  data(await h.student("classroom", { courseId: "free" }, second.token));
  const third = await h.signIn("third@example.com");
  failure(
    await h.student("join", { courseId: "free" }, third.token),
    "NOT_OPEN",
  );
});

test("starting open courses is rate limited per student", async () => {
  const h = await setup();
  const { token } = await h.signIn("learner@example.com");
  for (let attempt = 0; attempt < 20; attempt++)
    data(await h.student("join", { courseId: "free" }, token));
  failure(await h.student("join", { courseId: "free" }, token), "RATE_LIMITED");
});

test("lesson resources: at most 10 HTTPS links with one-line labels; the legacy resource still works", () => {
  const resource = { label: "Guide", url: "https://cdn.example/guide.pdf" };
  const withResources = (resources: unknown) => ({
    id: "c",
    revision: null,
    value: {
      ...course("C"),
      lessons: [
        {
          ...course("C").lessons[0]!,
          resourceUrl: "https://example.com/page",
          resourceLabel: "Legacy page",
          resources,
        },
      ],
    },
  });
  const accepts = (resources: unknown) =>
    parseInput(saveSchema, withResources(resources), 512 * 1024);
  const rejects = (resources: unknown) =>
    assert.throws(() => accepts(resources), /Check the required fields/);
  assert.equal(
    accepts(Array.from({ length: 10 }, () => resource)).value.lessons[0]!
      .resources!.length,
    10,
  );
  assert.equal(
    accepts([{ label: "  Guide  ", url: resource.url }]).value.lessons[0]!
      .resources![0]!.label,
    "Guide",
  );
  assert.equal(accepts(undefined).value.lessons[0]!.resources, undefined);
  rejects(Array.from({ length: 11 }, () => resource));
  rejects([{ label: "Guide", url: "http://cdn.example/guide.pdf" }]);
  rejects([{ label: "Guide", url: "javascript:alert(1)" }]);
  rejects([{ label: "Guide", url: "https://user:pw@cdn.example/a.pdf" }]);
  rejects([{ label: "Guide", url: `https://cdn.example/${"a".repeat(2030)}` }]);
  rejects([{ label: "Guide", url: "" }]);
  rejects([{ label: "   ", url: resource.url }]);
  rejects([{ label: "x".repeat(121), url: resource.url }]);
  rejects([{ label: "Two\nlines", url: resource.url }]);
  rejects([{ ...resource, extra: 1 }]);
  // The workspace checks the same limits before sending.
  const errors = validateCourse({
    ...course("C"),
    lessons: [
      {
        ...course("C").lessons[0]!,
        resources: [
          { label: "", url: "https://ok.example" },
          { label: "Insecure", url: "http://cdn.example/a.zip" },
        ],
      },
    ],
  });
  assert.ok(errors["lesson-intro-res-0-label"]);
  assert.ok(errors["lesson-intro-res-1-url"]);
  assert.equal(errors["lesson-intro-res-0-url"], undefined);
});

test("live sessions: only staff of the course manage them, edits are revision-checked and audited without the join link", async () => {
  const h = await setup();
  const id = "a".repeat(32);
  const value = {
    courseId: "free",
    title: "Buổi 1: Cài đặt",
    startsAt: "2030-01-05T12:00:00.000Z",
    durationMinutes: 90,
    joinUrl: "https://zoom.us/j/123456789?pwd=secret",
    passcode: "424242",
    notes: "Bring the installer.",
  };
  const created = data<LiveSession>(
    await h.admin(
      "admin/save-live-session",
      { id, revision: null, value },
      instructor,
    ),
  );
  assert.equal(created.startsAt, value.startsAt);
  failure(
    await h.admin(
      "admin/save-live-session",
      { id, revision: null, value },
      instructor,
    ),
    "CONFLICT",
  );
  // Another course's instructor and an assistant cannot read or change it.
  for (const user of [otherInstructor, assistant])
    failure(
      await h.admin("admin/live-sessions", { courseId: "free" }, user),
      "FORBIDDEN_ROLE",
    );
  failure(
    await h.admin(
      "admin/save-live-session",
      { id, revision: created.revision, value },
      otherInstructor,
    ),
    "FORBIDDEN_ROLE",
  );
  failure(
    await h.admin(
      "admin/save-live-session",
      {
        id,
        revision: created.revision,
        value: { ...value, courseId: "invite" },
      },
      otherInstructor,
    ),
    "NOT_FOUND",
  );
  failure(
    await h.admin(
      "admin/delete-live-session",
      { id, revision: created.revision },
      otherInstructor,
    ),
    "FORBIDDEN_ROLE",
  );
  // Limits.
  for (const invalid of [
    { durationMinutes: 10 },
    { durationMinutes: 481 },
    { joinUrl: "http://zoom.us/j/1" },
    { startsAt: "2030-01-05T19:00:00+07:00" },
    { title: "" },
    { title: "x".repeat(121) },
    { passcode: "x".repeat(41) },
    { notes: "x".repeat(1001) },
  ])
    failure(
      await h.admin(
        "admin/save-live-session",
        { id: "b".repeat(32), revision: null, value: { ...value, ...invalid } },
        instructor,
      ),
      "VALIDATION",
    );
  failure(
    await h.admin(
      "admin/save-live-session",
      {
        id: "c".repeat(32),
        revision: null,
        value: { ...value, courseId: "missing" },
      },
      owner,
    ),
    "NOT_FOUND",
  );
  const updated = data<LiveSession>(
    await h.admin(
      "admin/save-live-session",
      {
        id,
        revision: created.revision,
        value: { ...value, title: "Buổi 1" },
      },
      instructor,
    ),
  );
  failure(
    await h.admin(
      "admin/save-live-session",
      { id, revision: created.revision, value },
      instructor,
    ),
    "CONFLICT",
  );
  assert.deepEqual(
    data<LiveSession[]>(
      await h.admin("admin/live-sessions", { courseId: "free" }, owner),
    ).map((session) => session.title),
    ["Buổi 1"],
  );
  failure(
    await h.admin(
      "admin/delete-live-session",
      { id, revision: created.revision },
      instructor,
    ),
    "CONFLICT",
  );
  data(
    await h.admin(
      "admin/delete-live-session",
      { id, revision: updated.revision },
      instructor,
    ),
  );
  assert.deepEqual(
    data(await h.admin("admin/live-sessions", { courseId: "free" }, owner)),
    [],
  );
  const events = await auditEvents(h, { subjectId: id });
  assert.deepEqual(events.map((event) => event.action).sort(), [
    "live_session.create",
    "live_session.delete",
    "live_session.update",
  ]);
  const logged = JSON.stringify(events);
  assert.ok(!logged.includes("zoom.us"));
  assert.ok(!logged.includes("424242"));
});

test("join links and passcodes reach only students with access; the public page gets titles and times", async () => {
  const h = await setup();
  const now = Date.now();
  const at = (offset: number) => new Date(now + offset).toISOString();
  const HOUR = 60 * 60 * 1000;
  const sessions = [
    ["1", "free", "Long gone", at(-4 * HOUR)],
    ["2", "free", "Just ended", at(-2 * HOUR)],
    ["3", "free", "Next week", at(7 * 24 * HOUR)],
    ["4", "invite", "Cohort call", at(24 * HOUR)],
  ] as const;
  for (const [n, courseId, title, startsAt] of sessions)
    data(
      await h.admin(
        "admin/save-live-session",
        {
          id: n.repeat(32),
          revision: null,
          value: {
            courseId,
            title,
            startsAt,
            durationMinutes: 60,
            joinUrl: `https://zoom.us/j/${n}0000`,
            passcode: `pass-${n}`,
            notes: "",
          },
        },
        owner,
      ),
    );
  const catalog = data<CourseSummary[]>(await h.catalog());
  const free = catalog.find((item) => item.id === "free")!;
  assert.deepEqual(free.upcomingSessions, [
    {
      id: "3".repeat(32),
      title: "Next week",
      startsAt: sessions[2][3],
      durationMinutes: 60,
    },
  ]);
  const publicText = JSON.stringify(catalog);
  assert.ok(!publicText.includes("zoom.us"));
  assert.ok(!publicText.includes("pass-"));
  assert.ok(!catalog.some((item) => item.id === "draft"));

  const { token } = await h.signIn("learner@example.com");
  for (const courseId of ["free", "invite"]) {
    const denied = await h.student("classroom", { courseId }, token);
    failure(denied, "ACCESS_ENDED");
    assert.ok(!JSON.stringify(denied).includes("zoom.us"));
  }
  data(await h.student("join", { courseId: "free" }, token));
  const state = data<LearningState>(
    await h.student("classroom", { courseId: "free" }, token),
  );
  assert.deepEqual(
    state.liveSessions?.map((session) => [
      session.title,
      session.joinUrl,
      session.passcode,
    ]),
    [
      ["Just ended", "https://zoom.us/j/20000", "pass-2"],
      ["Next week", "https://zoom.us/j/30000", "pass-3"],
    ],
  );
  assert.ok(!JSON.stringify(state).includes("pass-4"));
});

test("a student whose manual or invite grant was revoked cannot start the course again, even after it opens", async () => {
  const h = await setup();
  const grant = async (email: string, courseId: string) =>
    data<{ entitlement: EntitlementView }>(
      await h.admin(
        "admin/grant",
        {
          studentEmail: email,
          studentName: "Learner",
          courseId,
          expiresAt: null,
          source: "manual",
          requestKey: crypto.randomUUID(),
          confirmation: email,
          reason: "Manual access for testing",
        },
        owner,
      ),
    ).entitlement;
  const revoke = async (entitlementId: string, email: string) =>
    data(
      await h.admin(
        "admin/revoke-entitlement",
        {
          entitlementId,
          confirmation: email,
          reason: "Access removed by staff",
        },
        owner,
      ),
    );

  // Revoked manual grant on an open course.
  const manual = await h.signIn("manual@example.com");
  await revoke(
    (await grant("manual@example.com", "free")).id,
    "manual@example.com",
  );
  failure(
    await h.student("join", { courseId: "free" }, manual.token),
    "ACCESS_ENDED",
  );
  failure(
    await h.student("classroom", { courseId: "free" }, manual.token),
    "ACCESS_ENDED",
  );

  // Revoked invitation on an open course.
  const invited = data<{ student: { id: string } }>(
    await h.admin(
      "admin/invite",
      { courseId: "free", name: "Invited", email: "invited@example.com" },
      owner,
    ),
  );
  const invitee = await h.signIn("invited@example.com");
  data(await h.admin("admin/revoke", { id: invited.student.id }, owner));
  failure(
    await h.student("join", { courseId: "free" }, invitee.token),
    "ACCESS_ENDED",
  );

  // Revoked while invite-only, then the course is opened.
  const later = await h.signIn("later@example.com");
  await revoke(
    (await grant("later@example.com", "invite")).id,
    "later@example.com",
  );
  const invite = data<CourseRecord[]>(
    await h.admin("admin/courses", {}, owner),
  ).find((record) => record.id === "invite")!;
  data(
    await h.admin(
      "admin/save-course",
      {
        id: "invite",
        revision: invite.revision,
        value: { ...invite.value, access: "open" },
        ...openConfirmation,
      },
      owner,
    ),
  );
  failure(
    await h.student("join", { courseId: "invite" }, later.token),
    "ACCESS_ENDED",
  );
  const svc = await h.services();
  for (const studentId of [
    manual.studentId,
    invitee.studentId,
    later.studentId,
  ])
    assert.ok(
      (await svc.entitlements.forStudent(studentId)).every(
        (item) => item.source !== "comp",
      ),
      "no complimentary grant was created",
    );
});

test("opening a course needs the right to grant access; closing it only needs course editing", async () => {
  const h = await setup();
  const record = async () =>
    data<CourseRecord[]>(await h.admin("admin/courses", {}, owner)).find(
      (item) => item.id === "invite",
    )!;
  const open = async (user: typeof owner) => {
    const current = await record();
    return h.admin(
      "admin/save-course",
      {
        id: "invite",
        revision: current.revision,
        value: { ...current.value, access: "open" },
        ...openConfirmation,
      },
      user,
    );
  };
  // Instructors cannot grant on this site, so they cannot open a course.
  failure(await open(otherInstructor), "FORBIDDEN_ROLE");
  assert.equal((await record()).value.access, "invite");
  // Nor create a new course that is already open.
  failure(
    await h.admin(
      "admin/save-course",
      {
        id: "new-open",
        revision: null,
        value: course("New", { access: "open" }),
        ...openConfirmation,
      },
      otherInstructor,
    ),
    "FORBIDDEN_ROLE",
  );
  // Once the site lets instructors grant, they can, for their own courses.
  const site = data<{ settings: object; revision: string | null }>(
    await h.admin("admin/site", {}, owner),
  );
  data(
    await h.admin(
      "admin/save-site",
      {
        revision: site.revision,
        value: { ...site.settings, instructorsMayGrant: true },
      },
      owner,
    ),
  );
  failure(
    await (async () => {
      const current = data<CourseRecord[]>(
        await h.admin("admin/courses", {}, owner),
      ).find((item) => item.id === "invite")!;
      return h.admin(
        "admin/save-course",
        {
          id: "invite",
          revision: current.revision,
          value: { ...current.value, access: "open" },
        },
        otherInstructor,
      );
    })(),
    "CONFIRMATION_REQUIRED",
  );
  const opened = data<CourseRecord>(await open(otherInstructor));
  assert.equal(opened.value.access, "open");
  // The instructor without grant rights on "free" may still close it.
  const free = data<CourseRecord[]>(
    await h.admin("admin/courses", {}, owner),
  ).find((item) => item.id === "free")!;
  const [teacherFree] = data<CourseRecord[]>(
    await h.admin("admin/courses", {}, instructor),
  );
  assert.equal(teacherFree!.id, "free");
  data(
    await h.admin(
      "admin/save-site",
      {
        revision: data<{ revision: string }>(
          await h.admin("admin/site", {}, owner),
        ).revision,
        value: { ...site.settings, instructorsMayGrant: false },
      },
      owner,
    ),
  );
  const closed = data<CourseRecord>(
    await h.admin(
      "admin/save-course",
      {
        id: "free",
        revision: free.revision,
        value: { ...free.value, access: "invite" },
      },
      instructor,
    ),
  );
  assert.equal(closed.value.access, "invite");
});

test("closing a course writes its access before its content; other option writes retry once", async () => {
  const h = await setup();
  const courses = h.collections.get("courses")!;
  const options = h.collections.get("courseOptions")!;
  const order: string[] = [];
  courses.beforeCas = async () => {
    order.push("course");
  };
  options.beforeCas = async () => {
    order.push("options");
  };
  const current = async () =>
    data<CourseRecord[]>(await h.admin("admin/courses", {}, owner)).find(
      (item) => item.id === "free",
    )!;
  const save = async (patch: Partial<Course>, extra: object = {}) => {
    const record = await current();
    return h.admin(
      "admin/save-course",
      {
        id: "free",
        revision: record.revision,
        value: { ...record.value, ...patch },
        ...extra,
      },
      owner,
    );
  };
  data(await save({ access: "invite" }));
  assert.deepEqual(order, ["options", "course"]);
  order.length = 0;
  data(await save({ access: "open" }, openConfirmation));
  assert.deepEqual(order, ["course", "options"]);

  // Closing: if the content write then fails, the course is still closed.
  order.length = 0;
  const record = await current();
  courses.beforeCas = async () => {
    // Another save lands between the access write and the content write.
    const row = courses.rows.get("free")!;
    courses.rows.set("free", { ...row, revision: `r${++courses.revision}` });
  };
  failure(
    await h.admin(
      "admin/save-course",
      {
        id: "free",
        revision: record.revision,
        value: { ...record.value, access: "invite", title: "Lost edit" },
      },
      owner,
    ),
    "CONFLICT",
  );
  courses.beforeCas = undefined;
  assert.equal((await current()).value.access, "invite");
  assert.equal((await current()).value.title, "Free");

  // One concurrent options write is retried; two in a row report a partial save.
  data(await save({ access: "open" }, openConfirmation));
  let interruptions = 1;
  options.beforeCas = async () => {
    if (interruptions-- <= 0) return;
    const row = options.rows.get("free")!;
    options.rows.set("free", { ...row, revision: `r${++options.revision}` });
  };
  const retried = data<CourseRecord>(
    await save({
      lessons: [
        {
          ...(await current()).value.lessons[0]!,
          resources: [{ label: "Guide", url: "https://cdn.example/a.pdf" }],
        },
      ],
    }),
  );
  assert.equal(retried.value.lessons[0]!.resources!.length, 1);
  interruptions = 2;
  failure(await save({ title: "Saved content" }), "PARTIAL_SAVE");
  options.beforeCas = undefined;
  assert.equal((await current()).value.title, "Saved content");
});
