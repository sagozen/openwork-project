import { json } from "@templatedesign/platform/http";
import type { APIRoute } from "astro";
import { leaseImageJob } from "../../../../lib/images/worker-jobs";
import { withWorker, workerJson } from "./_context";

export const prerender = false;

/**
 * `POST /api/internal/worker/lease` — long-polls up to 25 s and returns at most one job, or 204. The
 * Worker decides which worker may take which job; the worker only asks.
 */
export const POST: APIRoute = async (context) =>
  withWorker(context, async ({ worker, jobs }) => {
    const body = await workerJson<{ wait_seconds?: number }>(context).catch(() => ({}) as { wait_seconds?: number });
    const wait = typeof body.wait_seconds === "number" ? Math.min(Math.max(body.wait_seconds, 0), 25) : 20;
    const leased = await leaseImageJob(await jobs(), worker, { waitSeconds: wait });
    return leased ? json(leased) : new Response(null, { status: 204 });
  });
