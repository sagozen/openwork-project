import type {
  Course,
  CourseAccess,
  CourseRecord,
  CourseSummary,
  InstructorSubmission,
  LearningState,
  Result,
  StudentLiveSession,
  StudentView,
  SubmissionRecord,
} from "./model.js";
import {
  MAX_COURSE_BYTES,
  MAX_SUBMISSION_BYTES,
  DomainError,
  completeSchema,
  emptySchema,
  enrollmentSchema,
  exchangeSchema,
  inviteSchema,
  parseInput,
  progressSchema,
  readRecord,
  revokeSchema,
  reviewSubmissionSchema,
  saveSchema,
  storedCourseOptionsSchema,
  storedCourseSchema,
  studentsSchema,
  submissionSchema,
  submissionsSchema,
  submitSchema,
  tokenSchema,
  type CourseOptions,
  type Enrollment,
  type Submission,
} from "./validation.js";
import {
  all,
  digest,
  result,
  secret,
  type DomainCollection,
} from "./services/shared.js";

export { all, result, type DomainCollection } from "./services/shared.js";

export interface LmsStorage {
  courses: DomainCollection;
  enrollments: DomainCollection;
  progress: DomainCollection;
  submissions: DomainCollection;
  /** Course options added after 0.3 (access, extra lesson resources), keyed by course ID. */
  courseOptions: DomainCollection;
}
const DAY = 24 * 60 * 60 * 1000;

/** 0.2 keys are digest([courseId, email]); account enrollments use digest(["enrollment", courseId, studentId]). */
async function isEnrollmentKey(id: string, enrollment: Enrollment) {
  if (
    id ===
    (await digest(JSON.stringify([enrollment.courseId, enrollment.email])))
  )
    return true;
  return (
    enrollment.schemaVersion === 2 &&
    id ===
      (await digest(
        JSON.stringify([
          "enrollment",
          enrollment.courseId,
          enrollment.studentId,
        ]),
      ))
  );
}
interface Access {
  id: string;
  enrollment: Enrollment;
  /** Invitation session hash; null for student account sessions. */
  sessionHash: string | null;
  course: CourseRecord;
  accessEndsAt: number;
}
/**
 * A student account session for one course (0.3). Invitation sessions from
 * 0.2 remain plain token strings until they expire.
 */
export interface StudentCredential {
  student: string;
  courseId: string;
  /** Enrollment the caller's tab loaded; a mismatch means another account signed in elsewhere. */
  expectedEnrollmentId?: string;
}
export type Credential = unknown;
export function isStudentCredential(
  value: unknown,
): value is StudentCredential {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as StudentCredential).student === "string" &&
    typeof (value as StudentCredential).courseId === "string"
  );
}
/** Resolves student account sessions through `canAccess` to the enrollment that holds progress. */
export interface StudentGate {
  enrollment(
    token: string,
    courseId: string,
  ): Promise<{ enrollmentId: string; accessEndsAt: number }>;
  studentId(token: string): Promise<string | null>;
  /** Whether an account currently has access; checked for invitation sessions on linked enrollments. */
  allowed(studentId: string, courseId: string): Promise<boolean>;
}
/** Lessons of a course that currently have a playable video asset. */
export type VideoLessonLookup = (
  courseId: string,
  lessonIds: string[],
) => Promise<string[]>;
/** Live sessions shown in a classroom; called only after the course access check. */
export type LiveSessionLookup = (
  courseId: string,
) => Promise<StudentLiveSession[]>;
type StoredCourse = ReturnType<typeof storedCourseSchema.parse>["course"];

/** The course as the workspace and classroom see it: the stored record plus its options. */
export function withOptions(
  course: StoredCourse | Course,
  options: CourseOptions | null,
): Course {
  return {
    ...course,
    access: options?.access ?? "invite",
    lessons: course.lessons.map((lesson) => ({
      ...lesson,
      resources: options?.lessonResources[lesson.id] ?? [],
    })),
  };
}
export interface CourseOutline {
  published: boolean;
  /** `standalone`: the lesson has notes or a direct video without a lesson video. */
  lessons: { id: string; standalone: boolean }[];
}
export interface LessonAccess {
  enrollmentId: string;
  courseId: string;
  lessonId: string;
  courseRevision: string;
  /** Epoch ms when this learner's access ends; playback never outlives it. */
  accessEndsAt: number;
}

export class LmsService {
  constructor(
    private readonly storage: LmsStorage,
    private readonly now: () => number = Date.now,
    private readonly videoLessons: VideoLessonLookup = async () => [],
    private readonly gate: StudentGate | null = null,
    private readonly liveSessions: LiveSessionLookup = async () => [],
  ) {}

