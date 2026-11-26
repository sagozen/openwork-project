import assert from "node:assert/strict";
import test from "node:test";
import type { Course, Result } from "../src/model.js";
import { LmsService } from "../src/service.js";
import { MemoryCollection } from "./support/memory-collection.js";
import { MAX_COURSE_BYTES, MAX_SUBMISSION_BYTES } from "../src/validation.js";

function barrier(parties: number): () => Promise<void> {
  let arrived = 0;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    if (++arrived === parties) release();
    await ready;
  };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function data<T>(result: Result<T>): T {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.data;
}
function error<T>(result: Result<T>, code: string): void {
  assert.equal(result.ok, false, JSON.stringify(result));
  if (!result.ok) assert.equal(result.error.code, code);
}
function course(): Course {
  return {
    title: "A real course",
    summary: "A short introduction.",
    description: "Public description.",
    instructor: "Instructor",
    status: "published",
    lessons: ["one", "two", "three"].map((id) => ({
      id,
      title: `Lesson ${id}`,
      module: "Foundations",
      durationMinutes: 10,
      body: `Private lesson text ${id}`,
      videoUrl: "https://media.example.com/lesson.mp4?signature=private",
      resourceUrl: "https://resources.example.com/private-workbook",
      resourceLabel: "Workbook",
    })),
  };
}
function setup() {
  const storage = {
    courses: new MemoryCollection(),
    enrollments: new MemoryCollection(),
    progress: new MemoryCollection(),
    submissions: new MemoryCollection(),
    courseOptions: new MemoryCollection(),
  };
  let time = Date.parse("2026-10-18T12:00:00Z");
  const service = new LmsService(storage, () => time);
  return {
    storage,
    service,
    advance: (ms: number) => {
      time += ms;
    },
  };
}
async function enrolled() {
  const fixture = setup();
  const saved = data(
    await fixture.service.saveCourse({
      id: "course",
      revision: null,
      value: course(),
    }),
  );
  const invitation = data(
    await fixture.service.invite({
      courseId: saved.id,
      name: "Student",
      email: "Student@Example.com",
    }),
  );
  const session = data(
    await fixture.service.exchange({ token: invitation.token }),
  );
  return { ...fixture, saved, invitation, session };
}
const DAY = 24 * 60 * 60 * 1000;

test("catalog excludes drafts and projects only public fields across all pages", async () => {
  const { service, storage } = setup();
  for (let i = 0; i < 5; i++)
    data(
      await service.saveCourse({
        id: `course-${i}`,
        revision: null,
        value: course(),
      }),
    );
  data(
    await service.saveCourse({
      id: "draft",
      revision: null,
      value: { ...course(), status: "draft" },
    }),
  );
  const catalog = data(await service.catalog());
  assert.equal(catalog.length, 5);
  assert.equal(storage.courses.queryCalls, 3);
  assert.equal(catalog[0]?.lessonCount, 3);
  assert.equal(catalog[0]?.durationMinutes, 30);
  const serialized = JSON.stringify(catalog);
  for (const forbidden of [
    "Private lesson text",
    "signature=private",
    "private-workbook",
    "videoUrl",
    "resourceUrl",
    "revision",
  ])
    assert.ok(!serialized.includes(forbidden));
  assert.equal(data(await service.courses({})).length, 6);
});

test("save validates publication, IDs, duplicate lessons, URLs and payload bytes", async () => {
  const { service } = setup();
  const invalid: unknown[] = [
    { ...course(), lessons: [] },
    { ...course(), title: " " },
    { ...course(), instructor: "" },
    { ...course(), lessons: [course().lessons[0], course().lessons[0]] },
    { ...course(), lessons: [{ ...course().lessons[0], id: "../one" }] },
    {
      ...course(),
      lessons: [{ ...course().lessons[0], durationMinutes: 1.5 }],
    },
    {
      ...course(),
      lessons: [{ ...course().lessons[0], body: "", videoUrl: "" }],
    },
    { ...course(), lessons: [{ ...course().lessons[0], resourceLabel: "" }] },
    {
      ...course(),
      lessons: [{ ...course().lessons[0], videoUrl: "not a URL" }],
    },
    {
      ...course(),
      lessons: [
        { ...course().lessons[0], videoUrl: "https://example.com/watch?v=1" },
      ],
    },
    ...[
      "http://example.com/file",
      "javascript:alert(1)",
      "https://user:pass@example.com/file",
      "https:\\example.com/file",
      "https://example.com/a b",
      " https://example.com/file",
    ].map((resourceUrl) => ({
      ...course(),
      lessons: [{ ...course().lessons[0], resourceUrl }],
    })),
    { ...course(), title: "x".repeat(161) },
    { ...course(), extra: true },
    {
      ...course(),
      lessons: Array.from({ length: 101 }, (_, i) => ({
        ...course().lessons[0],
        id: `lesson-${i}`,
      })),
    },
  ];
  for (const value of invalid)
    error(
      await service.saveCourse({ id: "course", revision: null, value }),
      "VALIDATION",
    );
  for (const id of [
    "",
    "../course",
    "space id",
    "id\n",
    "id\r\n",
    "x".repeat(81),
  ])
    error(
      await service.saveCourse({ id, revision: null, value: course() }),
      "VALIDATION",
    );
  const huge = {
    ...course(),
    lessons: Array.from({ length: 30 }, (_, i) => ({
      ...course().lessons[0],
      id: `lesson-${i}`,
      body: "界".repeat(20000),
    })),
  };
  assert.ok(
    new TextEncoder().encode(JSON.stringify(huge)).byteLength >
      MAX_COURSE_BYTES,
  );
  error(
    await service.saveCourse({ id: "large", revision: null, value: huge }),
    "VALIDATION",
  );
  data(
    await service.saveCourse({
      id: "draft",
      revision: null,
      value: {
        ...course(),
        status: "draft",
        title: "",
        summary: "",
        instructor: "",
        lessons: [],
      },
    }),
  );
  data(
    await service.saveCourse({ id: "valid", revision: null, value: course() }),
  );
});

test("course revision is opaque and concurrent edits cannot overwrite each other", async () => {
  const { service, storage } = setup();
  const saved = data(
    await service.saveCourse({ id: "course", revision: null, value: course() }),
  );
  storage.courses.beforeCas = barrier(2);
  const results = await Promise.all(
    ["First", "Second"].map((title) =>
      service.saveCourse({
        id: saved.id,
        revision: saved.revision,
        value: { ...course(), title },
      }),
    ),
  );
  assert.equal(results.filter((result) => result.ok).length, 1);
  error(results.find((result) => !result.ok)!, "CONFLICT");
  storage.courses.beforeCas = undefined;
  error(
    await service.saveCourse({ id: saved.id, revision: null, value: course() }),
    "CONFLICT",
  );
  error(
    await service.saveCourse({
      id: "missing",
      revision: saved.revision,
      value: course(),
    }),
    "CONFLICT",
  );
});

