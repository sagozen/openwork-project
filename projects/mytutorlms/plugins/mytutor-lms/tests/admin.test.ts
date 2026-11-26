import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  Course,
  CourseRecord,
  InstructorSubmission,
  Lesson,
  StudentView,
} from "../src/model.js";
import {
  api,
  errorMessage,
  isConflict,
  progressFor,
  RequestError,
  reviewFeedback,
} from "../src/admin/api.js";
import { validateCourse } from "../src/admin/course-editor.js";

// Unit fixtures only; the workspace never seeds or displays sample personal data.
const lesson: Lesson = {
  id: "lesson-a",
  title: "Test lesson",
  module: "Test module",
  durationMinutes: 10,
  body: "Plain-text lesson content.",
  videoUrl: "",
  resourceUrl: "",
  resourceLabel: "",
};
const course: Course = {
  title: "Test course",
  summary: "Test summary",
  description: "Test description",
  instructor: "Test instructor",
  status: "published",
  lessons: [lesson],
};
const record: CourseRecord = {
  id: "course-a",
  revision: "revision-a",
  value: course,
};
const student: StudentView = {
  id: "student-a",
  courseId: "course-a",
  name: "Test student",
  email: "student@example.test",
  active: true,
  invitedAt: "2026-10-18T12:00:00.000Z",
  lastActiveAt: null,
  completedLessonIds: [],
};

// Frozen model/plan contract: progress must ignore removed and duplicate IDs.
test("progress counts only unique current lessons, not removed completions", () => {
  const value = { ...course, lessons: [lesson, { ...lesson, id: "lesson-b" }] };
  assert.deepEqual(
    progressFor(
      { ...student, completedLessonIds: ["lesson-a", "removed", "lesson-a"] },
      value,
    ),
    {
      completed: 1,
      total: 2,
      percentage: 50,
    },
  );
  assert.deepEqual(
    progressFor(
      { ...student, completedLessonIds: ["removed"] },
      { ...course, lessons: [] },
    ),
    {
      completed: 0,
      total: 0,
      percentage: 0,
    },
  );
});

test("complete text and direct-video courses can publish; incomplete drafts can save", () => {
  assert.deepEqual(validateCourse(course), {});
  assert.deepEqual(
    validateCourse({
      ...course,
      lessons: [
        {
          ...lesson,
          body: "",
          videoUrl: "https://media.example.test/lesson.mp4?signature=test",
        },
      ],
    }),
    {},
  );
  assert.deepEqual(
    validateCourse({
      title: "",
      summary: "",
      description: "",
      instructor: "",
      status: "draft",
      lessons: [],
    }),
    {},
  );
});

test("publishing rejects missing course fields; the server decides empty lesson content", () => {
  const errors = validateCourse({
    ...course,
    title: " ",
    summary: "",
    instructor: "",
    lessons: [{ ...lesson, module: "", title: "", body: "" }],
  });
  for (const key of [
    "title",
    "summary",
    "instructor",
    "lesson-lesson-a-module",
    "lesson-lesson-a-title",
  ])
    assert.ok(errors[key]);
  // A published lesson video can stand in for notes; only the server knows.
  assert.equal(errors["lesson-lesson-a-body"], undefined);
  assert.ok(validateCourse({ ...course, lessons: [] }).lessons);
});

test("media validation rejects insecure links, credentials, watch pages, and unlabeled resources", () => {
  for (const videoUrl of [
    "http://media.example.test/file.mp4",
    "https://name:secret@media.example.test/file.mp4",
    "https://www.youtube.com/watch?v=test",
    "not a URL",
  ]) {
    assert.ok(
      validateCourse({ ...course, lessons: [{ ...lesson, videoUrl }] })[
        "lesson-lesson-a-video"
      ],
    );
  }
  assert.ok(
    validateCourse({
      ...course,
      lessons: [{ ...lesson, resourceUrl: "https://example.test/resource" }],
    })["lesson-lesson-a-label"],
  );
  assert.ok(
    validateCourse({
      ...course,
      lessons: [
        {
          ...lesson,
          resourceUrl: "javascript:alert(1)",
          resourceLabel: "Workbook",
        },
      ],
    })["lesson-lesson-a-resource"],
  );
});

