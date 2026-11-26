import { apiFetch } from "emdash/plugin-utils";
import { z } from "zod";
import type {
  Course,
  CourseRecord,
  InstructorSubmission,
  LiveSession,
  LiveSessionInput,
  MediaAsset,
  MediaAssetInput,
  MediaLibrary,
  MediaRouteState,
  StudentView,
  SubmissionRecord,
} from "../model.js";
import { tokenSchema } from "../validation.js";

const lessonSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  module: z.string(),
  durationMinutes: z.number().finite().nonnegative(),
  body: z.string(),
  videoUrl: z.string(),
  resourceUrl: z.string(),
  resourceLabel: z.string(),
  resources: z
    .array(z.object({ label: z.string(), url: z.string() }))
    .default([]),
});
const courseSchema = z.object({
  title: z.string(),
  summary: z.string(),
  description: z.string(),
  instructor: z.string(),
  status: z.enum(["draft", "published"]),
  lessons: z.array(lessonSchema),
  access: z.enum(["invite", "open"]).default("invite"),
});
const recordSchema: z.ZodType<CourseRecord> = z.object({
  id: z.string().min(1),
  revision: z.string().min(1),
  value: courseSchema,
});
const dateSchema = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)));
const liveSessionSchema: z.ZodType<LiveSession> = z.object({
  id: z.string().regex(/^[a-f0-9]{32}$/),
  courseId: z.string().min(1),
  title: z.string().min(1),
  startsAt: dateSchema,
  durationMinutes: z.number().int().positive(),
  joinUrl: z.string().min(1),
  passcode: z.string(),
  notes: z.string(),
  createdAt: dateSchema,
  updatedAt: dateSchema,
  revision: z.string().min(1),
});
const studentSchema: z.ZodType<StudentView> = z.object({
  id: z.string().min(1),
  courseId: z.string().min(1),
  name: z.string(),
  email: z.string(),
  active: z.boolean(),
  invitedAt: dateSchema,
  completedLessonIds: z.array(z.string()),
  lastActiveAt: dateSchema.nullable(),
});
const submissionFields = {
  id: z.string().min(1),
  revision: z.string().min(1),
  courseId: z.string().min(1),
  lessonId: z.string().min(1),
  kind: z.enum(["text", "url"]),
  content: z.string().min(1).max(4000),
  status: z.enum(["submitted", "needs_revision", "accepted"]),
  attempt: z.number().int().positive(),
  submittedAt: dateSchema,
  feedback: z.string().max(4000),
  reviewedAt: dateSchema.nullable(),
};

function validSubmission(record: SubmissionRecord): boolean {
  if (!record.content.trim()) return false;
  if (record.kind === "url") {
    if (
      record.content.length > 2048 ||
      /[\s\u0000-\u001f\u007f-\u009f]/u.test(record.content)
    )
      return false;
    try {
      const url = new URL(record.content);
      if (url.protocol !== "https:" || url.username || url.password)
        return false;
    } catch {
      return false;
    }
  }
  return record.status === "submitted"
    ? record.reviewedAt === null && record.feedback === ""
    : record.reviewedAt !== null &&
        (record.status !== "needs_revision" ||
          record.feedback.trim().length > 0);
}

const submissionSchema: z.ZodType<SubmissionRecord> = z
  .object(submissionFields)
  .refine(validSubmission);
const instructorSubmissionSchema: z.ZodType<InstructorSubmission> = z
  .object({
    ...submissionFields,
    lessonTitle: z.string(),
    student: z.object({
      id: z.string().min(1),
      name: z.string(),
      email: z.string(),
      active: z.boolean(),
    }),
  })
  .refine(validSubmission);

export type ReviewStatus = "needs_revision" | "accepted";