test("duplicate concurrent course/email invitations have exactly one enrollment", async () => {
  const { service, storage } = setup();
  data(
    await service.saveCourse({ id: "course", revision: null, value: course() }),
  );
  storage.enrollments.beforeCas = barrier(2);
  const results = await Promise.all(
    ["Student@Example.com", " student@example.com "].map((email) =>
      service.invite({ courseId: "course", name: "Student", email }),
    ),
  );
  assert.equal(results.filter((result) => result.ok).length, 1);
  error(results.find((result) => !result.ok)!, "CONFLICT");
  assert.equal(storage.enrollments.rows.size, 1);
});

test("single-use invitation exchange is one atomic winner and stores no plaintext tokens", async () => {
  const { service, storage } = setup();
  data(
    await service.saveCourse({ id: "course", revision: null, value: course() }),
  );
  const invitation = data(
    await service.invite({
      courseId: "course",
      name: "Student",
      email: "student@example.com",
    }),
  );
  storage.enrollments.beforeCas = barrier(2);
  const results = await Promise.all([
    service.exchange({ token: invitation.token }),
    service.exchange({ token: invitation.token }),
  ]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  error(results.find((result) => !result.ok)!, "INVALID_INVITATION");
  const session = data(results.find((result) => result.ok)!);
  const persisted = JSON.stringify([...storage.enrollments.rows.values()]);
  assert.ok(!persisted.includes(invitation.token.split(".")[1]!));
  assert.ok(!persisted.includes(session.sessionToken.split(".")[1]!));
  assert.ok(
    !JSON.stringify(
      data(await service.library({}, session.sessionToken)),
    ).includes("sessionHash"),
  );
  storage.enrollments.beforeCas = undefined;
  error(
    await service.exchange({ token: invitation.token }),
    "INVALID_INVITATION",
  );
});

test("invitation expires exactly at seven days and session exactly at thirty days", async () => {
  const first = setup();
  data(
    await first.service.saveCourse({
      id: "course",
      revision: null,
      value: course(),
    }),
  );
  const invitation = data(
    await first.service.invite({
      courseId: "course",
      name: "Student",
      email: "s@example.com",
    }),
  );
  first.advance(7 * DAY);
  error(
    await first.service.exchange({ token: invitation.token }),
    "INVALID_INVITATION",
  );
  const second = await enrolled();
  second.advance(30 * DAY - 1);
  data(await second.service.library({}, second.session.sessionToken));
  second.advance(1);
  error(
    await second.service.library({}, second.session.sessionToken),
    "ACCESS_DENIED",
  );
  error(
    await second.service.complete(
      { lessonId: "one", completed: true },
      second.session.sessionToken,
    ),
    "ACCESS_DENIED",
  );
});

test("rotation invalidates old invitations and sessions while preserving progress and enrollment identity", async () => {
  const { service, invitation, session } = await enrolled();
  data(
    await service.complete(
      { lessonId: "one", completed: true },
      session.sessionToken,
    ),
  );
  const rotated = data(
    await service.invite({
      courseId: "course",
      name: "New name",
      email: "STUDENT@example.com",
    }),
  );
  assert.equal(rotated.student.id, invitation.student.id);
  assert.deepEqual(rotated.student.completedLessonIds, ["one"]);
  error(await service.library({}, session.sessionToken), "ACCESS_DENIED");
  error(
    await service.exchange({ token: invitation.token }),
    "INVALID_INVITATION",
  );
  const next = data(await service.exchange({ token: rotated.token }));
  data(await service.logout({}, session.sessionToken));
  const state = data(await service.library({}, next.sessionToken));
  assert.deepEqual(state.completedLessonIds, ["one"]);
  assert.equal(state.student.name, "New name");
  data(await service.logout({}, next.sessionToken));
  error(await service.library({}, next.sessionToken), "ACCESS_DENIED");
});

test("logout is idempotent for missing, malformed, unknown and revoked sessions", async () => {
  const { service, invitation, session } = await enrolled();
  for (const token of [
    null,
    "",
    "malformed",
    `${"a".repeat(64)}.${"b".repeat(64)}`,
  ]) {
    assert.deepEqual(data(await service.logout({}, token)), {
      loggedOut: true,
    });
  }
  data(await service.revoke({ id: invitation.student.id }));
  assert.deepEqual(data(await service.logout({}, session.sessionToken)), {
    loggedOut: true,
  });
});

test("per-course invitations never grant access to another course or its lesson IDs", async () => {
  const { service, session } = await enrolled();
  data(
    await service.saveCourse({
      id: "other-course",
      revision: null,
      value: {
        ...course(),
        lessons: [{ ...course().lessons[0]!, id: "other-lesson" }],
      },
    }),
  );
  const other = data(
    await service.invite({
      courseId: "other-course",
      name: "Student",
      email: "student@example.com",
    }),
  );
  const otherSession = data(await service.exchange({ token: other.token }));
  assert.notEqual(
    otherSession.sessionToken.slice(0, 64),
    session.sessionToken.slice(0, 64),
  );
  error(
    await service.complete(
      { lessonId: "other-lesson", completed: true },
      session.sessionToken,
    ),
    "NOT_FOUND",
  );
  assert.equal(
    data(await service.library({}, session.sessionToken)).course.id,
    "course",
  );
  assert.equal(
    data(await service.library({}, otherSession.sessionToken)).course.id,
    "other-course",
  );
  error(
    await service.library({ courseId: "other-course" }, session.sessionToken),
    "VALIDATION",
  );
});

test("revocation blocks sessions, unused invitations and future completion without deleting progress", async () => {
  const { service, session, invitation, storage } = await enrolled();
  data(
    await service.complete(
      { lessonId: "one", completed: true },
      session.sessionToken,
    ),
  );
  data(await service.revoke({ id: invitation.student.id }));
  error(await service.library({}, session.sessionToken), "ACCESS_DENIED");
  error(
    await service.complete(
      { lessonId: "two", completed: true },
      session.sessionToken,
    ),
    "ACCESS_DENIED",
  );
  assert.equal(storage.progress.rows.size, 1);
  const renewed = data(
    await service.invite({
      courseId: "course",
      name: "Student",
      email: "student@example.com",
    }),
  );
  assert.deepEqual(renewed.student.completedLessonIds, ["one"]);
  data(await service.revoke({ id: renewed.student.id }));
  error(await service.exchange({ token: renewed.token }), "INVALID_INVITATION");
});

test("unpublishing blocks library, completion and exchange; removed lessons disappear from progress view", async () => {
  const { service, session, saved } = await enrolled();
  data(
    await service.complete(
      { lessonId: "one", completed: true },
      session.sessionToken,
    ),
  );
  const draft = data(
    await service.saveCourse({
      id: saved.id,
      revision: saved.revision,
      value: { ...saved.value, status: "draft" },
    }),
  );
  error(await service.library({}, session.sessionToken), "ACCESS_DENIED");
  error(
    await service.complete(
      { lessonId: "two", completed: true },
      session.sessionToken,
    ),
    "ACCESS_DENIED",
  );
  const invitation = data(
    await service.invite({
      courseId: saved.id,
      name: "Other student",
      email: "other@example.com",
    }),
  );
  error(await service.exchange({ token: invitation.token }), "ACCESS_DENIED");
  data(
    await service.saveCourse({
      id: saved.id,
      revision: draft.revision,
      value: { ...saved.value, lessons: saved.value.lessons.slice(1) },
    }),
  );
  assert.deepEqual(
    data(await service.library({}, session.sessionToken)).completedLessonIds,
    [],
  );
  data(await service.exchange({ token: invitation.token }));
});

test("parallel independent lesson completions survive and can be unmarked", async () => {
  const { service, session, storage } = await enrolled();
  storage.progress.beforePut = barrier(3);
  const completions = await Promise.all(
    ["one", "two", "three"].map((lessonId) =>
      service.complete({ lessonId, completed: true }, session.sessionToken),
    ),
  );
  completions.forEach(data);
  assert.deepEqual(
    data(await service.library({}, session.sessionToken)).completedLessonIds,
    ["one", "two", "three"],
  );
  storage.progress.beforePut = undefined;
  assert.deepEqual(
    data(
      await service.complete(
        { lessonId: "two", completed: false },
        session.sessionToken,
      ),
    ).completedLessonIds,
    ["one", "three"],
  );
  assert.equal(storage.progress.rows.size, 3);
});

test("revocation racing invitation exchange wins over the stale CAS", async () => {
  const { service, storage } = setup();
  data(
    await service.saveCourse({ id: "course", revision: null, value: course() }),
  );
  const invitation = data(
    await service.invite({
      courseId: "course",
      name: "Student",
      email: "student@example.com",
    }),
  );
  const entered = deferred();
  const release = deferred();
  storage.enrollments.beforeCas = async () => {
    entered.resolve();
    await release.promise;
  };
  const exchange = service.exchange({ token: invitation.token });
  await entered.promise;
  data(await service.revoke({ id: invitation.student.id }));
  release.resolve();
  error(await exchange, "INVALID_INVITATION");
});

test("library rechecks authorization after its progress read before returning private content", async () => {
  const { service, storage, session, invitation } = await enrolled();
  const entered = deferred();
  const release = deferred();
  storage.progress.beforeQuery = async () => {
    entered.resolve();
    await release.promise;
  };
  const request = service.library({}, session.sessionToken);
  await entered.promise;
  data(await service.revoke({ id: invitation.student.id }));
  release.resolve();
  error(await request, "ACCESS_DENIED");
});

test("students pagination, views and activity never leak credential fields", async () => {
  const { service, storage } = setup();
  data(
    await service.saveCourse({ id: "course", revision: null, value: course() }),
  );
  for (let i = 0; i < 5; i++)
    data(
      await service.invite({
        courseId: "course",
        name: `Student ${i}`,
        email: `student${i}@example.com`,
      }),
    );
  const students = data(await service.students({ courseId: "course" }));
  assert.equal(students.length, 5);
  assert.equal(storage.enrollments.queryCalls, 3);
  const serialized = JSON.stringify(students);
  for (const key of [
    "invitationHash",
    "sessionHash",
    "generation",
    "sessionExpiresAt",
  ])
    assert.ok(!serialized.includes(key));
});

test("missing, malformed, oversized inputs and internal storage failures yield safe errors", async () => {
  const { service, storage, session } = await enrolled();
  error(await service.library({}, null), "ACCESS_DENIED");
  error(
    await service.library({}, `${"a".repeat(64)}.${"b".repeat(64)}`),
    "ACCESS_DENIED",
  );
  error(await service.exchange({ token: "invalid" }), "VALIDATION");
  error(
    await service.complete(
      { lessonId: "one", completed: "true" },
      session.sessionToken,
    ),
    "VALIDATION",
  );
  error(
    await service.invite({
      courseId: "course",
      name: "",
      email: "not-an-email",
    }),
    "VALIDATION",
  );
  error(await service.revoke({ id: "../student" }), "VALIDATION");
  error(await service.students({ courseId: "missing" }), "NOT_FOUND");
  error(await service.courses({ unexpected: "x".repeat(5000) }), "VALIDATION");
  storage.courses.beforeQuery = async () => {
    throw new Error("SQL failure password=secret token=private");
  };
  const failed = await service.catalog();
  error(failed, "INTERNAL");
  assert.ok(!JSON.stringify(failed).includes("password"));
  assert.ok(!JSON.stringify(failed).includes("SQL"));
});

test("legacy and unknown record versions fail closed without being overwritten", async () => {
  const { service, storage, saved, session, invitation } = await enrolled();
  await storage.courses.put("legacy", { ...course(), status: "published" });
  await storage.courses.put("future", { schemaVersion: 2, course: course() });
  assert.deepEqual(
    data(await service.catalog()).map((value) => value.id),
    [saved.id],
  );
  error(await service.courses({}), "UNSUPPORTED_RECORD");
  const future = await storage.courses.getVersioned("future");
  error(
    await service.saveCourse({
      id: "future",
      revision: future!.revision,
      value: course(),
    }),
    "UNSUPPORTED_RECORD",
  );
  const enrollment = storage.enrollments.rows.get(invitation.student.id)!;
  await storage.enrollments.put(invitation.student.id, {
    ...(enrollment.value as Record<string, unknown>),
    schemaVersion: 2,
  });
  error(await service.library({}, session.sessionToken), "UNSUPPORTED_RECORD");
  error(
    await service.invite({
      courseId: "course",
      name: "Student",
      email: "student@example.com",
    }),
    "UNSUPPORTED_RECORD",
  );
  assert.equal(
    (
      storage.enrollments.rows.get(invitation.student.id)!.value as Record<
        string,
        unknown
      >
    ).schemaVersion,
    2,
  );
});

test("rotation racing a pending exchange fences the old invitation generation", async () => {
  const { service, storage } = setup();
  data(
    await service.saveCourse({ id: "course", revision: null, value: course() }),
  );
  const first = data(
    await service.invite({
      courseId: "course",
      name: "Student",
      email: "student@example.com",
    }),
  );
  const entered = deferred();
  const release = deferred();
  storage.enrollments.beforeCas = async () => {
    entered.resolve();
    await release.promise;
  };
  const pending = service.exchange({ token: first.token });
  await entered.promise;
  storage.enrollments.beforeCas = undefined;
  const next = data(
    await service.invite({
      courseId: "course",
      name: "Student",
      email: "student@example.com",
    }),
  );
  release.resolve();
  error(await pending, "INVALID_INVITATION");
  data(await service.exchange({ token: next.token }));
});

test("an overlapping revocation prevents completion from returning private content", async () => {
  const { service, storage, session, invitation } = await enrolled();
  const entered = deferred();
  const release = deferred();
  storage.progress.beforePut = async () => {
    entered.resolve();
    await release.promise;
  };
  const pending = service.complete(
    { lessonId: "one", completed: true },
    session.sessionToken,
  );
  await entered.promise;
  data(await service.revoke({ id: invitation.student.id }));
  release.resolve();
  error(await pending, "ACCESS_DENIED");
  error(await service.library({}, session.sessionToken), "ACCESS_DENIED");
});

test("session generation mismatch fails closed even if its stored token hash still matches", async () => {
  const { service, storage, session, invitation } = await enrolled();
  const row = storage.enrollments.rows.get(invitation.student.id)!;
  const enrollment = row.value as Record<string, unknown>;
  const generation =
    enrollment.generation === "a".repeat(64) ? "b".repeat(64) : "a".repeat(64);
  await storage.enrollments.put(invitation.student.id, {
    ...enrollment,
    generation,
  });
  error(await service.library({}, session.sessionToken), "ACCESS_DENIED");
});

test("assignment state loop preserves progress and lets only instructors reopen accepted work", async () => {
  const { service, session, storage, advance, invitation } = await enrolled();
  const token = session.sessionToken;
  assert.deepEqual(data(await service.library({}, token)).submissions, []);
  data(await service.complete({ lessonId: "two", completed: true }, token));
  const initial = data(
    await service.submit(
      {
        lessonId: "one",
        revision: null,
        kind: "text",
        content: "  My first answer  ",
      },
      token,
    ),
  );
  assert.deepEqual(initial.completedLessonIds, ["two"]);
  const first = initial.submissions[0]!;
  assert.deepEqual(first, {
    id: first.id,
    revision: first.revision,
    courseId: "course",
    lessonId: "one",
    kind: "text",
    content: "My first answer",
    status: "submitted",
    attempt: 1,
    submittedAt: "2026-10-18T12:00:00.000Z",
    feedback: "",
    reviewedAt: null,
  });
  assert.match(first.id, /^[a-f0-9]{64}$/);
  assert.deepEqual(data(await service.submissions({ courseId: "course" })), [
    {
      ...first,
      lessonTitle: "Lesson one",
      student: {
        id: invitation.student.id,
        name: "Student",
        email: "student@example.com",
        active: true,
      },
    },
  ]);
  advance(1000);
  const revision = data(
    await service.reviewSubmission({
      courseId: "course",
      id: first.id,
      revision: first.revision,
      status: "needs_revision",
      feedback: "  Explain your reasoning.  ",
    }),
  );
  assert.equal(revision.status, "needs_revision");
  assert.equal(revision.feedback, "Explain your reasoning.");
  assert.equal(revision.reviewedAt, "2026-10-18T12:00:01.000Z");
  assert.equal(revision.attempt, 1);
  assert.deepEqual(data(await service.library({}, token)).submissions, [
    revision,
  ]);
  advance(1000);
  const second = data(
    await service.submit(
      {
        lessonId: "one",
        revision: revision.revision,
        kind: "url",
        content: "https://work.example.com/answer?version=2",
      },
      token,
    ),
  ).submissions[0]!;
  assert.equal(second.id, first.id);
  assert.equal(second.attempt, 2);
  assert.equal(second.status, "submitted");
  assert.equal(second.feedback, "");
  assert.equal(second.reviewedAt, null);
  assert.equal(second.submittedAt, "2026-10-18T12:00:02.000Z");
  assert.equal(second.kind, "url");
  const accepted = data(
    await service.reviewSubmission({
      courseId: "course",
      id: second.id,
      revision: second.revision,
      status: "accepted",
      feedback: "",
    }),
  );
  const acceptedRows = structuredClone(storage.submissions.rows);
  error(
    await service.submit(
      {
        lessonId: "one",
        revision: accepted.revision,
        kind: "text",
        content: "Replace accepted work",
      },
      token,
    ),
    "ACCESS_DENIED",
  );
  assert.deepEqual(storage.submissions.rows, acceptedRows);
  assert.deepEqual(
    data(await service.complete({ lessonId: "two", completed: true }, token))
      .submissions,
    [accepted],
  );
  const reopened = data(
    await service.reviewSubmission({
      courseId: "course",
      id: accepted.id,
      revision: accepted.revision,
      status: "needs_revision",
      feedback: "Please add a source.",
    }),
  );
  const third = data(
    await service.submit(
      {
        lessonId: "one",
        revision: reopened.revision,
        kind: "text",
        content: "Added the source.",
      },
      token,
    ),
  ).submissions[0]!;
  assert.equal(third.attempt, 3);
  assert.equal(third.feedback, "");
  assert.equal(third.reviewedAt, null);
  assert.equal(storage.submissions.rows.size, 1);
  // Completion remains independent; submissions never mark another lesson complete.
  assert.deepEqual(data(await service.library({}, token)).completedLessonIds, [
    "two",
  ]);
});

test("submission and review validation rejects unknown fields, unsafe links and overlimits without writes", async () => {
  const { service, session, storage } = await enrolled();
  const valid = {
    lessonId: "one",
    revision: null,
    kind: "text",
    content: "Answer",
  };
  const invalid: unknown[] = [
    undefined,
    null,
    [],
    {},
    { ...valid, lessonId: "../one" },
    { ...valid, revision: "" },
    { ...valid, revision: 1 },
    { ...valid, revision: "x".repeat(513) },
    { ...valid, kind: "file" },
    { ...valid, content: "" },
    { ...valid, content: " \n\t " },
    { ...valid, content: "a".repeat(4001) },
    { ...valid, content: "bad\u0000content" },
    { ...valid, content: "a".repeat(MAX_SUBMISSION_BYTES) },
    ...[
      "courseId",
      "enrollmentId",
      "id",
      "status",
      "feedback",
      "attempt",
      "reviewedAt",
    ].map((key) => ({ ...valid, [key]: "injected" })),
    ...[
      "",
      "http://example.com",
      "javascript:alert(1)",
      "//example.com",
      "https://user:password@example.com",
      "https://user@example.com",
      "https://example.com/a b",
      " https://example.com",
      "https://example.com\n",
      "https://example.com/\u0000",
      "https://example.com/\u0085",
      "https://example.com/\u009f",
      "https://example.com\\evil",
      "https://example.com/%xx",
      "https://",
      `https://example.com/${"a".repeat(2048)}`,
    ].map((content) => ({ ...valid, kind: "url", content })),
  ];
  for (const request of invalid)
    error(await service.submit(request, session.sessionToken), "VALIDATION");
  assert.equal(storage.submissions.rows.size, 0);
  const submitted = data(
    await service.submit(
      {
        ...valid,
        content: "a".repeat(4000),
      },
      session.sessionToken,
    ),
  ).submissions[0]!;
  assert.equal(submitted.content.length, 4000);
  const review = {
    courseId: "course",
    id: submitted.id,
    revision: submitted.revision,
    status: "needs_revision",
    feedback: "Reason",
  };
  const before = structuredClone(storage.submissions.rows);
  for (const request of [
    { ...review, feedback: "" },
    { ...review, feedback: " \n " },
    { ...review, feedback: "x".repeat(4001) },
    { ...review, feedback: "x".repeat(MAX_SUBMISSION_BYTES) },
    { ...review, feedback: "bad\u0000feedback" },
    { ...review, status: "submitted" },
    { ...review, revision: null },
    { ...review, id: "../submission" },
    { ...review, enrollmentId: "other" },
    { ...review, content: "instructor overwrote work" },
  ])
    error(await service.reviewSubmission(request), "VALIDATION");
  assert.deepEqual(storage.submissions.rows, before);
  error(
    await service.submissions({ courseId: "course", enrollmentId: "other" }),
    "VALIDATION",
  );
  const reviewed = data(
    await service.reviewSubmission({ ...review, feedback: "f".repeat(4000) }),
  );
  assert.equal(reviewed.feedback.length, 4000);
});

test("student sessions isolate submissions and instructor reviews cannot cross courses", async () => {
  const { service, session, storage } = await enrolled();
  const token = session.sessionToken;
  assert.equal(
    data(await service.library({}, token)).enrollmentId,
    token.slice(0, 64),
  );
  const first = data(
    await service.submit(
      {
        lessonId: "one",
        revision: null,
        kind: "text",
        content: "Private first student answer",
      },
      token,
    ),
  ).submissions[0]!;
  const invitation = data(
    await service.invite({
      courseId: "course",
      name: "Other Student",
      email: "other@example.com",
    }),
  );
  const other = data(await service.exchange({ token: invitation.token }));
  const otherState = data(await service.library({}, other.sessionToken));
  assert.deepEqual(otherState.submissions, []);
  assert.equal(otherState.enrollmentId, invitation.student.id);
  assert.notEqual(otherState.enrollmentId, token.slice(0, 64));
  error(
    await service.submit(
      {
        lessonId: "one",
        revision: first.revision,
        kind: "text",
        content: "Overwrite another student",
      },
      other.sessionToken,
    ),
    "CONFLICT",
  );
  const second = data(
    await service.submit(
      {
        lessonId: "one",
        revision: null,
        kind: "text",
        content: "Private second student answer",
      },
      other.sessionToken,
    ),
  ).submissions[0]!;
  assert.notEqual(second.id, first.id);
  assert.deepEqual(data(await service.library({}, token)).submissions, [first]);
  assert.deepEqual(
    data(await service.library({}, other.sessionToken)).submissions,
    [second],
  );
  data(
    await service.saveCourse({
      id: "other-course",
      revision: null,
      value: {
        ...course(),
        lessons: [{ ...course().lessons[0]!, id: "other-lesson" }],
      },
    }),
  );
  const before = structuredClone(storage.submissions.rows);
  error(
    await service.submit(
      {
        lessonId: "other-lesson",
        revision: null,
        kind: "text",
        content: "Wrong course",
      },
      token,
    ),
    "NOT_FOUND",
  );
  error(
    await service.reviewSubmission({
      courseId: "other-course",
      id: first.id,
      revision: first.revision,
      status: "accepted",
      feedback: "",
    }),
    "NOT_FOUND",
  );
  for (const credential of [
    null,
    "",
    "invalid",
    `${"a".repeat(64)}.${"b".repeat(64)}`,
  ])
    error(
      await service.submit(
        {
          lessonId: "two",
          revision: null,
          kind: "text",
          content: "Anonymous",
        },
        credential,
      ),
      "ACCESS_DENIED",
    );
  assert.deepEqual(storage.submissions.rows, before);
  assert.deepEqual(
    data(await service.submissions({ courseId: "other-course" })),
    [],
  );
  const list = data(await service.submissions({ courseId: "course" }));
  assert.equal(list.length, 2);
  for (const forbidden of [
    "sessionHash",
    "invitationHash",
    "generation",
    "schemaVersion",
    "enrollmentId",
  ])
    assert.ok(!JSON.stringify(list).includes(forbidden));
});

test("concurrent initial submissions have one winner and stale writes never mutate the winner", async () => {
  const { service, storage, session } = await enrolled();
  storage.submissions.beforeCas = barrier(2);
  const results = await Promise.all(
    ["A", "B"].map((content) =>
      service.submit(
        {
          lessonId: "one",
          revision: null,
          kind: "text",
          content,
        },
        session.sessionToken,
      ),
    ),
  );
  assert.equal(results.filter((result) => result.ok).length, 1);
  results
    .filter((result) => !result.ok)
    .forEach((result) => error(result, "CONFLICT"));
  storage.submissions.beforeCas = undefined;
  const first = data(await service.library({}, session.sessionToken))
    .submissions[0]!;
  assert.equal(first.attempt, 1);
  const next = data(
    await service.submit(
      {
        lessonId: "one",
        revision: first.revision,
        kind: "text",
        content: "Next",
      },
      session.sessionToken,
    ),
  ).submissions[0]!;
  const before = structuredClone(storage.submissions.rows);
  error(
    await service.submit(
      {
        lessonId: "one",
        revision: first.revision,
        kind: "text",
        content: "Stale student",
      },
      session.sessionToken,
    ),
    "CONFLICT",
  );
  error(
    await service.reviewSubmission({
      courseId: "course",
      id: first.id,
      revision: first.revision,
      status: "accepted",
      feedback: "Stale review",
    }),
    "CONFLICT",
  );
  assert.deepEqual(storage.submissions.rows, before);
  assert.equal(next.attempt, 2);
});

for (const winner of ["review", "resubmit"] as const) {
  test(`review versus resubmission CAS race preserves the ${winner} winner`, async () => {
    const { service, storage, session } = await enrolled();
    const first = data(
      await service.submit(
        {
          lessonId: "one",
          revision: null,
          kind: "text",
          content: "Original",
        },
        session.sessionToken,
      ),
    ).submissions[0]!;
    const entered = deferred();
    const release = deferred();
    storage.submissions.beforeCas = async () => {
      entered.resolve();
      await release.promise;
    };
    const review = () =>
      service.reviewSubmission({
        courseId: "course",
        id: first.id,
        revision: first.revision,
        status: "accepted",
        feedback: "Reviewed original",
      });
    const resubmit = () =>
      service.submit(
        {
          lessonId: "one",
          revision: first.revision,
          kind: "text",
          content: "Revised",
        },
        session.sessionToken,
      );
    const pending = winner === "review" ? resubmit() : review();
    await entered.promise;
    storage.submissions.beforeCas = undefined;
    if (winner === "review") data(await review());
    else data(await resubmit());
    release.resolve();
    error<unknown>(await pending, "CONFLICT");
    const final = data(await service.library({}, session.sessionToken))
      .submissions[0]!;
    assert.equal(final.status, winner === "review" ? "accepted" : "submitted");
    assert.equal(final.content, winner === "review" ? "Original" : "Revised");
    assert.equal(
      final.feedback,
      winner === "review" ? "Reviewed original" : "",
    );
    assert.equal(final.attempt, winner === "review" ? 1 : 2);
    assert.equal(final.reviewedAt === null, winner === "resubmit");
  });
}

test("concurrent instructor reviews cannot overwrite a review already saved", async () => {
  const { service, storage, session } = await enrolled();
  const first = data(
    await service.submit(
      {
        lessonId: "one",
        revision: null,
        kind: "text",
        content: "Original",
      },
      session.sessionToken,
    ),
  ).submissions[0]!;
  storage.submissions.beforeCas = barrier(2);
  const results = await Promise.all(
    (["accepted", "needs_revision"] as const).map((status) =>
      service.reviewSubmission({
        courseId: "course",
        id: first.id,
        revision: first.revision,
        status,
        feedback: status,
      }),
    ),
  );
  assert.equal(results.filter((result) => result.ok).length, 1);
  results
    .filter((result) => !result.ok)
    .forEach((result) => error(result, "CONFLICT"));
  const winning = results.find((result) => result.ok)!;
  assert.deepEqual(
    data(await service.library({}, session.sessionToken)).submissions,
    [data(winning)],
  );
});

test("version-one data, invitation rotation and fresh service instances retain submissions and progress", async () => {
  const { service, storage, session, invitation } = await enrolled();
  data(
    await service.complete(
      { lessonId: "one", completed: true },
      session.sessionToken,
    ),
  );
  const first = data(
    await service.submit(
      {
        lessonId: "two",
        revision: null,
        kind: "text",
        content: "Persistent answer",
      },
      session.sessionToken,
    ),
  ).submissions[0]!;
  const courses = structuredClone(storage.courses.rows);
  const progress = structuredClone(storage.progress.rows);
  const submissions = structuredClone(storage.submissions.rows);
  const rotated = data(
    await service.invite({
      courseId: "course",
      name: "Updated Student",
      email: "student@example.com",
    }),
  );
  assert.equal(rotated.student.id, invitation.student.id);
  error(await service.library({}, session.sessionToken), "ACCESS_DENIED");
  const newSession = data(await service.exchange({ token: rotated.token }));
  const restarted = new LmsService(storage, () =>
    Date.parse("2026-10-18T12:00:00Z"),
  );
  const state = data(await restarted.library({}, newSession.sessionToken));
  assert.deepEqual(state.submissions, [first]);
  assert.deepEqual(state.completedLessonIds, ["one"]);
  assert.equal(state.student.name, "Updated Student");
  assert.deepEqual(storage.courses.rows, courses);
  assert.deepEqual(storage.progress.rows, progress);
  assert.deepEqual(storage.submissions.rows, submissions);
  const list = data(await restarted.submissions({ courseId: "course" }));
  assert.equal(list[0]!.student.name, "Updated Student");
});

test("removed lessons hide retained submissions, cannot be reviewed, and restore by stable lesson ID", async () => {
  const { service, session, storage, saved } = await enrolled();
  const first = data(
    await service.submit(
      {
        lessonId: "one",
        revision: null,
        kind: "text",
        content: "Keep this work",
      },
      session.sessionToken,
    ),
  ).submissions[0]!;
  const before = structuredClone(storage.submissions.rows);
  const removed = data(
    await service.saveCourse({
      id: saved.id,
      revision: saved.revision,
      value: {
        ...saved.value,
        lessons: saved.value.lessons.filter((lesson) => lesson.id !== "one"),
      },
    }),
  );
  assert.deepEqual(
    data(await service.library({}, session.sessionToken)).submissions,
    [],
  );
  assert.deepEqual(data(await service.submissions({ courseId: "course" })), []);
  error(
    await service.submit(
      {
        lessonId: "one",
        revision: first.revision,
        kind: "text",
        content: "Removed lesson",
      },
      session.sessionToken,
    ),
    "NOT_FOUND",
  );
  error(
    await service.reviewSubmission({
      courseId: "course",
      id: first.id,
      revision: first.revision,
      status: "accepted",
      feedback: "",
    }),
    "NOT_FOUND",
  );
  assert.deepEqual(storage.submissions.rows, before);
  data(
    await service.saveCourse({
      id: saved.id,
      revision: removed.revision,
      value: saved.value,
    }),
  );
  assert.deepEqual(
    data(await service.library({}, session.sessionToken)).submissions,
    [first],
  );
});

test("revoked and unpublished access blocks students without restricting authorized instructor reviews", async () => {
  const { service, session, storage, saved, invitation } = await enrolled();
  const first = data(
    await service.submit(
      {
        lessonId: "one",
        revision: null,
        kind: "text",
        content: "Retained work",
      },
      session.sessionToken,
    ),
  ).submissions[0]!;
  const before = structuredClone(storage.submissions.rows);
  const review = {
    courseId: "course",
    id: first.id,
    revision: first.revision,
    status: "accepted",
    feedback: "",
  };
  const draft = data(
    await service.saveCourse({
      id: saved.id,
      revision: saved.revision,
      value: { ...saved.value, status: "draft" },
    }),
  );
  error(
    await service.submit(
      {
        lessonId: "one",
        revision: first.revision,
        kind: "text",
        content: "Draft",
      },
      session.sessionToken,
    ),
    "ACCESS_DENIED",
  );
  assert.deepEqual(storage.submissions.rows, before);
  const accepted = data(await service.reviewSubmission(review));
  assert.equal(accepted.status, "accepted");
  error(await service.library({}, session.sessionToken), "ACCESS_DENIED");
  data(
    await service.saveCourse({
      id: saved.id,
      revision: draft.revision,
      value: saved.value,
    }),
  );
  data(await service.revoke({ id: invitation.student.id }));
  error(
    await service.submit(
      {
        lessonId: "one",
        revision: first.revision,
        kind: "text",
        content: "Revoked",
      },
      session.sessionToken,
    ),
    "ACCESS_DENIED",
  );
  const reopened = data(
    await service.reviewSubmission({
      ...review,
      revision: accepted.revision,
      status: "needs_revision",
      feedback: "Add a source.",
    }),
  );
  assert.equal(reopened.status, "needs_revision");
  const listed = data(await service.submissions({ courseId: "course" }))[0]!;
  assert.equal(listed.student.active, false);
  assert.equal(listed.feedback, "Add a source.");
  error(await service.library({}, session.sessionToken), "ACCESS_DENIED");
});

test("submission mutation rechecks access and current lessons after reading previous work", async () => {
  for (const change of ["revoke", "remove", "unpublish"] as const) {
    const { service, session, storage, saved, invitation } = await enrolled();
    const entered = deferred();
    const release = deferred();
    storage.submissions.beforeGet = async () => {
      entered.resolve();
      await release.promise;
    };
    const pending = service.submit(
      {
        lessonId: "one",
        revision: null,
        kind: "text",
        content: "Must not be saved",
      },
      session.sessionToken,
    );
    await entered.promise;
    if (change === "revoke")
      data(await service.revoke({ id: invitation.student.id }));
    else
      data(
        await service.saveCourse({
          id: saved.id,
          revision: saved.revision,
          value:
            change === "remove"
              ? {
                  ...saved.value,
                  lessons: saved.value.lessons.filter(
                    (lesson) => lesson.id !== "one",
                  ),
                }
              : { ...saved.value, status: "draft" },
        }),
      );
    release.resolve();
    error(await pending, change === "remove" ? "NOT_FOUND" : "ACCESS_DENIED");
    assert.equal(storage.submissions.rows.size, 0);
  }
});

test("library and submit do not return private work after revocation during submission reads", async () => {
  for (const action of ["library", "submit"] as const) {
    const { service, session, storage, invitation } = await enrolled();
    const entered = deferred();
    const release = deferred();
    storage.submissions.beforeQuery = async () => {
      entered.resolve();
      await release.promise;
    };
    const pending =
      action === "library"
        ? service.library({}, session.sessionToken)
        : service.submit(
            {
              lessonId: "one",
              revision: null,
              kind: "text",
              content: "Private",
            },
            session.sessionToken,
          );
    await entered.promise;
    data(await service.revoke({ id: invitation.student.id }));
    release.resolve();
    error(await pending, "ACCESS_DENIED");
  }
});

test("malformed submission keys, owners and record versions fail closed without overwrite", async () => {
  for (const corruption of [
    "key",
    "owner",
    "course",
    "version",
    "missing-owner",
    "owner-course",
    "owner-email",
  ] as const) {
    const { service, session, storage, invitation } = await enrolled();
    const first = data(
      await service.submit(
        {
          lessonId: "one",
          revision: null,
          kind: "text",
          content: "Original",
        },
        session.sessionToken,
      ),
    ).submissions[0]!;
    const row = storage.submissions.rows.get(first.id)!;
    const value = row.value as Record<string, unknown>;
    if (corruption === "key") {
      storage.submissions.rows.delete(first.id);
      await storage.submissions.put("f".repeat(64), value);
    } else if (corruption === "missing-owner") {
      storage.enrollments.rows.delete(invitation.student.id);
    } else if (corruption === "owner-course" || corruption === "owner-email") {
      const owner = storage.enrollments.rows.get(invitation.student.id)!;
      await storage.enrollments.put(invitation.student.id, {
        ...(owner.value as Record<string, unknown>),
        ...(corruption === "owner-course"
          ? { courseId: "elsewhere" }
          : { email: "forged@example.com" }),
      });
    } else {
      await storage.submissions.put(first.id, {
        ...value,
        ...(corruption === "owner"
          ? { enrollmentId: "a".repeat(64) }
          : corruption === "course"
            ? { courseId: "elsewhere" }
            : { schemaVersion: 2 }),
      });
    }
    const before = structuredClone(storage.submissions.rows);
    if (corruption !== "course")
      error(
        await service.submissions({ courseId: "course" }),
        "UNSUPPORTED_RECORD",
      );
    if (
      corruption === "owner" ||
      corruption === "course" ||
      corruption === "version"
    ) {
      error(
        await service.submit(
          {
            lessonId: "one",
            revision: storage.submissions.rows.get(first.id)!.revision,
            kind: "text",
            content: "Overwrite corrupt data",
          },
          session.sessionToken,
        ),
        "UNSUPPORTED_RECORD",
      );
    }
    if (
      corruption === "key" ||
      corruption === "course" ||
      corruption === "version"
    )
      error(
        await service.library({}, session.sessionToken),
        "UNSUPPORTED_RECORD",
      );
    assert.deepEqual(storage.submissions.rows, before);
  }
});

test("assignment lists paginate and progress completion returns every current submission", async () => {
  const { service, storage, session } = await enrolled();
  for (const lessonId of ["one", "two", "three"])
    data(
      await service.submit(
        {
          lessonId,
          revision: null,
          kind: "text",
          content: `Answer ${lessonId}`,
        },
        session.sessionToken,
      ),
    );
  storage.submissions.queryCalls = 0;
  const list = data(await service.submissions({ courseId: "course" }));
  assert.equal(storage.submissions.queryCalls, 2);
  assert.deepEqual(
    list.map((submission) => submission.lessonId),
    ["one", "two", "three"],
  );
  const state = data(
    await service.complete(
      { lessonId: "two", completed: true },
      session.sessionToken,
    ),
  );
  assert.deepEqual(state.completedLessonIds, ["two"]);
  assert.deepEqual(
    state.submissions.map((submission) => submission.content),
    ["Answer one", "Answer two", "Answer three"],
  );
});

test("expired sessions cannot create or replace submissions", async () => {
  const { service, storage, session, advance } = await enrolled();
  const first = data(
    await service.submit(
      {
        lessonId: "one",
        revision: null,
        kind: "text",
        content: "Before expiry",
      },
      session.sessionToken,
    ),
  ).submissions[0]!;
  const before = structuredClone(storage.submissions.rows);
  advance(30 * DAY);
  for (const request of [
    {
      lessonId: "one",
      revision: first.revision,
      kind: "text",
      content: "Expired replacement",
    },
    {
      lessonId: "two",
      revision: null,
      kind: "text",
      content: "Expired creation",
    },
  ])
    error(await service.submit(request, session.sessionToken), "ACCESS_DENIED");
  assert.deepEqual(storage.submissions.rows, before);
});

test("submission storage failures produce safe errors and do not overwrite work", async () => {
  const { service, storage, session } = await enrolled();
  const first = data(
    await service.submit(
      {
        lessonId: "one",
        revision: null,
        kind: "text",
        content: "Original",
      },
      session.sessionToken,
    ),
  ).submissions[0]!;
  const before = structuredClone(storage.submissions.rows);
  storage.submissions.beforeCas = async () => {
    throw new Error("SQL credentials=secret private-data");
  };
  const submitted = await service.submit(
    {
      lessonId: "one",
      revision: first.revision,
      kind: "text",
      content: "Replacement",
    },
    session.sessionToken,
  );
  const reviewed = await service.reviewSubmission({
    courseId: "course",
    id: first.id,
    revision: first.revision,
    status: "accepted",
    feedback: "",
  });
  error(submitted, "INTERNAL");
  error(reviewed, "INTERNAL");
  assert.ok(!JSON.stringify([submitted, reviewed]).includes("credentials"));
  assert.deepEqual(storage.submissions.rows, before);
});

test("removing a lesson during submission response prevents returning its private work", async () => {
  const { service, storage, session, saved } = await enrolled();
  const entered = deferred();
  const release = deferred();
  storage.submissions.beforeQuery = async () => {
    entered.resolve();
    await release.promise;
  };
  const pending = service.submit(
    {
      lessonId: "one",
      revision: null,
      kind: "text",
      content: "Private removed work",
    },
    session.sessionToken,
  );
  await entered.promise;
  data(
    await service.saveCourse({
      id: saved.id,
      revision: saved.revision,
      value: {
        ...saved.value,
        lessons: saved.value.lessons.filter((lesson) => lesson.id !== "one"),
      },
    }),
  );
  release.resolve();
  error(await pending, "NOT_FOUND");
  // Cross-collection changes are not transactional: retain the work, but never expose it.
  assert.equal(storage.submissions.rows.size, 1);
  assert.deepEqual(
    data(await service.library({}, session.sessionToken)).submissions,
    [],
  );
});

test("account-linked version 2 enrollments keep working and keep their student link", async () => {
  const { service, storage, invitation, session } = await enrolled();
  const id = invitation.student.id;
  const studentId = "5".repeat(64);
  const row = storage.enrollments.rows.get(id)!;
  await storage.enrollments.put(id, {
    ...(row.value as Record<string, unknown>),
    schemaVersion: 2,
    studentId,
  });
  const state = data(await service.library({}, session.sessionToken));
  data(
    await service.complete(
      { lessonId: "one", completed: true },
      session.sessionToken,
    ),
  );
  data(
    await service.submit(
      { lessonId: "one", revision: null, kind: "text", content: "My work" },
      session.sessionToken,
    ),
  );
  assert.equal(
    data(await service.submissions({ courseId: "course" })).length,
    1,
  );
  assert.equal(state.enrollmentId, id);
  // Reissue keeps the account link instead of downgrading to version 1.
  const reissued = data(
    await service.invite({
      courseId: "course",
      name: "Student",
      email: "student@example.com",
    }),
  );
  const stored = storage.enrollments.rows.get(id)!.value as Record<
    string,
    unknown
  >;
  assert.equal(stored.schemaVersion, 2);
  assert.equal(stored.studentId, studentId);
  const next = data(await service.exchange({ token: reissued.token }));
  data(await service.logout({}, next.sessionToken));
  error(await service.library({}, next.sessionToken), "ACCESS_DENIED");
  data(await service.revoke({ id }));
  assert.equal(
    (storage.enrollments.rows.get(id)!.value as { active: boolean }).active,
    false,
  );
});

test("an account enrollment without an invitation cannot be exchanged", async () => {
  const { service, storage, invitation } = await enrolled();
  const id = invitation.student.id;
  const row = storage.enrollments.rows.get(id)!;
  await storage.enrollments.put(id, {
    ...(row.value as Record<string, unknown>),
    schemaVersion: 2,
    studentId: "6".repeat(64),
    invitationExpiresAt: null,
    invitationHash: null,
  });
  error(
    await service.exchange({ token: invitation.token }),
    "INVALID_INVITATION",
  );
});

test("the classroom stays open when video settings cannot be read", async () => {
  const storage = {
    courses: new MemoryCollection(),
    enrollments: new MemoryCollection(),
    progress: new MemoryCollection(),
    submissions: new MemoryCollection(),
    courseOptions: new MemoryCollection(),
  };
  const service = new LmsService(storage, Date.now, async () => {
    throw new Error("Plugin secret setting was encrypted with another key");
  });
  data(
    await service.saveCourse({ id: "course", revision: null, value: course() }),
  );
  const invitation = data(
    await service.invite({
      courseId: "course",
      name: "Student",
      email: "s@example.com",
    }),
  );
  const session = data(await service.exchange({ token: invitation.token }));
  const original = console.error;
  console.error = () => {};
  try {
    const state = data(await service.library({}, session.sessionToken));
    assert.deepEqual(state.videoLessonIds, []);
    assert.equal(state.course.value.lessons.length, 3);
  } finally {
    console.error = original;
  }
});
