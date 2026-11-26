import type { Services } from "../context.js";
import { entitlementRecordSchema } from "./entitlements.js";
import { all } from "./shared.js";

const DAY = 24 * 60 * 60 * 1000;

/**
 * Hourly job: access ending in 7 days and in 1 day, and access that ended in
 * the last 2 days. Each notice is sent once per grant (deduplicated by key).
 */
export async function expiryNotices(svc: Services, now = Date.now()) {
  for (const row of await all(svc.collections.entitlements!, {
    status: "active",
  })) {
    const parsed = entitlementRecordSchema.safeParse(row.data);
    if (!parsed.success || parsed.data.expiresAt === null) continue;
    const { expiresAt, studentId, courseId } = parsed.data;
    const left = expiresAt - now;
    const notice =
      left <= 0
        ? left > -2 * DAY
          ? { template: "access_ended" as const, tag: "ended" }
          : null
        : left <= DAY
          ? { template: "access_ending" as const, tag: "1d" }
          : left <= 7 * DAY
            ? { template: "access_ending" as const, tag: "7d" }
            : null;
    if (!notice) continue;
    const course = await svc.lms.courseInfo(courseId);
    await svc.notifications.send({
      studentId,
      template: notice.template,
      data: {
        courseTitle: course?.title ?? "",
        expiresAt: new Date(expiresAt).toISOString().slice(0, 10),
      },
      dedupeKey: `${row.id}:${notice.tag}`,
    });
  }
}