export function reviewFeedback(status: ReviewStatus, feedback: string): string {
  const clean = feedback.trim();
  if (clean.length > 4000 || (status === "needs_revision" && !clean)) {
    throw new RequestError(
      "VALIDATION",
      status === "needs_revision" && !clean
        ? "Explain what the student should revise before requesting revision."
        : "Keep instructor feedback within 4,000 characters.",
    );
  }
  return clean;
}
const isoSchema = dateSchema;
const routeReadinessSchema = z.object({
  packageRef: z.string().nullable(),
  manifests: z.object({
    dash: z.string().nullable(),
    hls: z.string().nullable(),
  }),
  smokeTestedAt: isoSchema.nullable(),
  captionsVerified: z.boolean(),
  status: z.enum(["pending", "ready", "failed"]),
});
const mediaAssetSchema: z.ZodType<MediaAsset> = z.object({
  id: z.string().regex(/^[a-f0-9]{32}$/),
  revision: z.string().min(1),
  courseId: z.string().min(1),
  lessonId: z.string().min(1),
  locale: z.enum(["vi", "en", "es"]),
  mediaRevision: z.number().int().positive(),
  provider: z.enum(["doverunner", "wistia"]),
  contentId: z.string(),
  role: z.enum(["original", "dub"]),
  wistia: z
    .object({
      mediaHashedId: z.string(),
      localizationId: z.string().nullable(),
    })
    .nullable(),
  durationSeconds: z.number().int().nonnegative(),
  state: z.enum(["draft", "verified", "published", "retired"]),
  routes: z.object({
    primary: routeReadinessSchema,
    backup: routeReadinessSchema,
  }),
  securityPolicyVersion: z.string(),
  note: z.string(),
  createdAt: isoSchema,
  updatedAt: isoSchema,
});
const mediaRouteStateSchema: z.ZodType<MediaRouteState> = z.object({
  active: z.enum(["primary", "backup", "paused"]),
  reason: z.string(),
  changedAt: isoSchema.nullable(),
});
const mediaLibrarySchema: z.ZodType<MediaLibrary> = z.object({
  assets: z.array(mediaAssetSchema),
  route: mediaRouteStateSchema,
  protectedVideo: z.object({ enabled: z.boolean(), configured: z.boolean() }),
  wistiaPlayback: z.object({ enabled: z.boolean() }),
});

const envelopeSchema = z.object({
  success: z.literal(true),
  data: z.unknown(),
});
const resultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), data: z.unknown() }),
  z.object({
    ok: z.literal(false),
    error: z.object({ code: z.string(), message: z.string().min(1).max(1000) }),
  }),
]);

export class RequestError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RequestError";
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof RequestError
    ? error.message
    : "The request could not be completed. Please try again.";
}

export function isConflict(error: unknown): boolean {
  return (
    error instanceof RequestError && /conflict|revision|stale/i.test(error.code)
  );
}

async function request<T>(
  route: string,
  body: unknown,
  schema: z.ZodType<T>,
  signal?: AbortSignal,
): Promise<T> {
  const payload = JSON.stringify(body);
  const limit = route === "review-submission" ? 32 * 1024 : 512 * 1024;
  if (new TextEncoder().encode(payload).byteLength > limit) {
    throw new RequestError(
      "VALIDATION",
      route === "review-submission"
        ? "This review exceeds the 32 KiB request limit. Shorten your feedback and try again."
        : "This course exceeds the 512 KiB save limit. Shorten lesson content or remove lessons, then save again.",
    );
  }
  let response: Response;
  try {
    response = await apiFetch(
      `/_emdash/api/plugins/mytutor-lms/admin/${route}`,
      {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        signal,
        headers: {
          "Content-Type": "application/json",
          "X-EmDash-Request": "1",
        },
        body: payload,
      },
    );
  } catch {
    throw new RequestError(
      "network",
      "Could not reach the server. Check your connection, then retry. Your edits have been kept.",
    );
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new RequestError(
      "response",
      "The server returned an unreadable response. Retry, or reload the workspace.",
    );
  }
  const envelope = envelopeSchema.safeParse(json);
  if (!envelope.success) {
    if (response.status === 401 || response.status === 403) {
      throw new RequestError(
        "permission",
        "Your administrator session may have expired or you do not have permission. Sign in again before retrying.",
      );
    }
    if (response.status === 409)
      throw new RequestError(
        "conflict",
        "This record changed on the server. Load the latest version before saving.",
      );
    throw new RequestError(
      "response",
      "The server could not complete this request. Please retry.",
    );
  }
  const result = resultSchema.safeParse(envelope.data.data);
  if (!result.success)
    throw new RequestError(
      "response",
      "The server returned an unexpected response. Please reload and retry.",
    );
  if (!result.data.ok)
    throw new RequestError(result.data.error.code, result.data.error.message);
  if (!response.ok)
    throw new RequestError(
      "response",
      "The server could not complete this request. Please retry.",
    );
  const parsed = schema.safeParse(result.data.data);
  if (!parsed.success)
    throw new RequestError(
      "response",
      "The server returned incomplete data. Please reload and retry.",
    );
  return parsed.data;
}

