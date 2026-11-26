import { z } from "zod";
import type { ResultError } from "./model.js";

export const MAX_COURSE_BYTES = 512 * 1024;
export const MAX_SUBMISSION_BYTES = 32 * 1024;
export const idSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/)
  .refine((value) => value === value.trim());
export const text = (max: number) =>
  z
    .string()
    .max(max)
    .refine(
      (value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value),
    );
export const label = text(160);
export const link = z
  .string()
  .max(2048)
  .refine((value) => {
    if (value === "") return true;
    if (
      value.trim() !== value ||
      /[\s\\\u0000-\u001f\u007f]/.test(value) ||
      /%(?![a-f0-9]{2})/i.test(value) ||
      !/^https:\/\//i.test(value)
    )
      return false;
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        Boolean(url.hostname) &&
        !url.username &&
        !url.password
      );
    } catch {
      return false;
    }
  }, "Use a valid HTTPS URL without credentials.");
const video = link.refine((value) => {
  if (value === "") return true;
  try {
    return /\.(mp4|webm|ogg|ogv|m4v)$/i.test(new URL(value).pathname);
  } catch {
    return false;
  }
}, "Use a direct MP4, WebM, Ogg or M4V video URL.");
const lessonFields = {
  id: idSchema,
  title: label,
  module: label,
  durationMinutes: z.number().int().min(0).max(1440),
  body: text(20000),
  videoUrl: video,
  resourceUrl: link,
  resourceLabel: label,
};
/**
 * The stored lesson: exactly the 0.3 shape. 0.3 parses courses strictly, so
 * the course record never gains fields; newer course options live in the
 * `courseOptions` collection instead.
 */
export const lessonSchema = z.strictObject(lessonFields);
/** One line of plain text: trimmed, within limits, no control characters or line breaks. */
const line = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .pipe(text(max))
    .refine((value) => !/[\r\n\t]/.test(value));
export const MAX_LESSON_RESOURCES = 10;
export const resourceSchema = z.strictObject({
  label: line(1, 120),
  url: link.refine((value) => value.length > 0, "Add an HTTPS link."),
});
export const resourcesSchema = z
  .array(resourceSchema)
  .max(MAX_LESSON_RESOURCES);
export const courseAccessSchema = z.enum(["invite", "open"]);

type CourseShape = {
  title: string;
  summary: string;
  instructor: string;
  status: "draft" | "published";
  lessons: Array<{
    id: string;
    title: string;
    module: string;
    resourceUrl: string;
    resourceLabel: string;
  }>;
};
function checkCourse(course: CourseShape, ctx: z.RefinementCtx) {
  const ids = new Set<string>();
  course.lessons.forEach((lesson, index) => {
    if (ids.has(lesson.id))
      ctx.addIssue({
        code: "custom",
        path: ["lessons", index, "id"],
        message: "Lesson IDs must be unique.",
      });
    ids.add(lesson.id);
    if (lesson.resourceUrl && !lesson.resourceLabel.trim())
      ctx.addIssue({
        code: "custom",
        path: ["lessons", index, "resourceLabel"],
        message: "Add a resource label.",
      });
    // Text-or-video is checked by the service, which also knows about
    // published protected video for lessons without notes or a direct link.
    if (
      course.status === "published" &&
      (!lesson.title.trim() || !lesson.module.trim())
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["lessons", index],
        message: "Published lessons need a title and module.",
      });
    }
  });
  if (
    course.status === "published" &&
    (!course.title.trim() ||
      !course.summary.trim() ||
      !course.instructor.trim() ||
      !course.lessons.length)
  ) {
    ctx.addIssue({
      code: "custom",
      message:
        "Publishing requires a title, summary, instructor, and at least one lesson.",
    });
  }
}
const courseFields = {
  title: label,
  summary: text(500),
  description: text(5000),
  instructor: label,
  status: z.enum(["draft", "published"]),
};
/** The stored course record: the 0.3 shape, unchanged. */
export const courseSchema = z
  .strictObject({ ...courseFields, lessons: z.array(lessonSchema).max(100) })
  .superRefine(checkCourse);