test("course limits and integer durations match the domain boundary", () => {
  for (const durationMinutes of [-1, 1441, 1.5, Number.NaN]) {
    assert.ok(
      validateCourse({ ...course, lessons: [{ ...lesson, durationMinutes }] })[
        "lesson-lesson-a-duration"
      ],
    );
  }
  assert.deepEqual(
    validateCourse({ ...course, lessons: [{ ...lesson, durationMinutes: 0 }] }),
    {},
  );
  assert.ok(validateCourse({ ...course, title: "x".repeat(161) }).title);
  assert.ok(
    validateCourse({
      ...course,
      lessons: Array.from({ length: 101 }, (_, index) => ({
        ...lesson,
        id: `lesson-${index}`,
      })),
    }).lessons,
  );
  assert.ok(
    validateCourse({
      ...course,
      lessons: [{ ...lesson, body: "x".repeat(20001) }],
    })["lesson-lesson-a-body"],
  );
});

test("domain conflicts preserve a typed actionable error", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      success: true,
      data: {
        ok: false,
        error: { code: "CONFLICT", message: "Reload the latest course." },
      },
    }),
  );
  await assert.rejects(
    api.save(record.id, record.revision, course),
    (error: unknown) =>
      isConflict(error) && errorMessage(error) === "Reload the latest course.",
  );
});

test("malformed data is rejected rather than being rendered as a valid course", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      success: true,
      data: { ok: true, data: [{ id: "broken" }] },
    }),
  );
  await assert.rejects(
    api.courses(),
    (error: unknown) =>
      error instanceof RequestError && error.code === "response",
  );
});

test("native authorization failures never surface raw host errors", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json(
      { success: false, error: { message: "SECRET INTERNAL STACK" } },
      { status: 403 },
    ),
  );
  await assert.rejects(
    api.courses(),
    (error: unknown) =>
      error instanceof RequestError &&
      error.code === "permission" &&
      !error.message.includes("SECRET"),
  );
  assert.equal(
    errorMessage(new Error("SECRET INTERNAL STACK")),
    "The request could not be completed. Please try again.",
  );
});

test("transport and unreadable-response failures provide safe retry feedback", async (t) => {
  const fetchMock = t.mock.method(
    globalThis,
    "fetch",
    async (): Promise<Response> => {
      throw new Error("SECRET TRANSPORT DETAILS");
    },
  );
  await assert.rejects(
    api.courses(),
    (error: unknown) =>
      error instanceof RequestError &&
      error.code === "network" &&
      !error.message.includes("SECRET"),
  );
  fetchMock.mock.mockImplementation(
    async () => new Response("<html>private stack</html>"),
  );
  await assert.rejects(
    api.courses(),
    (error: unknown) =>
      error instanceof RequestError &&
      error.code === "response" &&
      !error.message.includes("private stack"),
  );
});

test("oversized course payloads fail before a request is sent", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () =>
    Response.json({ success: true }),
  );
  await assert.rejects(
    api.save(record.id, record.revision, {
      ...course,
      description: "x".repeat(512 * 1024),
    }),
    (error: unknown) =>
      error instanceof RequestError && error.code === "VALIDATION",
  );
  assert.equal(fetchMock.mock.callCount(), 0);
});

const submission: InstructorSubmission = {
  id: "submission-a",
  revision: "submission-revision-a",
  courseId: record.id,
  lessonId: lesson.id,
  lessonTitle: lesson.title,
  student: {
    id: student.id,
    name: student.name,
    email: student.email,
    active: true,
  },
  kind: "text",
  content: "My assignment response.",
  status: "submitted",
  attempt: 1,
  submittedAt: "2026-10-18T12:00:00.000Z",
  feedback: "",
  reviewedAt: null,
};