export const api = {
  courses: (signal?: AbortSignal) =>
    request("courses", {}, z.array(recordSchema), signal),
  save: (
    id: string,
    revision: string | null,
    value: Course,
    confirmed?: { confirmation: string; reason: string },
  ) =>
    request(
      "save-course",
      { id, revision, value, ...(confirmed ?? {}) },
      recordSchema,
    ),
  students: (courseId: string, signal?: AbortSignal) =>
    request("students", { courseId }, z.array(studentSchema), signal),
  submissions: (courseId: string, signal?: AbortSignal) =>
    request(
      "submissions",
      { courseId },
      z
        .array(instructorSubmissionSchema)
        .refine((records) =>
          records.every((record) => record.courseId === courseId),
        ),
      signal,
    ),
  reviewSubmission: async (
    courseId: string,
    id: string,
    revision: string,
    status: ReviewStatus,
    feedback: string,
  ) =>
    request(
      "review-submission",
      {
        courseId,
        id,
        revision,
        status,
        feedback: reviewFeedback(status, feedback),
      },
      submissionSchema.refine(
        (record) => record.courseId === courseId && record.id === id,
      ),
    ),
  invite: (courseId: string, name: string, email: string) =>
    request(
      "invite",
      { courseId, name, email },
      z.object({
        student: studentSchema,
        token: tokenSchema,
        expiresAt: dateSchema,
      }),
    ),
  revoke: (id: string) =>
    request("revoke", { id }, z.object({ revoked: z.literal(true) })),
  mediaLibrary: (courseId: string, signal?: AbortSignal) =>
    request(
      "media-assets",
      { courseId },
      mediaLibrarySchema.refine((library) =>
        library.assets.every((asset) => asset.courseId === courseId),
      ),
      signal,
    ),
  saveMediaAsset: (
    id: string,
    revision: string | null,
    value: MediaAssetInput,
  ) =>
    request(
      "save-media-asset",
      { id, revision, value },
      mediaAssetSchema.refine((asset) => asset.id === id),
    ),
  transitionMediaAsset: (
    asset: MediaAsset,
    to: MediaAsset["state"],
    note: string,
  ) =>
    request(
      "media-transition",
      { mediaAssetId: asset.id, revision: asset.revision, to, note },
      mediaAssetSchema.refine((saved) => saved.id === asset.id),
    ),
  setMediaRoute: (to: MediaRouteState["active"], reason: string) =>
    request("media-route", { to, reason }, mediaRouteStateSchema),
  liveSessions: (courseId: string, signal?: AbortSignal) =>
    request(
      "live-sessions",
      { courseId },
      z
        .array(liveSessionSchema)
        .refine((sessions) =>
          sessions.every((session) => session.courseId === courseId),
        ),
      signal,
    ),
  saveLiveSession: (
    id: string,
    revision: string | null,
    value: LiveSessionInput,
  ) =>
    request(
      "save-live-session",
      { id, revision, value },
      liveSessionSchema.refine(
        (session) => session.id === id && session.courseId === value.courseId,
      ),
    ),
  deleteLiveSession: (session: LiveSession) =>
    request(
      "delete-live-session",
      { id: session.id, revision: session.revision },
      z.object({ deleted: z.literal(true) }),
    ),
};

/** 32 lowercase hex characters, the media asset key format. */
export function newMediaAssetId(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

/** Only current lesson IDs count; duplicate and removed completions do not. */
export function progressFor(
  student: StudentView,
  course: Course,
): { completed: number; total: number; percentage: number } {
  const current = new Set(course.lessons.map((lesson) => lesson.id));
  const completed = new Set(
    student.completedLessonIds.filter((id) => current.has(id)),
  ).size;
  const total = current.size;
  return {
    completed,
    total,
    percentage: total === 0 ? 0 : Math.round((completed / total) * 100),
  };
}

export function dateLabel(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/** Generic workspace call for the account screens. */
export { request as adminCall };
