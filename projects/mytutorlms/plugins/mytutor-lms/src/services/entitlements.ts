import { z } from "zod";
import type {
  AccessDecision,
  AccessReason,
  ActorRef,
  EntitlementSource,
  EntitlementView,
} from "../model.js";
import {
  DomainError,
  enrollmentSchema,
  idSchema,
  readRecord,
  storedCourseSchema,
  text,
  type Enrollment,
} from "../validation.js";
import type { AuditLog } from "./audit.js";
import { all, key, secret, type DomainCollection } from "./shared.js";
import type { Student, StudentDirectory } from "./students.js";

const hex64 = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.number().int().min(0).max(8_640_000_000_000_000);
const actorSchema = z.strictObject({
  type: z.enum(["owner", "instructor", "assistant", "student", "system", "ai"]),
  id: z.string().max(200),
  label: z.string().max(200),
});
export const entitlementRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  studentId: hex64,
  courseId: idSchema,
  source: z.enum(["invite", "sepay", "whop", "manual", "comp"]),
  sourceRef: z.string().min(1).max(200),
  startsAt: timestamp,
  expiresAt: timestamp.nullable(),
  status: z.enum(["active", "revoked"]),
  grantedBy: actorSchema,
  grantedAt: timestamp,
  revokedAt: timestamp.nullable(),
  revokeReason: text(500),
});
type EntitlementRecord = z.infer<typeof entitlementRecordSchema>;

export interface GrantInput {
  studentId: string;
  courseId: string;
  source: EntitlementSource;
  sourceRef: string;
  startsAt?: number;
  expiresAt: number | null;
  actor: ActorRef;
  reason?: string;
  /** Skip the `access_granted` email, for access the student just took themselves. */
  silent?: boolean;
}
export interface EntitlementStorage {
  entitlements: DomainCollection;
  enrollments: DomainCollection;
  courses: DomainCollection;
}
/** Hook for the `access_granted` notification; the notification service plugs in here. */
export type GrantNotifier = (input: {
  studentId: string;
  courseId: string;
  entitlementId: string;
  expiresAt: number | null;
}) => Promise<void>;

const ENDING_SOON = 7 * 24 * 60 * 60 * 1000;
/**
 * Invite grants are keyed per invitation (enrollment and invitation time), so a
 * reissued invitation creates a new grant instead of replaying a revoked one.
 */
export const inviteRef = (enrollmentId: string, invitedAt: number) =>
  `${enrollmentId}:${invitedAt}`;
const iso = (value: number | null) =>
  value === null ? null : new Date(value).toISOString();

export function entitlementView(
  id: string,
  value: EntitlementRecord,
): EntitlementView {
  return {
    id,
    studentId: value.studentId,
    courseId: value.courseId,
    source: value.source,
    sourceRef: value.sourceRef,
    startsAt: iso(value.startsAt)!,
    expiresAt: iso(value.expiresAt),
    status: value.status,
    grantedBy: value.grantedBy,
    grantedAt: iso(value.grantedAt)!,
    revokedAt: iso(value.revokedAt),
    revokeReason: value.revokeReason,
  };
}
/** A later end date wins; no end date counts as latest. */
function laterEnd(a: number | null, b: number | null) {
  if (a === null) return true;
  if (b === null) return false;
  return a > b;
}
export function accessStatus(
  decision: AccessDecision,
  now: number,
): "active" | "ending_soon" | "ended" | "revoked" {
  if (decision.allowed)
    return decision.expiresAt &&
      Date.parse(decision.expiresAt) - now <= ENDING_SOON
      ? "ending_soon"
      : "active";
  return decision.reason === "revoked" ? "revoked" : "ended";
}

export class EntitlementService {
  constructor(
    private readonly storage: EntitlementStorage,
    private readonly students: StudentDirectory,
    private readonly audit: AuditLog,
    private readonly now: () => number = Date.now,
    private readonly notify: GrantNotifier = async () => {},
  ) {}

