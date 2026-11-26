import { definePluginRoute, type RouteContext } from "emdash";
import { z } from "zod";
import { scheduleJobs, services, siteHost, type Services } from "../context.js";
import {
  mediaAssetsSchema,
  mediaRouteSchema,
  mediaTransitionSchema,
  saveMediaAssetSchema,
} from "../media/catalog.js";
import type { MediaLibrary, Result, StudentProfile } from "../model.js";
import { migrateSchema, integrity } from "../services/migration.js";
import { inviteRef } from "../services/entitlements.js";
import { all, result } from "../services/shared.js";
import { saveSiteSchema } from "../services/site.js";
import {
  removeStaffSchema,
  requireConfirmation,
  saveStaffSchema,
  staffActor,
  type Permission,
  type Staff,
} from "../services/staff.js";
import { emailSchema, profile } from "../services/students.js";
import {
  deleteLiveSessionSchema,
  DomainError,
  idSchema,
  inviteSchema,
  MAX_COURSE_BYTES,
  MAX_SUBMISSION_BYTES,
  parseInput,
  revokeSchema,
  saveSchema,
  studentsSchema,
  submissionsSchema,
  reviewSubmissionSchema,
  saveLiveSessionSchema,
} from "../validation.js";

const hex64 = z.string().regex(/^[a-f0-9]{64}$/);
const reasonFields = {
  confirmation: z.string().max(254),
  reason: z.string().max(500),
};

/** Unwraps an LmsService Result so route errors keep their codes. */
function unwrap<T>(value: Result<T>): T {
  if (!value.ok)
    throw new DomainError(
      value.error.code,
      value.error.message,
      value.error.details,
    );
  return value.data;
}

type Handler = (
  ctx: RouteContext,
  svc: Services,
  staff: Staff,
) => Promise<unknown>;

/**
 * Private workspace route. EmDash admits Contributor and above; the staff role
 * and course scope are then enforced in the service, not only in the UI.
 */
function admin(handler: Handler, maxBytes = 4096) {
  return definePluginRoute({
    methods: ["POST"],
    permission: "content:read_drafts",
    request: { body: "json", maxBytes },
    handler: async (ctx) =>
      result(async () => {
        const svc = await services(ctx);
        const staff = await svc.staff.resolve(ctx.user);
        return handler(ctx, svc, staff);
      }),
  });
}
function authorize(
  svc: Services,
  staff: Staff,
  permission: Permission,
  courseId?: string,
) {
  svc.staff.authorize(staff, permission, {
    courseId,
    instructorsMayGrant: svc.settings.instructorsMayGrant,
  });
}

const grantSchema = z.strictObject({
  studentEmail: emailSchema,
  studentName: z.string().trim().max(160),
  courseId: idSchema,
  expiresAt: z.string().datetime().nullable(),
  source: z.enum(["manual", "comp"]),
  requestKey: z.string().uuid(),
  ...reasonFields,
});
const revokeEntitlementSchema = z.strictObject({
  entitlementId: hex64,
  ...reasonFields,
});
const updateStudentSchema = z.strictObject({
  studentId: hex64,
  name: z.string().trim().min(1).max(160).optional(),
  email: emailSchema.optional(),
  status: z.enum(["active", "disabled"]).optional(),
  ...reasonFields,
});
const signOutStudentSchema = z.strictObject({
  studentId: hex64,
  ...reasonFields,
});
const studentDetailSchema = z.strictObject({ studentId: hex64 });
const directorySchema = z.strictObject({
  query: z.string().trim().max(254).optional(),
});
const auditSchema = z.strictObject({
  subjectId: z.string().max(200).optional(),
  actorId: z.string().max(200).optional(),
  action: z.string().max(100).optional(),
  cursor: z.string().max(200).optional(),
});
const notificationsSchema = z.strictObject({
  status: z.enum(["queued", "sent", "failed", "suppressed"]).optional(),
});
const resendSchema = z.strictObject({ notificationId: hex64 });
const testEmailSchema = z.strictObject({ to: emailSchema });
const entitlementsSchema = z.strictObject({ courseId: idSchema });
const saveSiteInputSchema = saveSiteSchema.extend(reasonFields).partial({
  confirmation: true,
  reason: true,
});
const empty = z.strictObject({});
const saveCourseInputSchema = saveSchema.extend(reasonFields).partial({
  confirmation: true,
  reason: true,
});
/** Typed to open a course to every signed-in student. */
export const OPEN_COURSE_PHRASE = "OPEN";
const liveSessionsSchema = z.strictObject({ courseId: idSchema });

