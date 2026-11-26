import { json } from "@templatedesign/platform/http";
import type { APIRoute } from "astro";
import { extendLease } from "../../../../../../lib/images/worker-jobs";
import { jobIdFrom, withWorker, workerJson } from "../../_context";

export const prerender = false;

/** `POST …/extend` — keeps a lease alive while the worker is still rendering. 409 means the lease is gone. */
export const POST: APIRoute = async (context) =>
  withWorker(context, async ({ db, worker }) => {
    const body = await workerJson<{ lease_token?: string }>(context);
    const result = await extendLease(db, worker, jobIdFrom(context), body.lease_token);
    if (result.verdict === "unknown_job") return json({ accepted: false, reason: result.verdict }, { status: 404 });
    if (result.verdict !== "ok") return json({ accepted: false, reason: result.verdict }, { status: 409 });
    return json({ accepted: true, lease_expires_at: result.leaseExpiresAt });
  });