  private async course(courseId: string) {
    const record = await this.storage.courses.getVersioned(courseId);
    return record ? readRecord(storedCourseSchema, record.value).course : null;
  }

  async grant(
    input: GrantInput,
  ): Promise<{ entitlement: EntitlementView; created: boolean }> {
    const startsAt = input.startsAt ?? this.now();
    if (
      (input.source === "sepay" || input.source === "whop") &&
      input.expiresAt === null
    )
      throw new DomainError("VALIDATION", "Paid access needs an end date.");
    if (input.expiresAt !== null && startsAt >= input.expiresAt)
      throw new DomainError("VALIDATION", "Access must end after it starts.");
    const student = await this.students.get(input.studentId);
    if (!student || student.value.status !== "active")
      throw new DomainError("VALIDATION", "The student account is not active.");
    if (!(await this.course(input.courseId)))
      throw new DomainError("NOT_FOUND", "Course not found.");
    const id = await key("entitlement", input.source, input.sourceRef);
    const record: EntitlementRecord = {
      schemaVersion: 1,
      studentId: input.studentId,
      courseId: input.courseId,
      source: input.source,
      sourceRef: input.sourceRef,
      startsAt,
      expiresAt: input.expiresAt,
      status: "active",
      grantedBy: input.actor,
      grantedAt: this.now(),
      revokedAt: null,
      revokeReason: "",
    };
    const saved = await this.storage.entitlements.compareAndSet(
      id,
      null,
      record,
    );
    let created = saved.applied;
    let current = record;
    if (!saved.applied) {
      // Idempotent replay: same student, course and window returns the record
      // as it is, revoked or not. It is never reactivated.
      const existing = await this.storage.entitlements.getVersioned(id);
      current = readRecord(entitlementRecordSchema, existing!.value);
      if (
        current.studentId !== input.studentId ||
        current.courseId !== input.courseId ||
        current.expiresAt !== input.expiresAt ||
        (input.startsAt !== undefined && current.startsAt !== input.startsAt)
      )
        throw new DomainError(
          "CONFLICT",
          "This access grant already exists with different details.",
        );
      created = false;
    }
    await this.ensureEnrollment(student, input.courseId);
    await this.audit.record({
      actor: input.actor,
      action: "entitlement.grant",
      subject: { type: "entitlement", id },
      after: current,
      reason: input.reason,
      key: await key("audit", "entitlement.grant", id),
    });
    if (created && !input.silent)
      await this.notify({
        studentId: input.studentId,
        courseId: input.courseId,
        entitlementId: id,
        expiresAt: input.expiresAt,
      });
    return { entitlement: entitlementView(id, current), created };
  }

  async revoke(input: {
    entitlementId: string;
    reason: string;
    actor: ActorRef;
  }): Promise<{ entitlement: EntitlementView; changed: boolean }> {
    const now = this.now();
    const reason = input.reason.slice(0, 500);
    const updated = await this.storage.entitlements.updateIf(
      input.entitlementId,
      {
        where: { status: "active" },
        set: { status: "revoked", revokedAt: now, revokeReason: reason },
      },
    );
    const record = await this.storage.entitlements.getVersioned(
      input.entitlementId,
    );
    if (!record) throw new DomainError("NOT_FOUND", "Access grant not found.");
    const value = readRecord(entitlementRecordSchema, record.value);
    if (updated.applied)
      await this.audit.record({
        actor: input.actor,
        action: "entitlement.revoke",
        subject: { type: "entitlement", id: input.entitlementId },
        after: value,
        reason,
        key: await key("audit", "entitlement.revoke", input.entitlementId),
      });
    return {
      entitlement: entitlementView(input.entitlementId, value),
      changed: updated.applied,
    };
  }

  private async rows(studentId: string, courseId: string) {
    const rows: { id: string; value: EntitlementRecord }[] = [];
    for (const row of await all(this.storage.entitlements, {
      studentId,
      courseId,
    })) {
      const parsed = entitlementRecordSchema.safeParse(row.data);
      if (
        parsed.success &&
        parsed.data.studentId === studentId &&
        parsed.data.courseId === courseId
      )
        rows.push({ id: row.id, value: parsed.data });
    }
    return rows;
  }