/** Ends a student's open video sessions and linked invitation sessions in every course. */
async function endStudentSessions(svc: Services, studentId: string) {
  const courseIds = new Set(
    (await svc.entitlements.forStudent(studentId)).map((item) => item.courseId),
  );
  const playback = await svc.playback();
  for (const courseId of courseIds) {
    const enrollment = await svc.entitlements.enrollmentFor(
      studentId,
      courseId,
    );
    if (!enrollment) continue;
    await result(async () => playback.endForEnrollment(enrollment.id));
    await svc.lms.endInvitationSession(enrollment.id);
  }
}

export const adminRoutes = {
  "admin/me": admin(async (ctx, svc, staff) => {
    // plugin:activate may not run again on upgrade; scheduling is idempotent.
    if (staff.role === "owner") await scheduleJobs(ctx);
    return {
      role: staff.role,
      courseIds: staff.courseIds,
      permissions: svc.staff.permissions(
        staff,
        svc.settings.instructorsMayGrant,
      ),
    };
  }),

  // ---- Courses, roster and assignments (0.2 contracts, now scoped) ----
  "admin/courses": admin(async (ctx, svc, staff) => {
    const courses = unwrap(await svc.lms.courses(ctx.input));
    return courses.filter((course) => svc.staff.inScope(staff, course.id));
  }),
  "admin/save-course": admin(async (ctx, svc, staff) => {
    const { confirmation, reason, ...input } = parseInput(
      saveCourseInputSchema,
      ctx.input,
      MAX_COURSE_BYTES,
    );
    const existing = await svc.lms.courseAccess(input.id);
    if (existing) authorize(svc, staff, "course.edit", input.id);
    else authorize(svc, staff, "course.create");
    const before = existing?.access ?? "invite";
    const after = input.value.access ?? "invite";
    // Opening a course grants every signed-in student free access: it needs
    // the right to grant access for this course (owners; instructors only
    // where the site allows them to grant), a typed confirmation and a
    // reason, all audited. Closing it only needs course editing.
    const opening = after === "open" && before !== "open";
    if (opening)
      authorize(
        svc,
        staff,
        "entitlement.grant",
        existing ? input.id : undefined,
      );
    const why = opening
      ? requireConfirmation({
          confirmation: confirmation ?? "",
          expected: OPEN_COURSE_PHRASE,
          reason: reason ?? "",
        })
      : (reason ?? "").trim();
    const saved = unwrap(await svc.lms.saveCourse(input));
    if (!existing) await svc.staff.addCourse(staff, input.id);
    if (after !== before)
      await svc.audit.record({
        actor: staffActor(staff),
        action: "course.access",
        subject: { type: "course", id: input.id },
        before: { access: before },
        after: { access: after },
        reason: why,
      });
    return saved;
  }, MAX_COURSE_BYTES),
  "admin/students": admin(async (ctx, svc, staff) => {
    authorize(
      svc,
      staff,
      "roster.read",
      parseInput(studentsSchema, ctx.input).courseId,
    );
    return unwrap(await svc.lms.students(ctx.input));
  }),
  "admin/submissions": admin(async (ctx, svc, staff) => {
    authorize(
      svc,
      staff,
      "submissions.read",
      parseInput(submissionsSchema, ctx.input).courseId,
    );
    return unwrap(await svc.lms.submissions(ctx.input));
  }),
  "admin/review-submission": admin(async (ctx, svc, staff) => {
    const { courseId } = parseInput(
      reviewSubmissionSchema,
      ctx.input,
      MAX_SUBMISSION_BYTES,
    );
    authorize(svc, staff, "submissions.review", courseId);
    return unwrap(await svc.lms.reviewSubmission(ctx.input));
  }, MAX_SUBMISSION_BYTES),
  "admin/invite": admin(async (ctx, svc, staff) => {
    const { sendEmail, ...rest } = (ctx.input ?? {}) as { sendEmail?: unknown };
    const input = parseInput(inviteSchema, rest);
    authorize(svc, staff, "students.invite", input.courseId);
    const invited = unwrap(await svc.lms.invite(input));
    // The invitation also grants open-ended access to the invited email's account.
    const { student } = await svc.students.resolveOrCreate({
      email: input.email,
      name: input.name,
      locale: svc.settings.defaultLocale,
      createdBy: "invite",
      verified: false,
    });
    await svc.entitlements.grant({
      studentId: student.id,
      courseId: input.courseId,
      source: "invite",
      sourceRef: inviteRef(
        invited.student.id,
        Date.parse(invited.student.invitedAt),
      ),
      expiresAt: null,
      actor: staffActor(staff),
    });
    await result(async () =>
      (await svc.playback()).endForEnrollment(invited.student.id),
    );
    let emailStatus: string = "not_sent";
    if (sendEmail === true) {
      const course = await svc.lms.courseInfo(input.courseId);
      emailStatus = (
        await svc.notifications.send({
          email: input.email,
          template: "invitation",
          locale: student.value.locale,
          data: {
            siteName: svc.siteRules.siteName,
            courseTitle: course?.title ?? "",
            instructor: staff.label,
            link: `${ctx.url("/join")}#${invited.token}`,
          },
          dedupeKey: `${invited.student.id}:${invited.expiresAt}`,
          immediate: true,
        })
      ).status;
    }
    return { ...invited, emailStatus };
  }),
  "admin/revoke": admin(async (ctx, svc, staff) => {
    const { id } = parseInput(revokeSchema, ctx.input);
    const courseId = await svc.lms.enrollmentCourseId(id);
    if (!courseId) throw new DomainError("NOT_FOUND", "Student not found.");
    authorize(svc, staff, "students.revoke", courseId);
    const revoked = unwrap(await svc.lms.revoke(ctx.input));
    for (const entitlement of await svc.entitlements.list(courseId))
      if (
        entitlement.status === "active" &&
        entitlement.source === "invite" &&
        (entitlement.sourceRef === id ||
          entitlement.sourceRef.startsWith(`${id}:`))
      )
        await svc.entitlements.revoke({
          entitlementId: entitlement.id,
          reason: "Invitation revoked",
          actor: staffActor(staff),
        });
    await result(async () => (await svc.playback()).endForEnrollment(id));
    return revoked;
  }),

  // ---- Live sessions ----
  "admin/live-sessions": admin(async (ctx, svc, staff) => {
    const { courseId } = parseInput(liveSessionsSchema, ctx.input);
    authorize(svc, staff, "course.edit", courseId);
    if (!(await svc.lms.courseInfo(courseId)))
      throw new DomainError("NOT_FOUND", "Course not found.");
    return svc.liveSessions.list(courseId);
  }),
  "admin/save-live-session": admin(async (ctx, svc, staff) => {
    const input = parseInput(saveLiveSessionSchema, ctx.input, 8192);
    authorize(svc, staff, "course.edit", input.value.courseId);
    if (!(await svc.lms.courseInfo(input.value.courseId)))
      throw new DomainError("NOT_FOUND", "Course not found.");
    const { session, before } = await svc.liveSessions.save(input);
    // The join link and passcode are meeting credentials: kept out of the log.
    const summary = (value: {
      title: string;
      startsAt: number | string;
      durationMinutes: number;
    }) => ({
      title: value.title,
      startsAt: new Date(value.startsAt).toISOString(),
      durationMinutes: value.durationMinutes,
    });
    await svc.audit.record({
      actor: staffActor(staff),
      action: before ? "live_session.update" : "live_session.create",
      subject: { type: "live_session", id: input.id },
      before: before ? summary(before) : undefined,
      after: { courseId: session.courseId, ...summary(session) },
    });
    return session;
  }, 8192),
  "admin/delete-live-session": admin(async (ctx, svc, staff) => {
    const input = parseInput(deleteLiveSessionSchema, ctx.input);
    const courseId = await svc.liveSessions.courseOf(input.id);
    if (!courseId)
      throw new DomainError("NOT_FOUND", "Live session not found.");
    authorize(svc, staff, "course.edit", courseId);
    const deleted = await svc.liveSessions.remove(input);
    await svc.audit.record({
      actor: staffActor(staff),
      action: "live_session.delete",
      subject: { type: "live_session", id: input.id },
      before: {
        courseId,
        title: deleted.title,
        startsAt: new Date(deleted.startsAt).toISOString(),
        durationMinutes: deleted.durationMinutes,
      },
    });
    return { deleted: true };
  }),

  // ---- Lesson video ----
  "admin/media-assets": admin(async (ctx, svc, staff) => {
    const { courseId } = parseInput(mediaAssetsSchema, ctx.input);
    authorize(svc, staff, "course.edit", courseId);
    const settings = await svc.readMedia();
    return {
      assets: await svc.catalog.assets(courseId),
      route: await svc.catalog.routeState(),
      protectedVideo: {
        enabled: settings.enabled.doverunner,
        configured: settings.doverunner !== null,
      },
      wistiaPlayback: { enabled: settings.enabled.wistia },
    } satisfies MediaLibrary;
  }),
  "admin/save-media-asset": admin(async (ctx, svc, staff) => {
    const input = parseInput(saveMediaAssetSchema, ctx.input, 8192);
    authorize(svc, staff, "course.edit", input.value.courseId);
    return svc.catalog.save(input, siteHost(ctx.request));
  }, 8192),
  "admin/media-transition": admin(async (ctx, svc, staff) => {
    const input = parseInput(mediaTransitionSchema, ctx.input);
    const courseId = await svc.catalog.courseOf(input.mediaAssetId);
    if (!courseId) throw new DomainError("NOT_FOUND", "Video not found.");
    authorize(
      svc,
      staff,
      input.to === "published" ? "course.publish" : "course.edit",
      courseId,
    );
    const saved = await svc.catalog.transition(input);
    await svc.audit.record({
      actor: staffActor(staff),
      action: "media.transition",
      subject: { type: "media", id: input.mediaAssetId },
      after: { state: saved.state, provider: saved.provider },
      reason: input.note,
    });
    return saved;
  }),
  "admin/media-route": admin(async (ctx, svc, staff) => {
    authorize(svc, staff, "site.settings");
    const input = parseInput(mediaRouteSchema, ctx.input);
    const state = await svc.catalog.setRoute(input);
    await svc.audit.record({
      actor: staffActor(staff),
      action: "media.route",
      subject: { type: "site", id: "media" },
      after: state,
      reason: input.reason,
    });
    return state;
  }),

  // ---- Site, staff and audit (owner) ----
  "admin/site": admin(async (ctx, svc, staff) => {
    parseInput(empty, ctx.input);
    authorize(svc, staff, "site.settings");
    return svc.site.get();
  }),
  "admin/save-site": admin(async (ctx, svc, staff) => {
    authorize(svc, staff, "site.settings");
    const { confirmation, reason, ...input } = parseInput(
      saveSiteInputSchema,
      ctx.input,
      8192,
    );
    const current = await svc.site.get();
    const highImpact =
      JSON.stringify(current.settings.emailFrom) !==
        JSON.stringify(input.value.emailFrom) ||
      JSON.stringify(current.settings.locales) !==
        JSON.stringify(input.value.locales);
    const why = highImpact
      ? requireConfirmation({
          confirmation: confirmation ?? "",
          expected: current.settings.siteId,
          reason: reason ?? "",
        })
      : (reason ?? "");
    const saved = await svc.site.save(input);
    await svc.audit.record({
      actor: staffActor(staff),
      action: "site.update",
      subject: { type: "site", id: saved.settings.siteId },
      before: saved.before,
      after: saved.settings,
      reason: why,
    });
    return { settings: saved.settings, revision: saved.revision };
  }, 8192),
  "admin/test-email": admin(async (ctx, svc, staff) => {
    authorize(svc, staff, "site.settings");
    const { to } = parseInput(testEmailSchema, ctx.input);
    const sent = await svc.notifications.send({
      email: to,
      template: "test",
      data: { siteName: svc.siteRules.siteName },
      dedupeKey: `test:${Date.now()}`,
      immediate: true,
    });
    await svc.audit.record({
      actor: staffActor(staff),
      action: "site.test_email",
      subject: { type: "notification", id: sent.notificationId },
      after: { status: sent.status },
    });
    return { status: sent.status };
  }),
  "admin/staff": admin(async (ctx, svc, staff) => {
    parseInput(empty, ctx.input);
    authorize(svc, staff, "staff.manage");
    const users = ctx.users ? (await ctx.users.list({ limit: 100 })).items : [];
    return {
      staff: await svc.staff.list(),
      users: users.map((user) => ({
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      })),
    };
  }),
  "admin/save-staff": admin(async (ctx, svc, staff) => {
    const input = parseInput(saveStaffSchema, ctx.input);
    const user = await ctx.users?.get(input.userId);
    if (!user)
      throw new DomainError(
        "NOT_FOUND",
        "Invite this person through EmDash users first.",
      );
    return svc.staff.save(staff, input, user);
  }),
  "admin/remove-staff": admin(async (ctx, svc, staff) =>
    svc.staff.remove(staff, parseInput(removeStaffSchema, ctx.input)),
  ),
  "admin/audit": admin(async (ctx, svc, staff) => {
    authorize(svc, staff, "audit.read");
    return svc.audit.list(parseInput(auditSchema, ctx.input));
  }),
  "admin/notifications": admin(async (ctx, svc, staff) => {
    authorize(svc, staff, "notifications.manage");
    return svc.notifications.list(
      parseInput(notificationsSchema, ctx.input).status,
    );
  }),
  "admin/resend-notification": admin(async (ctx, svc, staff) => {
    authorize(svc, staff, "notifications.manage");
    const { notificationId } = parseInput(resendSchema, ctx.input);
    const queued = await svc.notifications.resend(notificationId);
    await svc.audit.record({
      actor: staffActor(staff),
      action: "notification.resend",
      subject: { type: "notification", id: notificationId },
    });
    return queued;
  }),

  // ---- Students and access ----
  "admin/students-directory": admin(async (ctx, svc, staff) => {
    authorize(svc, staff, "roster.read");
    const { query } = parseInput(directorySchema, ctx.input);
    const ids = new Set<string>();
    if (staff.courseIds === "all")
      for (const row of await all(svc.collections.students!)) ids.add(row.id);
    else
      for (const courseId of staff.courseIds)
        for (const entitlement of await svc.entitlements.list(courseId))
          ids.add(entitlement.studentId);
    const items: StudentProfile[] = [];
    for (const id of ids) {
      const student = await svc.students.get(id);
      if (!student) continue;
      const view = profile(student.id, student.value);
      if (
        !query ||
        view.email.includes(query.toLowerCase()) ||
        view.name.toLowerCase().includes(query.toLowerCase())
      )
        items.push(view);
    }
    return { items: items.slice(0, 100) };
  }),
  "admin/student": admin(async (ctx, svc, staff) => {
    const { studentId } = parseInput(studentDetailSchema, ctx.input);
    const student = await svc.students.get(studentId);
    if (!student) throw new DomainError("NOT_FOUND", "Student not found.");
    const entitlements = (await svc.entitlements.forStudent(studentId)).filter(
      (item) => svc.staff.inScope(staff, item.courseId),
    );
    if (staff.courseIds !== "all" && !entitlements.length)
      throw new DomainError("NOT_FOUND", "Student not found.");
    authorize(svc, staff, "roster.read");
    return {
      profile: {
        ...profile(student.id, student.value),
        status: student.value.status,
      },
      entitlements,
      recentAudit:
        staff.role === "owner"
          ? (await svc.audit.list({ subjectId: studentId })).items
          : [],
    };
  }),
  "admin/update-student": admin(async (ctx, svc, staff) => {
    authorize(svc, staff, "student.update");
    const input = parseInput(updateStudentSchema, ctx.input);
    let student = await svc.students.get(input.studentId);
    if (!student) throw new DomainError("NOT_FOUND", "Student not found.");
    const reason = requireConfirmation({
      confirmation: input.confirmation,
      expected: student.value.email,
      reason: input.reason,
    });
    const before = student.value;
    if (input.email && input.email !== student.value.email) {
      const oldEmail = student.value.email;
      student = await svc.students.changeEmail(student, input.email);
      await svc.notifications.send({
        email: oldEmail,
        template: "email_changed",
        data: {
          siteName: svc.siteRules.siteName,
          supportEmail: svc.settings.supportEmail,
        },
        dedupeKey: `${student.id}:${student.revision}`,
      });
    }
    if (input.name || input.status)
      student = await svc.students.update(student, {
        ...(input.name ? { name: input.name } : {}),
        ...(input.status ? { status: input.status } : {}),
      });
    if (input.status === "disabled") {
      student = await svc.students.rotate(student);
      await endStudentSessions(svc, student.id);
    }
    await svc.audit.record({
      actor: staffActor(staff),
      action: "student.update",
      subject: { type: "student", id: student.id },
      before,
      after: student.value,
      reason,
    });
    return profile(student.id, student.value);
  }),
  "admin/sign-out-student": admin(async (ctx, svc, staff) => {
    authorize(svc, staff, "student.update");
    const input = parseInput(signOutStudentSchema, ctx.input);
    const student = await svc.students.get(input.studentId);
    if (!student) throw new DomainError("NOT_FOUND", "Student not found.");
    const reason = requireConfirmation({
      confirmation: input.confirmation,
      expected: student.value.email,
      reason: input.reason,
    });
    await svc.students.rotate(student);
    await endStudentSessions(svc, student.id);
    await svc.audit.record({
      actor: staffActor(staff),
      action: "student.sign_out",
      subject: { type: "student", id: student.id },
      reason,
    });
    return { signedOut: true };
  }),
  "admin/grant": admin(async (ctx, svc, staff) => {
    const input = parseInput(grantSchema, ctx.input);
    authorize(svc, staff, "entitlement.grant", input.courseId);
    const reason = requireConfirmation({
      confirmation: input.confirmation,
      expected: input.studentEmail,
      reason: input.reason,
    });
    const { student } = await svc.students.resolveOrCreate({
      email: input.studentEmail,
      name: input.studentName,
      locale: svc.settings.defaultLocale,
      createdBy: "grant",
      verified: false,
    });
    return svc.entitlements.grant({
      studentId: student.id,
      courseId: input.courseId,
      source: input.source,
      sourceRef: input.requestKey,
      expiresAt: input.expiresAt ? Date.parse(input.expiresAt) : null,
      actor: staffActor(staff),
      reason,
    });
  }),
  "admin/revoke-entitlement": admin(async (ctx, svc, staff) => {
    const input = parseInput(revokeEntitlementSchema, ctx.input);
    const record = await svc.collections.entitlements!.getVersioned(
      input.entitlementId,
    );
    const grant = record?.value as
      | { courseId?: string; studentId?: string }
      | undefined;
    const student = grant?.studentId
      ? await svc.students.get(grant.studentId)
      : null;
    if (!grant?.courseId || !student)
      throw new DomainError("NOT_FOUND", "Access grant not found.");
    authorize(svc, staff, "entitlement.revoke", grant.courseId);
    const reason = requireConfirmation({
      confirmation: input.confirmation,
      expected: student.value.email,
      reason: input.reason,
    });
    const revoked = await svc.entitlements.revoke({
      entitlementId: input.entitlementId,
      reason,
      actor: staffActor(staff),
    });
    // New playback is already refused by canAccess; also free open sessions.
    const enrollment = await svc.entitlements.enrollmentFor(
      student.id,
      grant.courseId,
    );
    if (enrollment)
      await result(async () =>
        (await svc.playback()).endForEnrollment(enrollment.id),
      );
    return revoked;
  }),
  "admin/entitlements": admin(async (ctx, svc, staff) => {
    const { courseId } = parseInput(entitlementsSchema, ctx.input);
    authorize(svc, staff, "roster.read", courseId);
    return svc.entitlements.list(courseId);
  }),

  // ---- Upgrade tooling ----
  "admin/migrate-accounts": admin(async (ctx, svc, staff) => {
    authorize(svc, staff, "migrate");
    return svc.migration.run(
      parseInput(migrateSchema, ctx.input),
      staffActor(staff),
    );
  }),
  "admin/integrity": admin(async (ctx, svc, staff) => {
    parseInput(empty, ctx.input);
    authorize(svc, staff, "integrity");
    return integrity(svc.collections);
  }),
};
