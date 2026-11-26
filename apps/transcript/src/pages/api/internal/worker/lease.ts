import { json } from "@templatedesign/platform/http";
import type { APIRoute } from "astro";
import { type JobRow, mapJob, parseJson } from "../../../../lib/jobs";
import { mediaDownloadUrl } from "../../../../lib/uploads";
import { leaseJob } from "../../../../lib/workers";
import { withWorker, workerJson } from "./_context";

/**
 * `POST /api/internal/worker/lease` — long-polls up to 20 s and returns at most one job, or
 * 204. The Worker decides which worker may take which job (home first, VPS fallback); the
 * worker only asks.
 */
export const POST: APIRoute = async (context) =>
  withWorker(context, async ({ env, db, worker }) => {
    const body = await workerJson<{ wait_seconds?: number }>(context).catch(() => ({ wait_seconds: 20 }));
    const wait = typeof body.wait_seconds === "number" ? Math.min(Math.max(body.wait_seconds, 0), 25) : 20;
    const leased = await leaseJob(db, worker, { waitSeconds: wait });
    if (!leased) return new Response(null, { status: 204 });

    const job = await db.first<JobRow>("SELECT * FROM transcription_jobs WHERE id = ?", [leased.id]);
    if (!job) return new Response(null, { status: 204 });

    let mediaUrl: string | null = null;
    if (job.source_kind === "upload" && job.stage === "transcribe") {
      mediaUrl = await mediaDownloadUrl(env, job.source_ref).catch(() => null);
    }
    const view = mapJob(job);
    return json({
      job: {
        id: job.id,
        stage: job.stage,
        source_kind: job.source_kind,
        source_ref: job.source_ref,
        source_meta: view.meta,
        options: parseJson<Record<string, unknown>>(job.options_json, {}),
        duration_seconds: job.duration_seconds,
        attempts: job.attempts,
        media_url: mediaUrl,
      },
      lease_token: leased.lease_token,
      lease_expires_at: job.lease_expires_at,
      lease_seconds: 180,
    });
  });