  /** Active grant with the latest end, ignoring whether the course is published. */
  async current(input: {
    studentId: string;
    courseId: string;
    now?: number;
  }): Promise<EntitlementView | null> {
    const now = input.now ?? this.now();
    let best: { id: string; value: EntitlementRecord } | null = null;
    for (const row of await this.rows(input.studentId, input.courseId))
      if (
        row.value.status === "active" &&
        row.value.startsAt <= now &&
        (row.value.expiresAt === null || now < row.value.expiresAt) &&
        (!best || laterEnd(row.value.expiresAt, best.value.expiresAt))
      )
        best = row;
    return best ? entitlementView(best.id, best.value) : null;
  }

  async list(courseId: string): Promise<EntitlementView[]> {
    return (await all(this.storage.entitlements, { courseId })).flatMap(
      (row) => {
        const parsed = entitlementRecordSchema.safeParse(row.data);
        return parsed.success && parsed.data.courseId === courseId
          ? [entitlementView(row.id, parsed.data)]
          : [];
      },
    );
  }

  async forStudent(studentId: string): Promise<EntitlementView[]> {
    return (await all(this.storage.entitlements, { studentId })).flatMap(
      (row) => {
        const parsed = entitlementRecordSchema.safeParse(row.data);
        return parsed.success && parsed.data.studentId === studentId
          ? [entitlementView(row.id, parsed.data)]
          : [];
      },
    );
  }

  /**
   * The single access gate. Lesson release (0.5) and learning-path (0.7)
   * checks are added here, in that order, after the entitlement check.
   */
  async canAccess(input: {
    studentId: string;
    courseId: string;
    lessonId?: string;
    now?: number;
  }): Promise<AccessDecision> {
    const now = input.now ?? this.now();
    const deny = (reason: AccessReason, expiresAt: number | null = null) => ({
      allowed: false,
      reason,
      entitlementId: null,
      expiresAt: iso(expiresAt),
      opensAt: null,
    });
    const student = await this.students.get(input.studentId);
    if (!student || student.value.status !== "active")
      return deny("student_disabled");
    const course = await this.course(input.courseId);
    if (!course || course.status !== "published")
      return deny("course_unavailable");
    const rows = await this.rows(input.studentId, input.courseId);
    let best: { id: string; value: EntitlementRecord } | null = null;
    for (const row of rows)
      if (
        row.value.status === "active" &&
        row.value.startsAt <= now &&
        (row.value.expiresAt === null || now < row.value.expiresAt) &&
        (!best || laterEnd(row.value.expiresAt, best.value.expiresAt))
      )
        best = row;
    let decision: AccessDecision | null = best
      ? {
          allowed: true,
          reason: "ok",
          entitlementId: best.id,
          expiresAt: iso(best.value.expiresAt),
          opensAt: null,
        }
      : null;
    if (!decision && (await this.legacyInvitation(student, input.courseId)))
      // Safety net until the owner runs the account migration: an active 0.2
      // invitation enrollment counts as an open-ended invite grant.
      decision = {
        allowed: true,
        reason: "ok",
        entitlementId: null,
        expiresAt: null,
        opensAt: null,
      };
    if (!decision) {
      if (
        rows.some(
          (row) => row.value.status === "active" && row.value.startsAt > now,
        )
      )
        return deny("not_started");
      if (rows.some((row) => row.value.status === "active"))
        return deny(
          "ended",
          rows.reduce<number | null>(
            (latest, row) =>
              row.value.expiresAt !== null &&
              (latest === null || row.value.expiresAt > latest)
                ? row.value.expiresAt
                : latest,
            null,
          ),
        );
      return deny(rows.length ? "revoked" : "no_entitlement");
    }
    if (
      input.lessonId !== undefined &&
      !course.lessons.some((lesson) => lesson.id === input.lessonId)
    )
      return {
        ...deny("lesson_not_found"),
        entitlementId: decision.entitlementId,
      };
    return decision;
  }