  /**
   * The options row of a course, or null. A row this release cannot read
   * keeps its revision (so a save can replace it) and counts as invite-only
   * without extra resources: it never opens a course by mistake.
   */
  private async courseOptions(
    courseId: string,
  ): Promise<{ revision: string; value: CourseOptions | null } | null> {
    const record = await this.storage.courseOptions.getVersioned(courseId);
    if (!record) return null;
    const parsed = storedCourseOptionsSchema.safeParse(record.value);
    return {
      revision: record.revision,
      value:
        parsed.success && parsed.data.courseId === courseId
          ? parsed.data
          : null,
    };
  }

  private async withCourseOptions(record: CourseRecord): Promise<CourseRecord> {
    const options = await this.courseOptions(record.id);
    return {
      ...record,
      value: withOptions(record.value, options?.value ?? null),
    };
  }

  /**
   * Writes a course's options row against its current revision, retrying
   * once if another write lands in between. Called only by a save that has
   * passed (or is about to pass) the course revision check.
   */
  private async putOptions(options: CourseOptions): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const current = await this.storage.courseOptions.getVersioned(
        options.courseId,
      );
      const saved = await this.storage.courseOptions.compareAndSet(
        options.courseId,
        current?.revision ?? null,
        options,
      );
      if (saved.applied) return true;
    }
    return false;
  }

  /** Whether a course exists, is published and who may start it; null when absent. */
  async courseAccess(
    courseId: string,
  ): Promise<{ published: boolean; access: CourseAccess } | null> {
    const record = await this.storage.courses.getVersioned(courseId);
    if (!record) return null;
    const course = readRecord(storedCourseSchema, record.value).course;
    const options = await this.courseOptions(courseId);
    return {
      published: course.status === "published",
      access: options?.value?.access ?? "invite",
    };
  }

  private async course(id: string): Promise<CourseRecord> {
    const record = await this.storage.courses.getVersioned(id);
    if (!record) throw new DomainError("NOT_FOUND", "Course not found.");
    return {
      id,
      revision: record.revision,
      value: readRecord(storedCourseSchema, record.value).course,
    };
  }

  courses(input: unknown): Promise<Result<CourseRecord[]>> {
    return result(async () => {
      parseInput(emptySchema, input);
      const courses: CourseRecord[] = [];
      for (const row of await all(this.storage.courses)) {
        const record = await this.storage.courses.getVersioned(row.id);
        if (record)
          courses.push(
            await this.withCourseOptions({
              id: row.id,
              revision: record.revision,
              value: readRecord(storedCourseSchema, record.value).course,
            }),
          );
      }
      return courses;
    });
  }

  saveCourse(input: unknown): Promise<Result<CourseRecord>> {
    return result(async () => {
      const value = parseInput(saveSchema, input, MAX_COURSE_BYTES);
      if (value.value.status === "published") {
        const bare = value.value.lessons
          .filter((lesson) => !lesson.body.trim() && !lesson.videoUrl)
          .map((lesson) => lesson.id);
        const playable = bare.length
          ? new Set(await this.videoLessons(value.id, bare))
          : new Set<string>();
        if (bare.some((id) => !playable.has(id)))
          throw new DomainError(
            "VALIDATION",
            "Published lessons need text, a direct video, or a published lesson video.",
          );
      }
      const previous = await this.storage.courses.getVersioned(value.id);
      if (previous) readRecord(storedCourseSchema, previous.value);
      if ((previous?.revision ?? null) !== value.revision)
        throw new DomainError(
          "CONFLICT",
          "This course changed. Reload before saving.",
        );
      // The course record keeps the 0.3 shape; access and extra resources go
      // to the options row, written only once a course uses them.
      const { access = "invite", lessons, ...fields } = value.value;
      const stored: StoredCourse = {
        ...fields,
        lessons: lessons.map(({ resources: _resources, ...lesson }) => lesson),
      };
      const options: CourseOptions = {
        schemaVersion: 1,
        courseId: value.id,
        access,
        lessonResources: Object.fromEntries(
          lessons.flatMap((lesson) =>
            lesson.resources?.length ? [[lesson.id, lesson.resources]] : [],
          ),
        ),
        updatedAt: this.now(),
      };
      const previousOptions = await this.courseOptions(value.id);
      const writeOptions =
        previousOptions !== null ||
        access !== "invite" ||
        Object.keys(options.lessonResources).length > 0;
      // Closing a course writes its access first, so a failure can leave the
      // course closed with older content, never open after it was closed.
      const narrowing =
        previousOptions?.value?.access === "open" && access !== "open";
      if (narrowing && !(await this.putOptions(options)))
        throw new DomainError(
          "CONFLICT",
          "This course changed. Reload before saving.",
        );
      const saved = await this.storage.courses.compareAndSet(
        value.id,
        value.revision,
        { schemaVersion: 1, course: stored },
      );
      if (!saved.applied)
        throw new DomainError(
          "CONFLICT",
          narrowing
            ? "This course changed. It is now invite-only, but your other edits were not saved. Reload before saving."
            : "This course changed. Reload before saving.",
        );
      if (writeOptions && !narrowing && !(await this.putOptions(options)))
        throw new DomainError(
          "PARTIAL_SAVE",
          "The course content was saved, but its access and extra resources were not updated. Reload and save again.",
        );
      return {
        id: value.id,
        revision: saved.revision,
        value: withOptions(stored, options),
      };
    });
  }

  catalog(): Promise<Result<CourseSummary[]>> {
    return result(async () => {
      const courses: CourseSummary[] = [];
      for (const row of await all(this.storage.courses)) {
        // Unknown/legacy versions are never interpreted as published content.
        const parsed = storedCourseSchema.safeParse(row.data);
        if (!parsed.success || parsed.data.course.status !== "published")
          continue;
        const course = parsed.data.course;
        const options = await this.courseOptions(row.id);
        courses.push({
          id: row.id,
          access: options?.value?.access ?? "invite",
          title: course.title,
          summary: course.summary,
          description: course.description,
          instructor: course.instructor,
          lessonCount: course.lessons.length,
          durationMinutes: course.lessons.reduce(
            (total, lesson) => total + lesson.durationMinutes,
            0,
          ),
          curriculum: course.lessons.map(
            ({ id, title, module, durationMinutes }) => ({
              id,
              title,
              module,
              durationMinutes,
            }),
          ),
        });
      }
      return courses;
    });
  }

  private async completed(id: string, course: CourseRecord): Promise<string[]> {
    const completed = new Set<string>();
    for (const row of await all(this.storage.progress, { enrollmentId: id })) {
      const progress = readRecord(progressSchema, row.data);
      if (progress.enrollmentId === id && progress.completed)
        completed.add(progress.lessonId);
    }
    return course.value.lessons
      .filter((lesson) => completed.has(lesson.id))
      .map((lesson) => lesson.id);
  }

  private async submissionOwner(
    id: string,
    courseId: string,
  ): Promise<Enrollment> {
    const row = await this.storage.enrollments.getVersioned(id);
    if (!row)
      throw new DomainError(
        "UNSUPPORTED_RECORD",
        "The submission owner requires administrator review.",
      );
    const enrollment = readRecord(enrollmentSchema, row.value);
    if (
      enrollment.courseId !== courseId ||
      !(await isEnrollmentKey(id, enrollment))
    )
      throw new DomainError(
        "UNSUPPORTED_RECORD",
        "The submission owner requires administrator review.",
      );
    return enrollment;
  }

  private async submission(
    id: string,
    courseId: string,
    enrollmentId?: string,
  ) {
    const row = await this.storage.submissions.getVersioned(id);
    if (!row) return null;
    const value = readRecord(submissionSchema, row.value);
    if (value.courseId !== courseId && enrollmentId === undefined)
      throw new DomainError("NOT_FOUND", "Submission not found.");
    if (
      value.courseId !== courseId ||
      (enrollmentId !== undefined && value.enrollmentId !== enrollmentId) ||
      id !==
        (await digest(JSON.stringify([value.enrollmentId, value.lessonId])))
    )
      throw new DomainError(
        "UNSUPPORTED_RECORD",
        "The submission requires administrator review.",
      );
    const enrollment = await this.submissionOwner(value.enrollmentId, courseId);
    return { value, revision: row.revision, enrollment };
  }

  private submissionView(
    id: string,
    revision: string,
    value: Submission,
  ): SubmissionRecord {
    return {
      id,
      revision,
      courseId: value.courseId,
      lessonId: value.lessonId,
      kind: value.kind,
      content: value.content,
      status: value.status,
      attempt: value.attempt,
      submittedAt: new Date(value.submittedAt).toISOString(),
      feedback: value.feedback,
      reviewedAt:
        value.reviewedAt === null
          ? null
          : new Date(value.reviewedAt).toISOString(),
    };
  }

  private async studentSubmissions(
    id: string,
    course: CourseRecord,
  ): Promise<SubmissionRecord[]> {
    const submissions: SubmissionRecord[] = [];
    for (const row of await all(this.storage.submissions, {
      enrollmentId: id,
    })) {
      const stored = await this.submission(row.id, course.id, id);
      if (
        stored &&
        course.value.lessons.some(
          (lesson) => lesson.id === stored.value.lessonId,
        )
      )
        submissions.push(
          this.submissionView(row.id, stored.revision, stored.value),
        );
    }
    return submissions;
  }

  submissions(input: unknown): Promise<Result<InstructorSubmission[]>> {
    return result(async () => {
      const { courseId } = parseInput(submissionsSchema, input);
      await this.course(courseId);
      const submissions: InstructorSubmission[] = [];
      for (const row of await all(this.storage.submissions, { courseId })) {
        const stored = await this.submission(row.id, courseId);
        if (!stored) continue;
        submissions.push({
          ...this.submissionView(row.id, stored.revision, stored.value),
          lessonTitle: "",
          student: {
            id: stored.value.enrollmentId,
            name: stored.enrollment.name,
            email: stored.enrollment.email,
            active: stored.enrollment.active,
          },
        });
      }
      const current = await this.course(courseId);
      return submissions.flatMap((submission) => {
        const lesson = current.value.lessons.find(
          (lesson) => lesson.id === submission.lessonId,
        );
        return lesson ? [{ ...submission, lessonTitle: lesson.title }] : [];
      });
    });
  }

  private async reviewAccess(value: Submission): Promise<void> {
    await this.submissionOwner(value.enrollmentId, value.courseId);
    const course = await this.course(value.courseId);
    if (!course.value.lessons.some((lesson) => lesson.id === value.lessonId))
      throw new DomainError("NOT_FOUND", "Lesson not found.");
  }

  reviewSubmission(input: unknown): Promise<Result<SubmissionRecord>> {
    return result(async () => {
      const request = parseInput(
        reviewSubmissionSchema,
        input,
        MAX_SUBMISSION_BYTES,
      );
      const stored = await this.submission(request.id, request.courseId);
      if (!stored) throw new DomainError("NOT_FOUND", "Submission not found.");
      if (stored.revision !== request.revision)
        throw new DomainError(
          "CONFLICT",
          "This submission changed. Reload before reviewing.",
        );
      const value: Submission = {
        ...stored.value,
        status: request.status,
        feedback: request.feedback,
        reviewedAt: this.now(),
      };
      await this.reviewAccess(value);
      const saved = await this.storage.submissions.compareAndSet(
        request.id,
        request.revision,
        value,
      );
      if (!saved.applied)
        throw new DomainError(
          "CONFLICT",
          "This submission changed. Reload before reviewing.",
        );
      await this.reviewAccess(value);
      return this.submissionView(request.id, saved.revision, value);
    });
  }

  submit(input: unknown, token: Credential): Promise<Result<LearningState>> {
    return result(async () => {
      const request = parseInput(submitSchema, input, MAX_SUBMISSION_BYTES);
      const access = await this.access(token);
      if (
        !access.course.value.lessons.some(
          (lesson) => lesson.id === request.lessonId,
        )
      )
        throw new DomainError("NOT_FOUND", "Lesson not found.");
      await this.submissionOwner(access.id, access.course.id);
      const id = await digest(JSON.stringify([access.id, request.lessonId]));
      const previous = await this.submission(id, access.course.id, access.id);
      if ((previous?.revision ?? null) !== request.revision)
        throw new DomainError(
          "CONFLICT",
          "This submission changed. Reload before submitting.",
        );
      if (previous?.value.status === "accepted")
        throw new DomainError(
          "ACCESS_DENIED",
          "Accepted work is read-only until your instructor requests revision.",
        );
      if (previous?.value.attempt === Number.MAX_SAFE_INTEGER)
        throw new DomainError(
          "CONFLICT",
          "This submission requires administrator review.",
        );
      const value: Submission = {
        schemaVersion: 1,
        enrollmentId: access.id,
        courseId: access.course.id,
        lessonId: request.lessonId,
        kind: request.kind,
        content: request.content,
        status: "submitted",
        attempt: (previous?.value.attempt ?? 0) + 1,
        submittedAt: this.now(),
        feedback: "",
        reviewedAt: null,
      };
      const current = await this.access(token);
      if (
        !current.course.value.lessons.some(
          (lesson) => lesson.id === request.lessonId,
        )
      )
        throw new DomainError("NOT_FOUND", "Lesson not found.");
      const saved = await this.storage.submissions.compareAndSet(
        id,
        request.revision,
        value,
      );
      if (!saved.applied)
        throw new DomainError(
          "CONFLICT",
          "This submission changed. Reload before submitting.",
        );
      return this.state(token, request.lessonId);
    });
  }

  private async student(
    id: string,
    enrollment: Enrollment,
    course: CourseRecord,
  ): Promise<StudentView> {
    return {
      id,
      courseId: enrollment.courseId,
      name: enrollment.name,
      email: enrollment.email,
      active: enrollment.active,
      invitedAt: new Date(enrollment.invitedAt).toISOString(),
      completedLessonIds: await this.completed(id, course),
      lastActiveAt:
        enrollment.lastActiveAt === null
          ? null
          : new Date(enrollment.lastActiveAt).toISOString(),
    };
  }

  students(input: unknown): Promise<Result<StudentView[]>> {
    return result(async () => {
      const { courseId } = parseInput(studentsSchema, input);
      const course = await this.course(courseId);
      const students: StudentView[] = [];
      for (const row of await all(this.storage.enrollments, { courseId })) {
        const enrollment = readRecord(enrollmentSchema, row.data);
        if (enrollment.courseId === courseId)
          students.push(await this.student(row.id, enrollment, course));
      }
      return students;
    });
  }

  invite(
    input: unknown,
  ): Promise<
    Result<{ student: StudentView; token: string; expiresAt: string }>
  > {
    return result(async () => {
      const { courseId, name, email } = parseInput(inviteSchema, input);
      const course = await this.course(courseId);
      const id = await digest(JSON.stringify([courseId, email]));
      const previous = await this.storage.enrollments.getVersioned(id);
      const existing = previous
        ? readRecord(enrollmentSchema, previous.value)
        : null;
      if (
        existing &&
        (existing.courseId !== courseId || existing.email !== email)
      )
        throw new DomainError(
          "UNSUPPORTED_RECORD",
          "The enrollment requires administrator review.",
        );
      const now = this.now();
      const token = `${id}.${secret()}`;
      const fields = {
        courseId,
        name,
        email,
        active: true,
        generation: secret(),
        invitedAt: now,
        invitationHash: await digest(token),
        invitationExpiresAt: now + 7 * DAY,
        sessionHash: null,
        sessionGeneration: null,
        sessionExpiresAt: null,
        lastActiveAt: existing?.lastActiveAt ?? null,
      };
      // Keep an account-linked (version 2) enrollment linked to its student.
      const enrollment: Enrollment =
        existing?.schemaVersion === 2
          ? { ...fields, schemaVersion: 2, studentId: existing.studentId }
          : { ...fields, schemaVersion: 1 };
      // Stable course/email key + create-if-absent prevents concurrent duplicate enrollments.
      // Rotation fences every old invitation/session without touching progress rows.
      const saved = await this.storage.enrollments.compareAndSet(
        id,
        previous?.revision ?? null,
        enrollment,
      );
      if (!saved.applied)
        throw new DomainError(
          "CONFLICT",
          "This enrollment changed. Reload before inviting again.",
        );
      return {
        student: await this.student(id, enrollment, course),
        token,
        expiresAt: new Date(fields.invitationExpiresAt).toISOString(),
      };
    });
  }

  revoke(input: unknown): Promise<Result<{ revoked: true }>> {
    return result(async () => {
      const { id } = parseInput(revokeSchema, input);
      const previous = await this.storage.enrollments.getVersioned(id);
      if (!previous) throw new DomainError("NOT_FOUND", "Student not found.");
      const enrollment = readRecord(enrollmentSchema, previous.value);
      // Guard the generation, not a stale whole-document revision: a simultaneous
      // exchange/activity update must not prevent revocation from taking effect.
      const saved = await this.storage.enrollments.updateIf(id, {
        where: { generation: enrollment.generation },
        set: {
          active: false,
          generation: secret(),
          invitationHash: null,
          sessionHash: null,
          sessionGeneration: null,
          sessionExpiresAt: null,
        },
      });
      if (!saved.applied)
        throw new DomainError(
          "CONFLICT",
          "This enrollment changed. Reload before revoking.",
        );
      return { revoked: true };
    });
  }

  exchange(
    input: unknown,
  ): Promise<Result<{ sessionToken: string; expiresAt: string }>> {
    return result(async () => {
      const { token } = parseInput(exchangeSchema, input);
      const id = token.slice(0, 64);
      const previous = await this.storage.enrollments.getVersioned(id);
      if (!previous)
        throw new DomainError(
          "INVALID_INVITATION",
          "This invitation is expired, used, or no longer available.",
        );
      const enrollment = readRecord(enrollmentSchema, previous.value);
      const now = this.now();
      if (
        !enrollment.active ||
        enrollment.invitationExpiresAt === null ||
        enrollment.invitationExpiresAt <= now ||
        enrollment.invitationHash !== (await digest(token))
      ) {
        throw new DomainError(
          "INVALID_INVITATION",
          "This invitation is expired, used, or no longer available.",
        );
      }
      const course = await this.course(enrollment.courseId);
      if (course.value.status !== "published")
        throw new DomainError("ACCESS_DENIED", "This course is not available.");
      const sessionToken = `${id}.${secret()}`;
      const expiresAt = now + 30 * DAY;
      // Consumption and session issuance share ONE CAS, so two exchanges cannot win
      // and a crash cannot leave a consumed invitation with an unpersisted session.
      const saved = await this.storage.enrollments.compareAndSet(
        id,
        previous.revision,
        {
          ...enrollment,
          invitationHash: null,
          sessionHash: await digest(sessionToken),
          sessionGeneration: enrollment.generation,
          sessionExpiresAt: expiresAt,
          lastActiveAt: now,
        },
      );
      if (!saved.applied)
        throw new DomainError(
          "INVALID_INVITATION",
          "This invitation is expired, used, or no longer available.",
        );
      await this.access(sessionToken);
      return { sessionToken, expiresAt: new Date(expiresAt).toISOString() };
    });
  }

  private async access(token: Credential): Promise<Access> {
    if (isStudentCredential(token)) return this.studentAccess(token);
    const parsed = tokenSchema.safeParse(token);
    if (!parsed.success)
      throw new DomainError(
        "ACCESS_DENIED",
        "Your learning session is no longer available.",
      );
    const id = parsed.data.slice(0, 64);
    const record = await this.storage.enrollments.getVersioned(id);
    if (!record)
      throw new DomainError(
        "ACCESS_DENIED",
        "Your learning session is no longer available.",
      );
    const enrollment = readRecord(enrollmentSchema, record.value);
    const sessionHash = await digest(parsed.data);
    if (
      !enrollment.active ||
      enrollment.sessionHash !== sessionHash ||
      enrollment.sessionGeneration !== enrollment.generation ||
      enrollment.sessionExpiresAt === null ||
      enrollment.sessionExpiresAt <= this.now()
    ) {
      throw new DomainError(
        "ACCESS_DENIED",
        "Your learning session is no longer available.",
      );
    }
    const course = await this.course(enrollment.courseId);
    if (course.value.status !== "published")
      throw new DomainError("ACCESS_DENIED", "This course is not available.");
    // Once an invitation is linked to an account, its old session obeys the
    // account's access: revoked grants and disabled accounts end it too.
    if (
      enrollment.schemaVersion === 2 &&
      this.gate &&
      !(await this.gate.allowed(enrollment.studentId, enrollment.courseId))
    )
      throw new DomainError(
        "ACCESS_DENIED",
        "Your learning session is no longer available.",
      );
    return {
      id,
      enrollment,
      sessionHash,
      course,
      accessEndsAt: enrollment.sessionExpiresAt,
    };
  }

  private async studentAccess(credential: StudentCredential): Promise<Access> {
    if (!this.gate)
      throw new DomainError(
        "ACCESS_DENIED",
        "Your learning session is no longer available.",
      );
    const { enrollmentId, accessEndsAt } = await this.gate.enrollment(
      credential.student,
      credential.courseId,
    );
    if (
      credential.expectedEnrollmentId !== undefined &&
      credential.expectedEnrollmentId !== enrollmentId
    )
      throw new DomainError(
        "SESSION_CHANGED",
        "Your learning session changed in another tab. Reload to continue; your unsent draft has been kept.",
      );
    const record = await this.storage.enrollments.getVersioned(enrollmentId);
    const enrollment = record
      ? readRecord(enrollmentSchema, record.value)
      : null;
    if (!enrollment?.active || enrollment.courseId !== credential.courseId)
      throw new DomainError(
        "ACCESS_ENDED",
        "Your access to this course has ended.",
      );
    const course = await this.course(credential.courseId);
    if (course.value.status !== "published")
      throw new DomainError("ACCESS_DENIED", "This course is not available.");
    return {
      id: enrollmentId,
      enrollment,
      sessionHash: null,
      course,
      accessEndsAt,
    };
  }

  private async state(
    token: Credential,
    requiredLessonId?: string,
  ): Promise<LearningState> {
    const access = await this.access(token);
    const completedLessonIds = await this.completed(access.id, access.course);
    const submissions = await this.studentSubmissions(access.id, access.course);
    // Do not release private content after a revocation, rotation, expiry or
    // unpublish observed while the progress/submission queries were in flight.
    const videoLessonIds = await this.videoLessons(
      access.course.id,
      access.course.value.lessons.map((lesson) => lesson.id),
    ).catch((error: unknown) => {
      // Notes and assignments stay open when the video settings cannot be
      // read (for example a secret encrypted with another key).
      console.error("[mytutor-lms] video lessons unavailable", error);
      return [] as string[];
    });
    const liveSessions = await this.liveSessions(access.course.id);
    const options = await this.courseOptions(access.course.id);
    const current = await this.access(token);
    if (
      requiredLessonId !== undefined &&
      !current.course.value.lessons.some(
        (lesson) => lesson.id === requiredLessonId,
      )
    )
      throw new DomainError("NOT_FOUND", "Lesson not found.");
    return {
      enrollmentId: current.id,
      student: {
        name: current.enrollment.name,
        email: current.enrollment.email,
      },
      course: {
        ...current.course,
        value: withOptions(
          current.course.value,
          current.course.id === access.course.id
            ? (options?.value ?? null)
            : null,
        ),
      },
      completedLessonIds: completedLessonIds.filter((id) =>
        current.course.value.lessons.some((lesson) => lesson.id === id),
      ),
      submissions: submissions.filter((submission) =>
        current.course.value.lessons.some(
          (lesson) => lesson.id === submission.lessonId,
        ),
      ),
      videoLessonIds:
        current.course.id === access.course.id
          ? current.course.value.lessons
              .filter((lesson) => videoLessonIds.includes(lesson.id))
              .map((lesson) => lesson.id)
          : [],
      liveSessions: current.course.id === access.course.id ? liveSessions : [],
    };
  }

  /**
   * The single access gate for lesson content and video playback. Until
   * persistent student accounts exist, the learner is the enrollment bound to
   * the session token.
   */
  async canAccess(
    token: Credential,
    request: { courseId: string; lessonId: string },
  ): Promise<LessonAccess> {
    const access = await this.access(token);
    if (access.course.id !== request.courseId)
      throw new DomainError("ACCESS_DENIED", "This course is not available.");
    if (
      !access.course.value.lessons.some(
        (lesson) => lesson.id === request.lessonId,
      )
    )
      throw new DomainError("NOT_FOUND", "Lesson not found.");
    return {
      enrollmentId: access.id,
      courseId: access.course.id,
      lessonId: request.lessonId,
      courseRevision: access.course.revision,
      accessEndsAt: access.accessEndsAt,
    };
  }

  /** Lessons of a course and whether each has notes or a direct video; null when absent. */
  async lessonContent(courseId: string): Promise<CourseOutline | null> {
    const record = await this.storage.courses.getVersioned(courseId);
    if (!record) return null;
    const course = readRecord(storedCourseSchema, record.value).course;
    return {
      published: course.status === "published",
      lessons: course.lessons.map((lesson) => ({
        id: lesson.id,
        standalone: Boolean(lesson.body.trim() || lesson.videoUrl),
      })),
    };
  }

  /** Session-owner check that ignores course state, used to end playback. */
  async sessionOwner(token: Credential): Promise<string | null> {
    const parsed = tokenSchema.safeParse(token);
    if (!parsed.success) return null;
    const id = parsed.data.slice(0, 64);
    const record = await this.storage.enrollments.getVersioned(id);
    if (!record) return null;
    const enrollment = readRecord(enrollmentSchema, record.value);
    return enrollment.sessionHash === (await digest(parsed.data)) ? id : null;
  }

  /** Whether a credential belongs to the learner of an enrollment, whatever the course state. */
  async owns(credential: Credential, enrollmentId: string): Promise<boolean> {
    if (!isStudentCredential(credential))
      return (await this.sessionOwner(credential)) === enrollmentId;
    const studentId = await this.gate?.studentId(credential.student);
    const record = await this.storage.enrollments.getVersioned(enrollmentId);
    const enrollment = record ? enrollmentSchema.safeParse(record.value) : null;
    return Boolean(
      studentId &&
        enrollment?.success &&
        enrollment.data.schemaVersion === 2 &&
        enrollment.data.studentId === studentId,
    );
  }

  /**
   * Consumes a 0.2 invitation without issuing an invitation session; the
   * caller turns it into a student account session.
   */
  async consumeInvitation(
    token: string,
  ): Promise<{ enrollmentId: string; enrollment: Enrollment }> {
    const id = token.slice(0, 64);
    const invalid = () =>
      new DomainError(
        "INVALID_INVITATION",
        "This invitation is expired, used, or no longer available.",
      );
    const previous = await this.storage.enrollments.getVersioned(id);
    if (!previous) throw invalid();
    const enrollment = readRecord(enrollmentSchema, previous.value);
    const now = this.now();
    if (
      !enrollment.active ||
      enrollment.invitationExpiresAt === null ||
      enrollment.invitationExpiresAt <= now ||
      enrollment.invitationHash !== (await digest(token))
    )
      throw invalid();
    const course = await this.course(enrollment.courseId);
    if (course.value.status !== "published")
      throw new DomainError("ACCESS_DENIED", "This course is not available.");
    const next: Enrollment = {
      ...enrollment,
      invitationHash: null,
      lastActiveAt: now,
    };
    const saved = await this.storage.enrollments.compareAndSet(
      id,
      previous.revision,
      next,
    );
    if (!saved.applied) throw invalid();
    return { enrollmentId: id, enrollment: next };
  }

  async courseIds(): Promise<string[]> {
    return (await all(this.storage.courses)).map((row) => row.id);
  }

  async courseInfo(
    courseId: string,
  ): Promise<{ title: string; published: boolean } | null> {
    const record = await this.storage.courses.getVersioned(courseId);
    if (!record) return null;
    const course = readRecord(storedCourseSchema, record.value).course;
    return { title: course.title, published: course.status === "published" };
  }

  async enrollmentInfo(enrollmentId: string): Promise<{
    courseId: string;
    active: boolean;
    invitedAt: number;
    studentId: string | null;
  } | null> {
    const record = await this.storage.enrollments.getVersioned(enrollmentId);
    const parsed = record ? enrollmentSchema.safeParse(record.value) : null;
    if (!parsed?.success) return null;
    return {
      courseId: parsed.data.courseId,
      active: parsed.data.active,
      invitedAt: parsed.data.invitedAt,
      studentId: parsed.data.schemaVersion === 2 ? parsed.data.studentId : null,
    };
  }

  async enrollmentCourseId(enrollmentId: string): Promise<string | null> {
    return (await this.enrollmentInfo(enrollmentId))?.courseId ?? null;
  }

  /** Ends an invitation session once its holder has moved to a student account. */
  async endInvitationSession(enrollmentId: string): Promise<void> {
    await this.storage.enrollments.updateIf(enrollmentId, {
      where: { active: true },
      set: {
        sessionHash: null,
        sessionGeneration: null,
        sessionExpiresAt: null,
      },
    });
  }

  /** Progress and next lesson for the dashboard; no lesson content. */
  async progressSummary(enrollmentId: string, courseId: string) {
    const record = await this.storage.courses.getVersioned(courseId);
    if (!record) return null;
    const course: CourseRecord = {
      id: courseId,
      revision: record.revision,
      value: readRecord(storedCourseSchema, record.value).course,
    };
    const completed = await this.completed(enrollmentId, course);
    const enrollment =
      await this.storage.enrollments.getVersioned(enrollmentId);
    const parsed = enrollment
      ? enrollmentSchema.safeParse(enrollment.value)
      : null;
    return {
      course: course.value,
      completedCount: completed.length,
      nextLessonId:
        course.value.lessons.find((lesson) => !completed.includes(lesson.id))
          ?.id ?? null,
      lastActiveAt:
        parsed?.success && parsed.data.lastActiveAt !== null
          ? new Date(parsed.data.lastActiveAt).toISOString()
          : null,
    };
  }

  library(input: unknown, token: Credential): Promise<Result<LearningState>> {
    return result(async () => {
      parseInput(emptySchema, input);
      return this.state(token);
    });
  }

  complete(input: unknown, token: Credential): Promise<Result<LearningState>> {
    return result(async () => {
      const { lessonId, completed } = parseInput(completeSchema, input);
      const access = await this.access(token);
      if (!access.course.value.lessons.some((lesson) => lesson.id === lessonId))
        throw new DomainError("NOT_FOUND", "Lesson not found.");
      const key = `${access.id}.${lessonId}`;
      const previous = await this.storage.progress.getVersioned(key);
      if (previous) readRecord(progressSchema, previous.value);
      // Each lesson is an independent atomic upsert. Parallel different-lesson
      // completions never overwrite one another; same-lesson writes are last-wins.
      await this.access(token);
      await this.storage.progress.put(key, {
        schemaVersion: 1,
        enrollmentId: access.id,
        lessonId,
        completed,
        updatedAt: this.now(),
      });
      const touched = await this.storage.enrollments.updateIf(access.id, {
        where: {
          active: true,
          generation: access.enrollment.generation,
          ...(access.sessionHash !== null
            ? { sessionHash: access.sessionHash }
            : {}),
        },
        set: { lastActiveAt: this.now() },
      });
      if (!touched.applied)
        throw new DomainError(
          "ACCESS_DENIED",
          "Your learning session is no longer available.",
        );
      return this.state(token);
    });
  }

  logout(
    input: unknown,
    token: Credential,
  ): Promise<Result<{ loggedOut: true }>> {
    return result(async () => {
      parseInput(emptySchema, input);
      const parsed = tokenSchema.safeParse(token);
      if (!parsed.success) return { loggedOut: true };
      // A stale logout cannot clear a session issued after invitation rotation.
      await this.storage.enrollments.updateIf(parsed.data.slice(0, 64), {
        where: { sessionHash: await digest(parsed.data) },
        set: {
          sessionHash: null,
          sessionGeneration: null,
          sessionExpiresAt: null,
        },
      });
      return { loggedOut: true };
    });
  }
}
