import type { PluginContext } from "emdash";
import { MediaCatalog } from "./media/catalog.js";
import { PlaybackService, type MediaSettings } from "./media/playback.js";
import { LmsService } from "./service.js";
import {
  AccountService,
  type RequestOrigin,
  type SiteRules,
} from "./services/accounts.js";
import { AuditLog } from "./services/audit.js";
import { EntitlementService } from "./services/entitlements.js";
import { StudentLearning } from "./services/learning.js";
import { AccountMigration } from "./services/migration.js";
import {
  LiveSessionService,
  type LiveSessionCollection,
} from "./services/live-sessions.js";
import { NotificationService } from "./services/notifications.js";
import { RateLimiter } from "./services/rate-limit.js";
import { digest } from "./services/shared.js";
import { SiteService, siteIdFromUrl } from "./services/site.js";
import { StaffService } from "./services/staff.js";
import { StudentDirectory } from "./services/students.js";
import { DomainError, idSchema } from "./validation.js";

export const settingsSchema = {
  protectedVideo: {
    type: "boolean",
    label: "Enable DoveRunner secure video",
    description:
      "Students can play published DoveRunner lessons. Leave off until a real device test passes.",
  },
  doverunnerSiteId: {
    type: "string",
    label: "DoveRunner site ID",
    description: "From DoveRunner Console > Multi-DRM > DRM Settings.",
  },
  doverunnerSiteKey: {
    type: "secret",
    label: "DoveRunner site key",
    description: "32-character site key. Stored encrypted.",
  },
  doverunnerAccessKey: {
    type: "secret",
    label: "DoveRunner access key",
    description: "32-character access key. Stored encrypted.",
  },
  wistiaPlayback: {
    type: "boolean",
    label: "Allow Wistia playback (not DRM)",
    description:
      "Students can play published Wistia lessons. Access is limited to enrolled students, but Wistia videos are not copy-protected. Turn on Wistia domain restrictions for this site.",
  },
  doverunnerStreamLimit: {
    type: "boolean",
    label: "Let DoveRunner enforce the screen limit",
    description:
      "Adds the screen limit to each DoveRunner license so a replaced screen is refused at the license server. Turn on only after enabling Concurrent Stream Limiting in DoveRunner Console; otherwise licenses fail.",
  },
  deviceLimit: {
    type: "number",
    label: "Screens per student (checked when a video starts)",
    description:
      "1 to 5. Default 1. A screen already playing keeps its license until the session ends unless DoveRunner enforces the limit.",
  },
  licenseWindowMinutes: {
    type: "number",
    label: "Playback session length (minutes)",
    description:
      "15 to 720. Default 240. Never longer than the student's remaining access.",
  },
} as const;

const clamp = (value: unknown, min: number, max: number, fallback: number) =>
  typeof value === "number" && Number.isInteger(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
const accessKey = (value: unknown) =>
  typeof value === "string" && /^[\x21-\x7e]{32}$/.test(value) ? value : null;

const REF_KEY = "state:student-ref-key";
/** Per-site random key for opaque learner references and daily IP hashes, created once. */
async function siteSecretKey(context: PluginContext): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await context.kv.getVersioned<string>(REF_KEY);
    if (current && typeof current.value === "string") return current.value;
    const key = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    const saved = await context.kv.compareAndSet(
      REF_KEY,
      current?.revision ?? null,
      key,
    );
    if (saved.applied) return key;
  }
  throw new Error("Could not initialize the site key.");
}

