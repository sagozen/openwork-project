import { z } from "zod";
import type { ActorRef, StaffRole, StaffView } from "../model.js";
import { DomainError, idSchema, readRecord, text } from "../validation.js";
import type { AuditLog } from "./audit.js";
import { all, type DomainCollection } from "./shared.js";

/** EmDash role levels (packages/core auth): Contributor 20, Editor 40, Admin 50. */
export const EMDASH_ADMIN = 50;
const EMDASH_CONTRIBUTOR = 20;

export type Permission =
  | "site.settings"
  | "staff.manage"
  | "audit.read"
  | "notifications.manage"
  | "migrate"
  | "integrity"
  | "course.create"
  | "course.edit"
  | "course.publish"
  | "students.invite"
  | "students.revoke"
  | "entitlement.grant"
  | "entitlement.revoke"
  | "student.update"
  | "roster.read"
  | "submissions.read"
  | "submissions.review"
  | "locale.translate"
  | "locale.review";

const OWNER_ONLY: Permission[] = [
  // Editing, disabling or signing out a student is site-wide, so owner-only.
  "student.update",
  "site.settings",
  "staff.manage",
  "audit.read",
  "notifications.manage",
  "migrate",
  "integrity",
];
const INSTRUCTOR: Permission[] = [
  "course.create",
  "course.edit",
  "course.publish",
  "students.invite",
  "students.revoke",
  "roster.read",
  "submissions.read",
  "submissions.review",
  "locale.translate",
  "locale.review",
];
const ASSISTANT: Permission[] = [
  "roster.read",
  "submissions.read",
  "submissions.review",
  "locale.review",
];
/** Granting and revoking access is owner-only unless the site allows instructors to grant (course-scoped). */
const GRANTS: Permission[] = ["entitlement.grant", "entitlement.revoke"];

export const staffRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  userId: z.string().min(1).max(200),
  displayName: text(200),
  email: z.string().max(254),
  role: z.enum(["owner", "instructor", "assistant"]),
  courseIds: z.union([z.literal("all"), z.array(idSchema).max(500)]),
  active: z.boolean(),
  createdAt: z.number().int().min(0),
  updatedBy: z.string().max(200),
});
type StaffRecord = z.infer<typeof staffRecordSchema>;
export const saveStaffSchema = z.strictObject({
  userId: z.string().min(1).max(200),
  revision: z.string().min(1).max(512).nullable(),
  role: z.enum(["owner", "instructor", "assistant"]),
  courseIds: z.union([z.literal("all"), z.array(idSchema).max(500)]),
  confirmation: z.string().max(254),
  reason: z.string().max(500),
});
export const removeStaffSchema = z.strictObject({
  userId: z.string().min(1).max(200),
  confirmation: z.string().max(254),
  reason: z.string().max(500),
});

export interface EmDashUser {
  id: string;
  email: string;
  name: string | null;
  role: number;
}
export interface Staff {
  userId: string;
  role: StaffRole;
  courseIds: string[] | "all";
  label: string;
}

export function staffActor(staff: Staff): ActorRef {
  return { type: staff.role, id: staff.userId, label: staff.label };
}

/**
 * The single staff step-up for high-impact actions: a typed confirmation phrase
 * and a reason, audited by the caller. EmDash does not expose admin sign-in
 * time, so this is not a recent-authentication check.
 */
export function requireConfirmation(input: {
  confirmation: string;
  expected: string;
  reason: string;
}): string {
  const reason = input.reason.trim();
  if (
    input.confirmation.trim().toLowerCase() !==
      input.expected.trim().toLowerCase() ||
    reason.length < 10 ||
    reason.length > 500
  )
    throw new DomainError(
      "CONFIRMATION_REQUIRED",
      `Type "${input.expected}" and give a reason of at least 10 characters to continue.`,
    );
  return reason;
}

