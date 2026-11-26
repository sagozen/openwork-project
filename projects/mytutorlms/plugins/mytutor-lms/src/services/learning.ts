import type {
  AccessReason,
  Dashboard,
  DashboardCourse,
  Locale,
  OpenCourseCard,
  SignedIn,
} from "../model.js";
import type { LmsService, StudentGate } from "../service.js";
import { DomainError } from "../validation.js";
import type { AccountService, RequestOrigin, SiteRules } from "./accounts.js";
import type { AuditLog } from "./audit.js";
import type { RateLimiter } from "./rate-limit.js";
import {
  accessStatus,
  inviteRef,
  type EntitlementService,
} from "./entitlements.js";
import { profile, type StudentDirectory } from "./students.js";

const ENDED_MESSAGES: Partial<Record<AccessReason, string>> = {
  student_disabled: "This account is disabled. Contact your instructor.",
  course_unavailable: "This course is not available right now.",
  not_started: "Your access to this course has not started yet.",
  ended: "Your access to this course has ended. Your progress is saved.",
  revoked: "Your access to this course was removed. Your progress is saved.",
};
const SYSTEM = { type: "system" as const, id: "accounts", label: "Accounts" };
const HOUR = 60 * 60 * 1000;
/** Grant reference of an open-course start: one per student and course, so a repeat is a no-op. */
export const openCourseRef = (courseId: string, studentId: string) =>
  `open:${courseId}:${studentId}`;

/** Student account flows that span accounts, entitlements and course progress. */
export class StudentLearning implements StudentGate {
  constructor(
    private readonly accounts: AccountService,
    private readonly students: StudentDirectory,
    private readonly entitlements: EntitlementService,
    private readonly lms: LmsService,
    private readonly audit: AuditLog,
    private readonly now: () => number = Date.now,
    private readonly limits: RateLimiter | null = null,
  ) {}

  /**
   * "Start learning" on an open course: grants the signed-in student free,
   * open-ended access as a complimentary grant (a kind 0.3 understands) and
   * returns the course. Only published open courses qualify. Repeating it
   * changes nothing, and a grant an instructor revoked is never revived.
   * Lessons stay behind `canAccess`, like every other grant.
   */
  async joinOpenCourse(
    token: string,
    courseId: string,
  ): Promise<{ courseId: string; joined: boolean }> {
    const current = await this.accounts.access(token);
    const studentId = current.student.id;
    await this.limits?.consume([
      {
        scope: "join:student:hour",
        subject: studentId,
        max: 20,
        windowMs: HOUR,
      },
    ]);
    const course = await this.lms.courseAccess(courseId);
    if (!course?.published || course.access !== "open")
      throw new DomainError(
        "NOT_OPEN",
        "This course is not open for free enrollment.",
      );
    const before = await this.entitlements.canAccess({ studentId, courseId });
    if (before.allowed) return { courseId, joined: false };
    // Staff removed this student's access to this course once (any grant
    // kind); opening the course must not let them restore it themselves.
    const revoked = (await this.entitlements.forStudent(studentId)).some(
      (grant) => grant.courseId === courseId && grant.status === "revoked",
    );
    if (revoked)
      throw new DomainError("ACCESS_ENDED", ENDED_MESSAGES.revoked!);
    const { created } = await this.entitlements.grant({
      studentId,
      courseId,
      source: "comp",
      sourceRef: openCourseRef(courseId, studentId),
      expiresAt: null,
      actor: { type: "student", id: studentId, label: "Student" },
      reason: "Open course",
      silent: true,
    });
    const after = await this.entitlements.canAccess({ studentId, courseId });
    if (!after.allowed)
      throw new DomainError(
        "ACCESS_ENDED",
        ENDED_MESSAGES[after.reason] ??
          "You do not have access to this course.",
      );
    return { courseId, joined: created };
  }

  async enrollment(token: string, courseId: string) {
    const current = await this.accounts.access(token);
    await this.entitlements.adoptLegacyInvitation(current.student, courseId);
    const decision = await this.entitlements.canAccess({
      studentId: current.student.id,
      courseId,
    });
    if (!decision.allowed)
      throw new DomainError(
        "ACCESS_ENDED",
        ENDED_MESSAGES[decision.reason] ??
          "You do not have access to this course.",
      );
    const enrollmentId = await this.entitlements.ensureEnrollment(
      current.student,
      courseId,
    );
    const accessEnd = decision.expiresAt
      ? Date.parse(decision.expiresAt)
      : Infinity;
    return {
      enrollmentId,
      accessEndsAt: Math.min(current.session.value.expiresAt, accessEnd),
    };
  }

  async allowed(studentId: string, courseId: string): Promise<boolean> {
    return (await this.entitlements.canAccess({ studentId, courseId })).allowed;
  }

  async studentId(token: string): Promise<string | null> {
    try {
      return (await this.accounts.access(token)).student.id;
    } catch {
      return null;
    }
  }

