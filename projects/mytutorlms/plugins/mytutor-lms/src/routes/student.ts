import { definePluginRoute, type RouteContext } from "emdash";
import { without } from "../object.js";
import { z } from "zod";
import {
  requestOrigin,
  services,
  siteHost,
  studentCredential,
  type Services,
} from "../context.js";
import { playbackEndSchema, playbackSchema } from "../media/playback.js";
import type { Result } from "../model.js";
import {
  revokeSessionSchema,
  startSchema,
  updateMeSchema,
  verifyCodeSchema,
  verifyLinkSchema,
} from "../services/accounts.js";
import { result } from "../services/shared.js";
import {
  DomainError,
  idSchema,
  MAX_SUBMISSION_BYTES,
  parseInput,
  tokenSchema,
} from "../validation.js";

const STUDENT = "x-mytutor-student";
const LEGACY = "x-mytutor-session";
const SIGN_IN_HEADERS = ["x-mytutor-binding", "x-mytutor-client", "user-agent"];
const LEARNER_HEADERS = [STUDENT, LEGACY, "x-mytutor-enrollment"];
const empty = z.strictObject({});
const localeInput = z.strictObject({
  locale: z.enum(["vi", "en", "es"]).optional(),
});

function unwrap<T>(value: Result<T>): T {
  if (!value.ok)
    throw new DomainError(
      value.error.code,
      value.error.message,
      value.error.details,
    );
  return value.data;
}

/** Public route: no CMS authentication; each handler checks its own student credential. */
function student(
  handler: (ctx: RouteContext, svc: Services) => Promise<unknown>,
  options: { maxBytes?: number; headers?: string[] } = {},
) {
  return definePluginRoute({
    methods: ["POST"],
    public: true,
    cacheControl: "private, no-store",
    request: {
      body: "json",
      maxBytes: options.maxBytes ?? 4096,
      headers: options.headers ?? LEARNER_HEADERS,
    },
    handler: async (ctx) =>
      result(async () => handler(ctx, await services(ctx))),
  });
}
const header = (ctx: RouteContext, name: string) =>
  ctx.request.headers.get(name) ?? "";

