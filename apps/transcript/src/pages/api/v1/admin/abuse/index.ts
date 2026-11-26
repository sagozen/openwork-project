import { abuseOverview, blockSubject, isAbuseSubjectKind } from "@templatedesign/platform/abuse";
import { auditAdmin, requireAdmin } from "@templatedesign/platform/admin";
import { d1Db } from "@templatedesign/platform/db";
import { HttpError, handleApi, json, readJson } from "@templatedesign/platform/http";
import type { APIRoute } from "astro";
import { jobAbuseHooks } from "../../../../../lib/job-abuse";
import { runtimeEnv } from "../../../../../lib/runtime";

/** Longest manual block with an end date; longer means "until released" (`minutes: null`). */
const MAX_BLOCK_MINUTES = 30 * 24 * 60;

/** `GET` active and recent job-abuse blocks plus this hour's top job creators. */
export const GET: APIRoute = async ({ locals, request }) =>
  handleApi(request, async () => {
    const env = runtimeEnv();
    const db = d1Db(env.DB);
    await requireAdmin(db, locals.user, env, "support");
    return json(await abuseOverview(db));
  });

/**
 * `POST {kind, id, minutes | null, reason}` blocks a tenant, guest or IP from creating jobs and
 * cancels its unstarted jobs. Manual blocks are audited but do not email operators.
 */
export const POST: APIRoute = async ({ locals, request }) =>
  handleApi(request, async () => {
    const env = runtimeEnv();
    const db = d1Db(env.DB);
    const actor = await requireAdmin(db, locals.user, env, "admin");
    const body = await readJson<{ kind?: unknown; id?: unknown; minutes?: unknown; reason?: unknown }>(request);
    if (!isAbuseSubjectKind(body.kind)) {
      throw new HttpError("invalid_input", 400, "Kind must be tenant, guest or ip.", { field: "kind" });
    }
    const subjectId = typeof body.id === "string" ? body.id.trim() : "";
    if (!subjectId || subjectId.length > 128) {
      throw new HttpError("invalid_input", 400, "Give a subject id of at most 128 characters.", { field: "id" });
    }
    const minutes = body.minutes === null ? null : Number(body.minutes);
    if (minutes !== null && (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_BLOCK_MINUTES)) {
      throw new HttpError("invalid_input", 400, "Minutes must be a whole number from 1 to 43200, or null.", {
        field: "minutes",
      });
    }
    const reason = (typeof body.reason === "string" ? body.reason.trim() : "").slice(0, 500) || "Blocked by admin";
    const subject = { kind: body.kind, id: subjectId };
    const block = await blockSubject(env, db, subject, {
      reason,
      source: "admin",
      minutes,
      createdBy: actor.userId,
      hooks: jobAbuseHooks(env, db),
    });
    await auditAdmin(db, actor, "admin.abuse.blocked", "abuse_block", block.id, reason, {
      subject: `${subject.kind}:${subject.id}`,
      until: block.blocked_until,
      cancelledJobs: block.cancelled_jobs,
    });
    return json({ block }, { status: 201 });
  });