  /**
   * Key of an active 0.2 invitation for this student's email, or null. By
   * default only unmigrated (version 1) rows count; `linked` also accepts a
   * row already linked to this student, for re-recording its grant.
   */
  async legacyInvitation(
    student: Student,
    courseId: string,
    linked = false,
  ): Promise<{ id: string; invitedAt: number } | null> {
    const id = await key(courseId, student.value.email);
    const record = await this.storage.enrollments.getVersioned(id);
    if (!record) return null;
    const parsed = enrollmentSchema.safeParse(record.value);
    if (
      !parsed.success ||
      !parsed.data.active ||
      parsed.data.courseId !== courseId
    )
      return null;
    const found = { id, invitedAt: parsed.data.invitedAt };
    if (parsed.data.schemaVersion === 1) return found;
    return linked && parsed.data.studentId === student.id ? found : null;
  }

  /**
   * Records an active 0.2 invitation as the account's invite grant (the same
   * step the owner migration performs), so access no longer depends on the
   * unmigrated record. Revoked invitations get nothing.
   */
  async adoptLegacyInvitation(
    student: Student,
    courseId: string,
  ): Promise<boolean> {
    const legacy = await this.legacyInvitation(student, courseId, true);
    if (!legacy) return false;
    await this.grant({
      studentId: student.id,
      courseId,
      source: "invite",
      sourceRef: inviteRef(legacy.id, legacy.invitedAt),
      expiresAt: null,
      actor: { type: "system", id: "accounts", label: "Accounts" },
      reason: "Invitation linked to account",
    });
    return true;
  }

  /** The student × course enrollment that holds progress; created or linked on first grant. */
  async enrollmentFor(
    studentId: string,
    courseId: string,
  ): Promise<{ id: string; value: Enrollment } | null> {
    for (const row of await all(this.storage.enrollments, { studentId })) {
      const parsed = enrollmentSchema.safeParse(row.data);
      if (
        parsed.success &&
        parsed.data.schemaVersion === 2 &&
        parsed.data.studentId === studentId &&
        parsed.data.courseId === courseId
      )
        return { id: row.id, value: parsed.data };
    }
    return null;
  }

  async ensureEnrollment(student: Student, courseId: string): Promise<string> {
    const linked = await this.enrollmentFor(student.id, courseId);
    if (linked) {
      if (!linked.value.active)
        await this.storage.enrollments.updateIf(linked.id, {
          where: { generation: linked.value.generation },
          set: { active: true },
        });
      return linked.id;
    }
    // A 0.2 invitation enrollment for this email keeps its key, progress and work.
    const legacyId = await key(courseId, student.value.email);
    const legacy = await this.storage.enrollments.getVersioned(legacyId);
    if (legacy) {
      const value = readRecord(enrollmentSchema, legacy.value);
      if (value.schemaVersion === 2 && value.studentId !== student.id)
        throw new DomainError(
          "UNSUPPORTED_RECORD",
          "The enrollment requires administrator review.",
        );
      // Linking never reactivates: a revoked invitation stays revoked.
      await this.storage.enrollments.updateIf(legacyId, {
        where: { generation: value.generation },
        set: { schemaVersion: 2, studentId: student.id },
      });
      return legacyId;
    }
    const id = await key("enrollment", courseId, student.id);
    const value: Enrollment = {
      schemaVersion: 2,
      studentId: student.id,
      courseId,
      name: student.value.name,
      email: student.value.email,
      active: true,
      generation: secret(),
      invitedAt: this.now(),
      invitationHash: null,
      invitationExpiresAt: null,
      sessionHash: null,
      sessionGeneration: null,
      sessionExpiresAt: null,
      lastActiveAt: null,
    };
    await this.storage.enrollments.compareAndSet(id, null, value);
    return id;
  }
}
