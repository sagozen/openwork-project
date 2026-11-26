import { json } from "@templatedesign/platform/http";
import type { APIRoute } from "astro";
import { failWorkerJob } from "../../../../../../lib/images/worker-jobs";
import { jobIdFrom, withWorker, workerJson } from "../../_context";

export const prerender = false;

/**
 * `POST …/fail` — the worker could not make the images. `code` is CONTENT_BLOCKED or INVALID_INPUT to end
 * the job (nothing is charged); anything else puts it back in the queue, and after the last attempt the
 * fallback provider takes it.
 */
export const POST: APIRoute = async (context) =>
  withWorker(context, async ({ worker, jobs }) => {
    const body = await workerJson<{ lease_token?: string; code?: string; message?: string }>(context);
    const result = await failWorkerJob(await jobs(), worker, jobIdFrom(context), {
      leaseToken: body.lease_token,
      code: body.code,
      message: body.message,
    });
    if (result.reason === "unknown_job") return json(result, { status: 404 });
    return json(result, { status: result.accepted ? 200 : 409 });
  });
