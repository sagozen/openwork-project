import { HttpError, json } from "@templatedesign/platform/http";
import type { APIRoute } from "astro";
import { extendLease } from "../../../../../../lib/jobs";
import { PRICING } from "../../../../../../lib/pricing";
import { jobIdFrom, withWorker, workerJson } from "../../_context";

/** `POST /api/internal/worker/jobs/{id}/extend` — every 60 s while the job runs. */
export const POST: APIRoute = async (context) =>
  withWorker(context, async ({ db, worker }) => {
    const body = await workerJson<{ lease_token?: string }>(context).catch(() => ({}) as { lease_token?: string });
    const result = await extendLease(
      db,
      worker.id,
      jobIdFrom(context),
      body.lease_token ?? null,
      PRICING.leaseExtendSeconds,
    );
    if (!result.ok) {
      // 409 is the worker's cue to kill ffmpeg/whisper immediately: the job was cancelled,
      // requeued, or taken by another attempt.
      throw new HttpError("invalid_input", 409, `Lease is no longer held (${result.reason}).`, {
        reason: result.reason,
        stop: true,
      });
    }
    return json({ ok: true, lease_seconds: PRICING.leaseExtendSeconds });
  });
