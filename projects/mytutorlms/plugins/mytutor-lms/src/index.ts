import {
  definePlugin,
  type PluginContext,
  type PluginDescriptor,
} from "emdash";
import {
  DISPATCH_JOB,
  EXPIRY_JOB,
  scheduleJobs,
  services,
  settingsSchema,
} from "./context.js";
import { adminRoutes } from "./routes/admin.js";
import { studentRoutes } from "./routes/student.js";
import { expiryNotices } from "./services/expiry.js";

export const VERSION = "0.4.0";

const storage = {
  courses: { indexes: [] },
  enrollments: { indexes: ["courseId", "studentId"] },
  progress: { indexes: ["enrollmentId"] },
  submissions: { indexes: ["enrollmentId", "courseId"] },
  mediaAssets: { indexes: ["courseId", "lessonId"] },
  mediaRouteState: { indexes: [] },
  mediaLive: { indexes: ["courseId", "lessonId"] },
  playbackSlots: { indexes: [] },
  playbackSessions: {
    indexes: ["studentId", "enrollmentId", "watermarkSessionId"],
  },
  site: { indexes: [] },
  students: { indexes: ["email", "status"] },
  studentEmails: { indexes: [] },
  studentSessions: { indexes: ["studentId"] },
  signInChallenges: { indexes: [] },
  entitlements: { indexes: ["studentId", "courseId", "status"] },
  auditEvents: { indexes: ["subjectId", "actorId", "action", "at"] },
  notifications: { indexes: ["status", "recipientId"] },
  staff: { indexes: ["role"] },
  rateLimits: { indexes: [] },
  // 0.4: course options stay out of the course record so 0.3 can still read it.
  courseOptions: { indexes: [] },
  liveSessions: { indexes: ["courseId"] },
};
const adminPages = [
  { path: "/workspace", label: "MyTutor workspace", icon: "GraduationCap" },
];
const adminEntry = "@mytutor/plugin-mytutor-lms/admin";

export function mytutorLmsPlugin(): PluginDescriptor {
  return {
    id: "mytutor-lms",
    version: VERSION,
    format: "native",
    entrypoint: "@mytutor/plugin-mytutor-lms",
    adminEntry,
    adminPages,
    storage,
  };
}

async function runJob(name: string, context: PluginContext) {
  const svc = await services(context);
  if (name === DISPATCH_JOB) await svc.notifications.dispatch();
  if (name === EXPIRY_JOB) await expiryNotices(svc);
}

export function createPlugin() {
  return definePlugin({
    id: "mytutor-lms",
    version: VERSION,
    // email:send gives ctx.email (the site's configured provider);
    // users:read lists EmDash users when the owner adds staff.
    capabilities: ["email:send", "users:read"],
    storage,
    admin: { entry: adminEntry, pages: adminPages, settingsSchema },
    hooks: {
      // Cron expressions are UTC.
      "plugin:activate": async (_event, ctx) => scheduleJobs(ctx),
      cron: async (event, ctx) => runJob(event.name, ctx),
    },
    routes: { ...adminRoutes, ...studentRoutes },
  });
}