function view(record: StaffRecord): StaffView {
  return {
    userId: record.userId,
    displayName: record.displayName,
    email: record.email,
    role: record.role,
    courseIds: record.courseIds,
    active: record.active,
  };
}

export class StaffService {
  constructor(
    private readonly staff: DomainCollection,
    private readonly audit: AuditLog,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Resolves the EmDash user behind a private route to a staff role. An EmDash
   * Admin without a staff row is bootstrapped as owner (0.2 behaviour).
   */
  async resolve(user: EmDashUser | undefined): Promise<Staff> {
    if (!user || user.role < EMDASH_CONTRIBUTOR)
      throw new DomainError(
        "FORBIDDEN_ROLE",
        "Your account does not have access to the MyTutor workspace.",
      );
    const record = await this.staff.getVersioned(user.id);
    const label = user.name || user.email;
    if (!record) {
      if (user.role < EMDASH_ADMIN)
        throw new DomainError(
          "FORBIDDEN_ROLE",
          "Ask the site owner to add you to the MyTutor workspace.",
        );
      const created: StaffRecord = {
        schemaVersion: 1,
        userId: user.id,
        displayName: label,
        email: user.email,
        role: "owner",
        courseIds: "all",
        active: true,
        createdAt: this.now(),
        updatedBy: "bootstrap",
      };
      const saved = await this.staff.compareAndSet(user.id, null, created);
      if (saved.applied)
        await this.audit.record({
          actor: { type: "system", id: "bootstrap", label: "Bootstrap" },
          action: "staff.bootstrap",
          subject: { type: "staff", id: user.id },
          after: { role: "owner" },
          key: `staff-bootstrap-${user.id}`,
        });
      return { userId: user.id, role: "owner", courseIds: "all", label };
    }
    const value = readRecord(staffRecordSchema, record.value);
    if (!value.active)
      throw new DomainError(
        "FORBIDDEN_ROLE",
        "Your workspace access has been removed.",
      );
    // A stale owner row below EmDash Admin acts as an instructor until fixed.
    const role =
      value.role === "owner" && user.role < EMDASH_ADMIN
        ? "instructor"
        : value.role;
    return { userId: user.id, role, courseIds: value.courseIds, label };
  }

  /** Throws unless `staff` holds `permission`, within `courseId` when scoped. */
  authorize(
    staff: Staff,
    permission: Permission,
    options: { courseId?: string; instructorsMayGrant?: boolean } = {},
  ): void {
    const allowed =
      staff.role === "owner" ||
      (staff.role === "instructor" &&
        (INSTRUCTOR.includes(permission) ||
          (GRANTS.includes(permission) &&
            options.instructorsMayGrant === true))) ||
      (staff.role === "assistant" && ASSISTANT.includes(permission));
    if (!allowed || (OWNER_ONLY.includes(permission) && staff.role !== "owner"))
      throw new DomainError(
        "FORBIDDEN_ROLE",
        "Your role does not allow this action.",
      );
    if (
      options.courseId !== undefined &&
      !this.inScope(staff, options.courseId)
    )
      throw new DomainError(
        "FORBIDDEN_ROLE",
        "This course is outside your assigned courses.",
      );
  }

  inScope(staff: Staff, courseId: string): boolean {
    return staff.courseIds === "all" || staff.courseIds.includes(courseId);
  }

  permissions(staff: Staff, instructorsMayGrant: boolean): Permission[] {
    const every = [...new Set([...OWNER_ONLY, ...INSTRUCTOR, ...GRANTS])];
    return every.filter((permission) => {
      try {
        this.authorize(staff, permission, { instructorsMayGrant });
        return true;
      } catch {
        return false;
      }
    });
  }

  /** An instructor who creates a course is scoped to it. */
  async addCourse(staff: Staff, courseId: string): Promise<void> {
    if (staff.courseIds === "all" || staff.courseIds.includes(courseId)) return;
    for (let attempt = 0; attempt < 3; attempt++) {
      const record = await this.staff.getVersioned(staff.userId);
      if (!record) return;
      const value = readRecord(staffRecordSchema, record.value);
      if (value.courseIds === "all" || value.courseIds.includes(courseId))
        return;
      const saved = await this.staff.compareAndSet(
        staff.userId,
        record.revision,
        {
          ...value,
          courseIds: [...value.courseIds, courseId],
        },
      );
      if (saved.applied) return;
    }
  }

  async list(): Promise<(StaffView & { revision: string })[]> {
    const items: (StaffView & { revision: string })[] = [];
    for (const row of await all(this.staff)) {
      const record = await this.staff.getVersioned(row.id);
      const parsed = record ? staffRecordSchema.safeParse(record.value) : null;
      if (record && parsed?.success)
        items.push({ ...view(parsed.data), revision: record.revision });
    }
    return items;
  }

  private async activeOwners(): Promise<string[]> {
    return (await this.list())
      .filter((item) => item.active && item.role === "owner")
      .map((item) => item.userId);
  }

  async save(
    actor: Staff,
    input: z.infer<typeof saveStaffSchema>,
    user: EmDashUser,
  ): Promise<StaffView> {
    this.authorize(actor, "staff.manage");
    const reason = requireConfirmation({
      confirmation: input.confirmation,
      expected: user.email,
      reason: input.reason,
    });
    if (input.role === "owner" && user.role < EMDASH_ADMIN)
      throw new DomainError(
        "VALIDATION",
        "Only EmDash administrators can be owners.",
      );
    const previous = await this.staff.getVersioned(input.userId);
    if ((previous?.revision ?? null) !== input.revision)
      throw new DomainError("CONFLICT", "This staff member changed. Reload.");
    const before = previous
      ? readRecord(staffRecordSchema, previous.value)
      : null;
    if (
      before?.role === "owner" &&
      before.active &&
      input.role !== "owner" &&
      (await this.activeOwners()).length <= 1
    )
      throw new DomainError(
        "CONFLICT",
        "The last active owner cannot be changed. Add another owner first.",
      );
    const next: StaffRecord = {
      schemaVersion: 1,
      userId: input.userId,
      displayName: user.name || user.email,
      email: user.email,
      role: input.role,
      courseIds: input.role === "owner" ? "all" : input.courseIds,
      active: true,
      createdAt: before?.createdAt ?? this.now(),
      updatedBy: actor.userId,
    };
    const saved = await this.staff.compareAndSet(
      input.userId,
      input.revision,
      next,
    );
    if (!saved.applied)
      throw new DomainError("CONFLICT", "This staff member changed. Reload.");
    await this.audit.record({
      actor: staffActor(actor),
      action: "staff.save",
      subject: { type: "staff", id: input.userId },
      before,
      after: next,
      reason,
    });
    return view(next);
  }

  async remove(
    actor: Staff,
    input: z.infer<typeof removeStaffSchema>,
  ): Promise<{ removed: true }> {
    this.authorize(actor, "staff.manage");
    const previous = await this.staff.getVersioned(input.userId);
    if (!previous)
      throw new DomainError("NOT_FOUND", "Staff member not found.");
    const before = readRecord(staffRecordSchema, previous.value);
    const reason = requireConfirmation({
      confirmation: input.confirmation,
      expected: before.email,
      reason: input.reason,
    });
    if (
      before.role === "owner" &&
      before.active &&
      (await this.activeOwners()).length <= 1
    )
      throw new DomainError(
        "CONFLICT",
        "The last active owner cannot be removed. Add another owner first.",
      );
    const saved = await this.staff.compareAndSet(
      input.userId,
      previous.revision,
      { ...before, active: false, updatedBy: actor.userId },
    );
    if (!saved.applied)
      throw new DomainError("CONFLICT", "This staff member changed. Reload.");
    await this.audit.record({
      actor: staffActor(actor),
      action: "staff.remove",
      subject: { type: "staff", id: input.userId },
      before,
      reason,
    });
    return { removed: true };
  }
}