// Schema defaults are not persisted, so fallbacks are applied at read time.
async function mediaSettings(
  context: PluginContext,
  studentRefKey: string,
): Promise<MediaSettings> {
  const get = (key: keyof typeof settingsSchema) =>
    context.settings.get<unknown>(key);
  const siteId = await get("doverunnerSiteId");
  const siteKey = accessKey(await get("doverunnerSiteKey"));
  const access = accessKey(await get("doverunnerAccessKey"));
  const doverunner =
    typeof siteId === "string" &&
    /^[A-Za-z0-9]{1,32}$/.test(siteId) &&
    siteKey &&
    access
      ? { siteId, siteKey, accessKey: access }
      : null;
  return {
    enabled: {
      doverunner: (await get("protectedVideo")) === true && doverunner !== null,
      wistia: (await get("wistiaPlayback")) === true,
    },
    doverunner,
    concurrentStreamLimit: (await get("doverunnerStreamLimit")) === true,
    deviceLimit: clamp(await get("deviceLimit"), 1, 5, 1),
    licenseWindowMinutes: clamp(
      await get("licenseWindowMinutes"),
      15,
      720,
      240,
    ),
    studentRefKey,
  };
}

// EmDash task names allow only letters, numbers, dashes and underscores.
export const DISPATCH_JOB = "notifications-dispatch";
export const EXPIRY_JOB = "entitlements-expiry-notices";
/** Idempotent; cron expressions are UTC. */
export async function scheduleJobs(context: PluginContext) {
  await context.cron?.schedule(DISPATCH_JOB, { schedule: "*/1 * * * *" });
  await context.cron?.schedule(EXPIRY_JOB, { schedule: "0 * * * *" });
}

/** Every service of one request, built from the EmDash plugin context. */
export async function services(context: PluginContext) {
  // EmDash collections implement the full storage API; services take the subsets they use.
  const s = context.storage as unknown as Record<string, LiveSessionCollection>;
  const fallbackSiteId = siteIdFromUrl(context.site.url);
  const site = new SiteService(s.site!, fallbackSiteId);
  const { settings } = await site.get();
  const audit = new AuditLog(s.auditEvents!, settings.siteId);
  const students = new StudentDirectory({
    students: s.students!,
    studentEmails: s.studentEmails!,
  });
  const email = context.email;
  const notifications = new NotificationService(
    s.notifications!,
    students,
    email ? { send: (message) => email.send(message) } : null,
    { locale: settings.defaultLocale, replyTo: settings.emailFrom.replyTo },
  );
  const key = await siteSecretKey(context);
  let media: Promise<MediaSettings> | undefined;
  const readMedia = () => (media ??= mediaSettings(context, key));
  // The lesson service, the catalog and student learning need each other;
  // the callbacks below read these once every service exists.
  const late = {} as { catalog: MediaCatalog; learning: StudentLearning };
  const liveSessions = new LiveSessionService(s.liveSessions!);
  const limits = new RateLimiter(s.rateLimits!);
  const lms = new LmsService(
    {
      courses: s.courses!,
      enrollments: s.enrollments!,
      progress: s.progress!,
      submissions: s.submissions!,
      courseOptions: s.courseOptions!,
    },
    Date.now,
    async (courseId, ids) =>
      late.catalog.playableLessons(courseId, ids, (await readMedia()).enabled),
    {
      enrollment: (token, courseId) =>
        late.learning.enrollment(token, courseId),
      studentId: (token) => late.learning.studentId(token),
      allowed: (studentId, courseId) =>
        late.learning.allowed(studentId, courseId),
    },
    (courseId) => liveSessions.forStudents(courseId),
  );
  const entitlements = new EntitlementService(
    {
      entitlements: s.entitlements!,
      enrollments: s.enrollments!,
      courses: s.courses!,
    },
    students,
    audit,
    Date.now,
    async ({ studentId, courseId, entitlementId, expiresAt }) => {
      const course = await lms.courseInfo(courseId);
      await notifications.send({
        studentId,
        template: "access_granted",
        data: {
          courseTitle: course?.title ?? "",
          url: context.url("/sign-in"),
          ...(expiresAt
            ? { expiresAt: new Date(expiresAt).toISOString().slice(0, 10) }
            : {}),
        },
        dedupeKey: entitlementId,
      });
    },
  );
  const accounts = new AccountService(
    {
      signInChallenges: s.signInChallenges!,
      studentSessions: s.studentSessions!,
    },
    students,
    notifications,
    limits,
    audit,
  );
  const learning = (late.learning = new StudentLearning(
    accounts,
    students,
    entitlements,
    lms,
    audit,
    Date.now,
    limits,
  ));
  const catalog = (late.catalog = new MediaCatalog(
    {
      mediaAssets: s.mediaAssets!,
      mediaRouteState: s.mediaRouteState!,
      mediaLive: s.mediaLive!,
    },
    (courseId) => lms.lessonContent(courseId),
  ));
  const playback = async () =>
    new PlaybackService(
      {
        playbackSessions: s.playbackSessions!,
        playbackSlots: s.playbackSlots!,
      },
      catalog,
      lms,
      await readMedia(),
    );
  const siteRules: SiteRules = {
    siteName: context.site.name,
    verifyUrl: context.url("/sign-in/verify"),
    selfSignup: settings.selfSignup,
    locales: settings.locales,
    dailySignInEmailCap: settings.dailySignInEmailCap,
  };
  return {
    settings,
    site,
    audit,
    students,
    notifications,
    lms,
    entitlements,
    accounts,
    learning,
    liveSessions,
    catalog,
    playback,
    readMedia,
    siteRules,
    staff: new StaffService(s.staff!, audit),
    migration: new AccountMigration(
      s.enrollments!,
      students,
      entitlements,
      audit,
    ),
    collections: s,
    /** Daily-salted IP hash so rate limits never store raw addresses. */
    clientHash: async (ip: string | null) =>
      ip
        ? digest(
            JSON.stringify([
              "ip",
              new Date().toISOString().slice(0, 10),
              key,
              ip,
            ]),
          )
        : "",
  };
}
export type Services = Awaited<ReturnType<typeof services>>;