/** A course as the workspace saves it: the stored shape plus course options. */
export const courseInputSchema = z
  .strictObject({
    ...courseFields,
    lessons: z
      .array(
        z.strictObject({
          ...lessonFields,
          resources: resourcesSchema.optional(),
        }),
      )
      .max(100),
    access: courseAccessSchema.optional(),
  })
  .superRefine(checkCourse);
export const emptySchema = z.strictObject({});
export const saveSchema = z.strictObject({
  id: idSchema,
  revision: z.string().min(1).max(512).nullable(),
  value: courseInputSchema,
});
export const studentsSchema = z.strictObject({ courseId: idSchema });
export const inviteSchema = z.strictObject({
  courseId: idSchema,
  name: label
    .refine((value) => value.trim().length > 0)
    .transform((value) => value.trim()),
  email: z.string().max(254).trim().toLowerCase().pipe(z.email()),
});
export const revokeSchema = z.strictObject({ id: idSchema });
export const tokenSchema = z
  .string()
  .length(129)
  .regex(/^[a-f0-9]{64}\.[a-f0-9]{64}$/);
export const exchangeSchema = z.strictObject({ token: tokenSchema });
export const completeSchema = z.strictObject({
  lessonId: idSchema,
  completed: z.boolean(),
});

const revisionSchema = z.string().min(1).max(512);
const submissionContentSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("text"),
    content: z
      .string()
      .trim()
      .pipe(text(4000))
      .refine((value) => value.length > 0),
  }),
  z.strictObject({
    kind: z.literal("url"),
    content: link.refine(
      (value) => value.length > 0 && !/[\u0080-\u009f]/u.test(value),
    ),
  }),
]);
export const submitSchema = z
  .strictObject({
    lessonId: idSchema,
    revision: revisionSchema.nullable(),
    kind: z.enum(["text", "url"]),
    content: z.string(),
  })
  .superRefine((value, ctx) => {
    const parsed = submissionContentSchema.safeParse({
      kind: value.kind,
      content: value.content,
    });
    if (!parsed.success)
      ctx.addIssue({
        code: "custom",
        path: ["content"],
        message: "Enter text or a safe HTTPS link within the limit.",
      });
  })
  .transform((value) => ({
    ...value,
    content: value.kind === "text" ? value.content.trim() : value.content,
  }));
export const submissionsSchema = z.strictObject({ courseId: idSchema });
export const reviewSubmissionSchema = z
  .strictObject({
    courseId: idSchema,
    id: z.string().regex(/^[a-f0-9]{64}$/),
    revision: revisionSchema,
    status: z.enum(["needs_revision", "accepted"]),
    feedback: z.string().trim().pipe(text(4000)),
  })
  .refine(
    (value) => value.status !== "needs_revision" || value.feedback.length > 0,
    {
      path: ["feedback"],
      message: "Explain what needs revision.",
    },
  );

export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: ResultError["details"],
  ) {
    super(message);
  }
}
export function parseInput<T>(
  schema: z.ZodType<T>,
  input: unknown,
  maxBytes = 4096,
): T {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(input);
  } catch {
    throw new DomainError("VALIDATION", "Request must be valid JSON.");
  }
  if (!encoded || new TextEncoder().encode(encoded).byteLength > maxBytes)
    throw new DomainError("VALIDATION", "Request exceeds the allowed size.");
  const result = schema.safeParse(input);
  if (!result.success)
    throw new DomainError(
      "VALIDATION",
      "Check the required fields, limits, IDs, and HTTPS links.",
    );
  return result.data;
}

const hashSchema = z
  .string()
  .length(64)
  .regex(/^[a-f0-9]{64}$/);
const timestamp = z.number().int().min(0).max(8_640_000_000_000_000);
export const storedCourseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  course: courseSchema,
});
/**
 * Options added to courses after 0.3, keyed by course ID. Kept out of the
 * course record so 0.3 can still read every course after a rollback.
 */
export const storedCourseOptionsSchema = z.strictObject({
  schemaVersion: z.literal(1),
  courseId: idSchema,
  access: courseAccessSchema,
  /** Lesson ID to its additional resources; lessons without any are omitted. */
  lessonResources: z.record(idSchema, resourcesSchema),
  updatedAt: timestamp,
});
export type CourseOptions = z.infer<typeof storedCourseOptionsSchema>;

