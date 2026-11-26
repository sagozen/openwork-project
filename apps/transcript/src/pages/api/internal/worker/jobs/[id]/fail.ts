import { HttpError, json } from "@templatedesign/platform/http";
import type { APIRoute } from "astro";
import { failJob, getJob } from "../../../../../../lib/jobs";
import { jobIdFrom, withWorker, workerJson } from "../../_context";

/**
 * `POST …/fail` — typed error codes only; the message is never stored. `retryable` requeues
 * while attempts remain, otherwise the job fails and any reservation is released.
 */
export const POST: APIRoute = async (context) =>
  withWorker(context, async ({ env, db, worker }) => {
    const body = await workerJson<{ code?: string; retryable?: boolean; lease_token?: string }>(context).catch(
      () => ({}) as { code?: string; retryable?: boolean; lease_token?: string },
    );
    const code = (body.code ?? "worker_error").replace(/[^a-z0-9_]+/gi, "_").slice(0, 60);
    const job = await getJob(db, jobIdFrom(context));
    if (!job) throw new HttpError("not_found", 404, "Job not found.");
    if (job.leased_by !== worker.id) throw new HttpError("forbidden", 403, "This job is not leased to this worker.");
    if (job.lease_token && job.lease_token !== (body.lease_token ?? null)) {
      // A stale attempt may not release or requeue a job that a newer lease owns.
      throw new HttpError("forbidden", 403, "This lease was superseded.", { reason: "lease_superseded" });
    }
    const result = await failJob(env, db, worker.id, job.id, code, body.retryable !== false);
    return json(result);
  });