export function siteHost(request: Request): string {
  return new URL(request.url).host.slice(0, 253);
}

/** Request facts for sign-in: the pre-auth binding cookie, a hashed client IP and the user agent. */
export async function requestOrigin(
  svc: Services,
  ctx: { request: Request; requestMeta?: { ip: string | null } },
): Promise<RequestOrigin> {
  const request = ctx.request;
  const binding = request.headers.get("x-mytutor-binding") ?? "";
  if (!/^[a-f0-9]{64}$/.test(binding))
    throw new DomainError(
      "VALIDATION",
      "Open the sign-in page on this website and try again.",
    );
  return {
    binding,
    // EmDash's own IP (trusted CF-Connecting-IP or configured proxy headers)
    // wins; only requests without one (the in-process theme bridge) use the
    // bridge's header, which it copies from Cloudflare's connecting IP.
    clientHash: await svc.clientHash(
      ctx.requestMeta?.ip ?? request.headers.get("x-mytutor-client"),
    ),
    userAgent: (request.headers.get("user-agent") ?? "").slice(0, 400),
  };
}

/**
 * The learner credential of a student request: an account session for one
 * course (`x-mytutor-student` + `courseId`), else a 0.2 invitation session.
 */
export function studentCredential(
  request: Request,
  input: unknown,
): { credential: unknown; input: unknown } {
  const student = request.headers.get("x-mytutor-student");
  if (!student)
    return { credential: request.headers.get("x-mytutor-session"), input };
  if (!input || typeof input !== "object")
    throw new DomainError("VALIDATION", "Choose a course.");
  const { courseId, ...rest } = input as Record<string, unknown>;
  const parsed = idSchema.safeParse(courseId);
  if (!parsed.success) throw new DomainError("VALIDATION", "Choose a course.");
  const expected = request.headers.get("x-mytutor-enrollment");
  return {
    credential: {
      student,
      courseId: parsed.data,
      ...(expected ? { expectedEnrollmentId: expected } : {}),
    },
    input: rest,
  };
}