test("review decisions require meaningful revision feedback and enforce its length", () => {
  assert.equal(reviewFeedback("accepted", " \n "), "");
  assert.equal(
    reviewFeedback("needs_revision", "  Explain your reasoning.\n"),
    "Explain your reasoning.",
  );
  assert.equal(reviewFeedback("accepted", "x".repeat(4000)).length, 4000);
  for (const status of ["accepted", "needs_revision"] as const) {
    assert.throws(
      () => reviewFeedback(status, "x".repeat(4001)),
      (error: unknown) =>
        error instanceof RequestError && error.code === "VALIDATION",
    );
  }
  assert.throws(
    () => reviewFeedback("needs_revision", " \n\t "),
    (error: unknown) =>
      error instanceof RequestError && error.code === "VALIDATION",
  );
});

test("invalid review feedback never sends a mutation", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("A validation failure must not reach the network.");
  });
  await assert.rejects(
    api.reviewSubmission(
      record.id,
      submission.id,
      submission.revision,
      "needs_revision",
      " \n ",
    ),
    (error: unknown) =>
      error instanceof RequestError && error.code === "VALIDATION",
  );
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("assignment responses reject unsafe links before rendering", async (t) => {
  let content = "";
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      success: true,
      data: { ok: true, data: [{ ...submission, kind: "url", content }] },
    }),
  );
  for (const unsafe of [
    "javascript:alert(1)",
    "http://example.test/work",
    "https://name:secret@example.test/work",
    "https://example.test/a b",
    "https://example.test/\nwork",
    " https://example.test/work",
    "https://example.test/\u007f",
    `https://example.test/${"x".repeat(2048)}`,
    "not a URL",
  ]) {
    content = unsafe;
    await assert.rejects(
      api.submissions(record.id),
      (error: unknown) =>
        error instanceof RequestError && error.code === "response",
      unsafe,
    );
  }
});

test("assignment responses reject foreign course data and invalid review states", async (t) => {
  let candidate: unknown = submission;
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      success: true,
      data: { ok: true, data: [candidate] },
    }),
  );
  for (const invalid of [
    { ...submission, courseId: "other-course" },
    { ...submission, attempt: 0 },
    { ...submission, attempt: 1.5 },
    { ...submission, submittedAt: "invalid" },
    { ...submission, student: null },
    { ...submission, content: " \n " },
    { ...submission, status: "accepted", reviewedAt: null },
    {
      ...submission,
      status: "needs_revision",
      reviewedAt: submission.submittedAt,
      feedback: " ",
    },
    {
      ...submission,
      feedback: "An unreviewed attempt cannot retain old feedback.",
    },
  ]) {
    candidate = invalid;
    await assert.rejects(
      api.submissions(record.id),
      (error: unknown) =>
        error instanceof RequestError && error.code === "response",
    );
  }
});

test("a review cannot replace the selected work with a different submission response", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      success: true,
      data: {
        ok: true,
        data: {
          ...submission,
          id: "someone-elses-work",
          status: "accepted",
          reviewedAt: submission.submittedAt,
        },
      },
    }),
  );
  await assert.rejects(
    api.reviewSubmission(
      record.id,
      submission.id,
      submission.revision,
      "accepted",
      "",
    ),
    (error: unknown) =>
      error instanceof RequestError && error.code === "response",
  );
});

test("assignment conflicts remain actionable for explicit latest-version recovery", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      success: true,
      data: {
        ok: false,
        error: {
          code: "CONFLICT",
          message: "This attempt changed. Load the latest submission.",
        },
      },
    }),
  );
  await assert.rejects(
    api.reviewSubmission(
      record.id,
      submission.id,
      submission.revision,
      "accepted",
      "Good work.",
    ),
    (error: unknown) =>
      isConflict(error) && errorMessage(error).includes("latest submission"),
  );
  fetchMock.mock.mockImplementation(async () =>
    Response.json({ success: false }, { status: 409 }),
  );
  await assert.rejects(
    api.reviewSubmission(
      record.id,
      submission.id,
      submission.revision,
      "accepted",
      "Good work.",
    ),
    (error: unknown) =>
      isConflict(error) && errorMessage(error).includes("latest version"),
  );
});