// ---- Live sessions ----
export const liveSessionIdSchema = z.string().regex(/^[a-f0-9]{32}$/);
const MIN_SESSION_START = Date.parse("2000-01-01T00:00:00Z");
const MAX_SESSION_START = Date.parse("2100-01-01T00:00:00Z");
export const liveSessionInputSchema = z.strictObject({
  courseId: idSchema,
  title: line(1, 120),
  startsAt: z.iso.datetime().refine((value) => {
    const time = Date.parse(value);
    return time >= MIN_SESSION_START && time < MAX_SESSION_START;
  }, "Choose a start time."),
  durationMinutes: z.number().int().min(15).max(480),
  joinUrl: link.refine((value) => value.length > 0, "Add the meeting link."),
  passcode: line(0, 40),
  notes: z.string().trim().pipe(text(1000)),
});
export const saveLiveSessionSchema = z.strictObject({
  id: liveSessionIdSchema,
  revision: z.string().min(1).max(512).nullable(),
  value: liveSessionInputSchema,
});
export const deleteLiveSessionSchema = z.strictObject({
  id: liveSessionIdSchema,
  revision: z.string().min(1).max(512),
});
export const storedLiveSessionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  courseId: idSchema,
  title: line(1, 120),
  startsAt: timestamp,
  durationMinutes: z.number().int().min(15).max(480),
  joinUrl: link.refine((value) => value.length > 0),
  passcode: line(0, 40),
  notes: text(1000),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type StoredLiveSession = z.infer<typeof storedLiveSessionSchema>;
const enrollmentFields = {
  courseId: idSchema,
  name: label,
  email: z.email().max(254),
  active: z.boolean(),
  generation: hashSchema,
  invitedAt: timestamp,
  invitationHash: hashSchema.nullable(),
  sessionHash: hashSchema.nullable(),
  sessionGeneration: hashSchema.nullable(),
  sessionExpiresAt: timestamp.nullable(),
  lastActiveAt: timestamp.nullable(),
};
// Version 2 is written by student accounts (0.3). This release reads it and
// keeps its account fields intact, so rolling back from 0.3 loses nothing.
export const enrollmentSchema = z.discriminatedUnion("schemaVersion", [
  z.strictObject({
    schemaVersion: z.literal(1),
    ...enrollmentFields,
    invitationExpiresAt: timestamp,
  }),
  z.strictObject({
    schemaVersion: z.literal(2),
    ...enrollmentFields,
    studentId: hashSchema,
    invitationExpiresAt: timestamp.nullable(),
  }),
]);
export const progressSchema = z.strictObject({
  schemaVersion: z.literal(1),
  enrollmentId: hashSchema,
  lessonId: idSchema,
  completed: z.boolean(),
  updatedAt: timestamp,
});
export const submissionSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    enrollmentId: hashSchema,
    courseId: idSchema,
    lessonId: idSchema,
    kind: z.enum(["text", "url"]),
    content: z.string(),
    status: z.enum(["submitted", "needs_revision", "accepted"]),
    attempt: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    submittedAt: timestamp,
    feedback: text(4000),
    reviewedAt: timestamp.nullable(),
  })
  .superRefine((value, ctx) => {
    if (
      !submissionContentSchema.safeParse({
        kind: value.kind,
        content: value.content,
      }).success ||
      value.content !== value.content.trim() ||
      value.feedback !== value.feedback.trim() ||
      (value.status === "submitted" &&
        (value.feedback !== "" || value.reviewedAt !== null)) ||
      (value.status !== "submitted" && value.reviewedAt === null) ||
      (value.status === "needs_revision" && value.feedback.length === 0)
    )
      ctx.addIssue({ code: "custom", message: "Invalid stored submission." });
  });
export type Submission = z.infer<typeof submissionSchema>;
export type Enrollment = z.infer<typeof enrollmentSchema>;
export type Progress = z.infer<typeof progressSchema>;
export function readRecord<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new DomainError(
      "UNSUPPORTED_RECORD",
      "A stored record requires an administrator update.",
    );
  return result.data;
}
