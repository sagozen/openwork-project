import { auditAdmin, requireAdmin } from "@templatedesign/platform/admin";
import { d1Db } from "@templatedesign/platform/db";
import { HttpError, handleApi, json, readJson } from "@templatedesign/platform/http";
import type { APIRoute } from "astro";
import { getJob, loadTranscript } from "../../../../lib/jobs";
import { runtimeEnv } from "../../../../lib/runtime";

/**
 * Break-glass: the only path that reads a customer's transcript bytes, admin-only and audited.
 * It returns the stored JSON so an operator can investigate a complaint without the database
 * console.
 */
export const POST: APIRoute = async ({ locals, request }) =>
  handleApi(request, async () => {
    const env = runtimeEnv();
    const db = d1Db(env.DB);
    const actor = await requireAdmin(db, locals.user, env, "admin");
    const body = await readJson<{ transcriptionId?: string; reason?: string }>(request);
    const reason = (body.reason ?? "").trim();
    if (!reason || reason.length > 500) {
      throw new HttpError("invalid_input", 400, "A reason between 1 and 500 characters is required.");
    }
    const job = await getJob(db, body.transcriptionId ?? "");
    if (job?.status !== "succeeded") throw new HttpError("not_found", 404, "Transcript is unavailable.");
    await auditAdmin(db, actor, "admin.break_glass.transcript", "transcription_job", job.id, reason, {
      tenantId: job.tenant_id,
    });
    const transcript = await loadTranscript(env, job);
    if (!transcript) throw new HttpError("not_found", 404, "The result object is gone.");
    return json({ transcription_id: job.id, transcript });
  });