  /** Every course the student holds or held access to; never other students' data. */
  async dashboard(token: string): Promise<Dashboard> {
    const current = await this.accounts.access(token);
    const studentId = current.student.id;
    const courseIds = new Set(
      (await this.entitlements.forStudent(studentId)).map(
        (item) => item.courseId,
      ),
    );
    // Until the owner migrates accounts, 0.2 invitations for this email count too.
    for (const courseId of await this.lms.courseIds())
      if (
        !courseIds.has(courseId) &&
        (await this.entitlements.adoptLegacyInvitation(
          current.student,
          courseId,
        ))
      )
        courseIds.add(courseId);
    const courses: DashboardCourse[] = [];
    for (const courseId of courseIds) {
      const enrollmentId =
        (await this.entitlements.enrollmentFor(studentId, courseId))?.id ??
        (await this.entitlements.ensureEnrollment(current.student, courseId));
      const summary = await this.lms.progressSummary(enrollmentId, courseId);
      if (!summary) continue;
      const decision = await this.entitlements.canAccess({
        studentId,
        courseId,
      });
      courses.push({
        courseId,
        enrollmentId,
        title: summary.course.title,
        summary: summary.course.summary,
        instructor: summary.course.instructor,
        lessonCount: summary.course.lessons.length,
        completedCount: summary.completedCount,
        nextLessonId: summary.nextLessonId,
        lastActiveAt: summary.lastActiveAt,
        access: {
          status: accessStatus(decision, this.now()),
          expiresAt:
            decision.expiresAt ??
            (await this.entitlements.current({ studentId, courseId }))
              ?.expiresAt ??
            null,
        },
      });
    }
    courses.sort((a, b) =>
      (b.lastActiveAt ?? "").localeCompare(a.lastActiveAt ?? ""),
    );
    const catalog = await this.lms.catalog();
    const openCourses: OpenCourseCard[] = catalog.ok
      ? catalog.data
          .filter(
            (course) => course.access === "open" && !courseIds.has(course.id),
          )
          .map((course) => ({
            courseId: course.id,
            title: course.title,
            summary: course.summary,
            instructor: course.instructor,
            lessonCount: course.lessonCount,
          }))
      : [];
    return {
      student: profile(studentId, current.student.value),
      courses,
      upgradeAvailable: false,
      openCourses,
    };
  }

  /**
   * Turns a 0.2 invitation into a student account: consumes the invitation,
   * resolves the student by the invited email and grants the invite access.
   * An invitation only signs in an account whose email was never verified;
   * a verified account must sign in by code, so whoever holds an invitation
   * link (an instructor, a forwarded email) cannot take that account over.
   */
  async exchangeInvitation(
    token: string,
    userAgent: string,
    locale: Locale,
  ): Promise<
    | (SignedIn & { courseId: string })
    | { signInRequired: true; courseId: string; maskedEmail: string }
  > {
    const { enrollmentId, enrollment } =
      await this.lms.consumeInvitation(token);
    const { student } = await this.students.resolveOrCreate({
      email: enrollment.email,
      name: enrollment.name,
      locale,
      createdBy: "invite",
      verified: false,
    });
    if (student.value.status !== "active")
      throw new DomainError("ACCESS_DENIED", "This account is disabled.");
    await this.entitlements.grant({
      studentId: student.id,
      courseId: enrollment.courseId,
      source: "invite",
      sourceRef: inviteRef(enrollmentId, enrollment.invitedAt),
      expiresAt: null,
      actor: SYSTEM,
    });
    await this.lms.endInvitationSession(enrollmentId);
    if (student.value.emailVerifiedAt !== null) {
      const [local = "", domain = ""] = student.value.email.split("@");
      return {
        signInRequired: true,
        courseId: enrollment.courseId,
        maskedEmail: `${local.slice(0, 1)}***@${domain}`,
      };
    }
    const signedIn = await this.accounts.issue(
      student,
      "invitation",
      userAgent,
    );
    return { ...signedIn, courseId: enrollment.courseId };
  }

  /** "Keep your progress on any device": sends a code to the invitation's email. */
  async startUpgrade(
    legacyToken: unknown,
    origin: RequestOrigin,
    site: SiteRules,
  ): Promise<{ sent: true; maskedEmail: string }> {
    const state = await this.lms.library({}, legacyToken);
    if (!state.ok) throw new DomainError(state.error.code, state.error.message);
    const email = state.data.student.email;
    await this.accounts.start(
      { email, locale: "vi" },
      origin,
      { ...site, selfSignup: true },
      { kind: "upgrade", enrollmentId: state.data.enrollmentId },
    );
    const [local = "", domain = ""] = email.split("@");
    return { sent: true, maskedEmail: `${local.slice(0, 1)}***@${domain}` };
  }

  /**
   * After an upgrade code is verified: link the invitation to the account and
   * end the old session. A revoked or reissued invitation grants nothing, and a
   * revoke that lands during this call takes the new grant back.
   */
  async completeUpgrade(
    studentId: string,
    enrollmentId: string,
  ): Promise<void> {
    const info = await this.lms.enrollmentInfo(enrollmentId);
    if (!info?.active || (info.studentId && info.studentId !== studentId))
      return;
    const { entitlement, created } = await this.entitlements.grant({
      studentId,
      courseId: info.courseId,
      source: "invite",
      sourceRef: inviteRef(enrollmentId, info.invitedAt),
      expiresAt: null,
      actor: SYSTEM,
    });
    const after = await this.lms.enrollmentInfo(enrollmentId);
    if (created && (!after?.active || after.invitedAt !== info.invitedAt))
      await this.entitlements.revoke({
        entitlementId: entitlement.id,
        reason: "Invitation revoked during upgrade",
        actor: SYSTEM,
      });
    await this.lms.endInvitationSession(enrollmentId);
    await this.audit.record({
      actor: { type: "student", id: studentId, label: "Student" },
      action: "student.upgrade",
      subject: { type: "enrollment", id: enrollmentId },
    });
  }
}