export const studentRoutes = {
  site: definePluginRoute({
    methods: ["GET"],
    public: true,
    cacheControl: "public, max-age=60",
    request: { body: "none" },
    handler: async (ctx) =>
      result(async () =>
        (await services(ctx)).site.publicSite({
          name: ctx.site.name,
          url: ctx.site.url,
        }),
      ),
  }),
  catalog: definePluginRoute({
    methods: ["GET"],
    public: true,
    cacheControl: "private, no-store",
    request: { body: "none" },
    // Published courses with their upcoming live sessions: titles and times
    // only, never join links or passcodes.
    handler: async (ctx) =>
      result(async () => {
        const svc = await services(ctx);
        const courses = unwrap(await svc.lms.catalog());
        return Promise.all(
          courses.map(async (course) => ({
            ...course,
            upcomingSessions: await svc.liveSessions.upcoming(course.id),
          })),
        );
      }),
  }),

  // ---- Sign-in ----
  "auth/start": student(
    async (ctx, svc) => {
      const input = parseInput(startSchema, ctx.input);
      if (!svc.settings.locales.includes(input.locale))
        input.locale = svc.settings.defaultLocale;
      return svc.accounts.start(
        input,
        await requestOrigin(svc, ctx),
        svc.siteRules,
      );
    },
    { headers: SIGN_IN_HEADERS },
  ),
  "auth/verify-code": student(
    async (ctx, svc) => {
      const signed = await svc.accounts.verifyCode(
        parseInput(verifyCodeSchema, ctx.input),
        await requestOrigin(svc, ctx),
        svc.settings.defaultLocale,
      );
      if (signed.upgradeEnrollmentId)
        await svc.learning.completeUpgrade(
          signed.student.id,
          signed.upgradeEnrollmentId,
        );
      return without(signed, "upgradeEnrollmentId");
    },
    { headers: SIGN_IN_HEADERS },
  ),
  "auth/verify-link": student(
    async (ctx, svc) => {
      const outcome = await svc.accounts.verifyLink(
        parseInput(verifyLinkSchema, ctx.input),
        await requestOrigin(svc, ctx),
        svc.settings.defaultLocale,
      );
      if (!("sessionToken" in outcome)) return outcome;
      if (outcome.upgradeEnrollmentId)
        await svc.learning.completeUpgrade(
          outcome.student.id,
          outcome.upgradeEnrollmentId,
        );
      return without(outcome, "upgradeEnrollmentId");
    },
    { headers: SIGN_IN_HEADERS },
  ),
  "auth/upgrade": student(
    async (ctx, svc) => {
      parseInput(empty, ctx.input);
      return svc.learning.startUpgrade(
        header(ctx, LEGACY),
        await requestOrigin(svc, ctx),
        svc.siteRules,
      );
    },
    { headers: [LEGACY, ...SIGN_IN_HEADERS] },
  ),
  "auth/exchange-invitation": student(
    async (ctx, svc) => {
      const { token } = parseInput(
        z.strictObject({ token: tokenSchema }),
        ctx.input,
      );
      return svc.learning.exchangeInvitation(
        token,
        header(ctx, "user-agent"),
        svc.settings.defaultLocale,
      );
    },
    { headers: ["user-agent"] },
  ),
  "auth/logout": student(async (ctx, svc) => {
    parseInput(empty, ctx.input);
    return svc.accounts.logout(header(ctx, STUDENT));
  }),
  "auth/logout-all": student(async (ctx, svc) => {
    parseInput(empty, ctx.input);
    const current = await svc.accounts.access(header(ctx, STUDENT));
    const loggedOut = await svc.accounts.logoutAll(current);
    // Linked invitation sessions in this browser or elsewhere end as well.
    for (const grant of await svc.entitlements.forStudent(current.student.id)) {
      const enrollment = await svc.entitlements.enrollmentFor(
        current.student.id,
        grant.courseId,
      );
      if (enrollment) await svc.lms.endInvitationSession(enrollment.id);
    }
    return loggedOut;
  }),

  // ---- Account ----
  me: student(async (ctx, svc) => {
    parseInput(empty, ctx.input);
    return svc.accounts.me(await svc.accounts.access(header(ctx, STUDENT)));
  }),
  "me/update": student(async (ctx, svc) =>
    svc.accounts.updateMe(
      await svc.accounts.access(header(ctx, STUDENT)),
      parseInput(updateMeSchema, ctx.input),
      svc.settings.locales,
    ),
  ),
  "me/revoke-session": student(async (ctx, svc) =>
    svc.accounts.revokeSession(
      await svc.accounts.access(header(ctx, STUDENT)),
      parseInput(revokeSessionSchema, ctx.input).sessionId,
    ),
  ),
  dashboard: student(async (ctx, svc) => {
    parseInput(localeInput, ctx.input);
    return svc.learning.dashboard(header(ctx, STUDENT));
  }),
  // "Start learning" on an open course: a signed-in account only.
  join: student(async (ctx, svc) => {
    const { courseId } = parseInput(
      z.strictObject({ courseId: idSchema }),
      ctx.input,
    );
    return svc.learning.joinOpenCourse(header(ctx, STUDENT), courseId);
  }),
  classroom: student(async (ctx, svc) => {
    const { courseId } = parseInput(
      z.strictObject({ courseId: idSchema }),
      ctx.input,
    );
    return unwrap(
      await svc.lms.library({}, { student: header(ctx, STUDENT), courseId }),
    );
  }),

  // ---- Learning (0.2 routes; a student account adds courseId) ----
  // 0.2 route kept for one release: it now creates the account, like auth/exchange-invitation.
  exchange: student(
    async (ctx, svc) => {
      const { token } = parseInput(
        z.strictObject({ token: tokenSchema }),
        ctx.input,
      );
      return svc.learning.exchangeInvitation(
        token,
        header(ctx, "user-agent"),
        svc.settings.defaultLocale,
      );
    },
    { headers: ["user-agent"] },
  ),
  library: student(async (ctx, svc) => {
    // Old classroom tabs: an account session gets its dashboard instead.
    if (header(ctx, STUDENT)) {
      parseInput(empty, ctx.input);
      return svc.learning.dashboard(header(ctx, STUDENT));
    }
    return unwrap(await svc.lms.library(ctx.input, header(ctx, LEGACY)));
  }),
  complete: student(async (ctx, svc) => {
    const { credential, input } = studentCredential(ctx.request, ctx.input);
    return unwrap(await svc.lms.complete(input, credential));
  }),
  submit: student(
    async (ctx, svc) => {
      const { credential, input } = studentCredential(ctx.request, ctx.input);
      return unwrap(await svc.lms.submit(input, credential));
    },
    { maxBytes: MAX_SUBMISSION_BYTES },
  ),
  playback: student(async (ctx, svc) => {
    const input = parseInput(playbackSchema, ctx.input);
    const credential = header(ctx, STUDENT)
      ? { student: header(ctx, STUDENT), courseId: input.courseId }
      : header(ctx, LEGACY);
    return (await svc.playback()).issue(
      input,
      credential,
      siteHost(ctx.request),
    );
  }),
  playbackEnd: student(async (ctx, svc) => {
    const input = parseInput(playbackEndSchema, ctx.input);
    const credential = header(ctx, STUDENT)
      ? { student: header(ctx, STUDENT), courseId: "" }
      : header(ctx, LEGACY);
    return (await svc.playback()).endPlayback(input, credential);
  }),
  logout: student(async (ctx, svc) => {
    const token = header(ctx, LEGACY);
    const owner = await svc.lms.sessionOwner(token).catch(() => null);
    const loggedOut = unwrap(await svc.lms.logout(ctx.input, token));
    if (owner)
      await result(async () => (await svc.playback()).endForEnrollment(owner));
    return loggedOut;
  }),
};
