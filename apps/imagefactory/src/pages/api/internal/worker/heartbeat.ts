import { json } from "@templatedesign/platform/http";
import type { APIRoute } from "astro";
import { type HeartbeatInput, recordHeartbeat } from "../../../../lib/images/workers";
import { withWorker, workerJson } from "./_context";

export const prerender = false;

/** `POST /api/internal/worker/heartbeat` — the worker says it is alive and what it can do. Send one every ~20 s. */
export const POST: APIRoute = async (context) =>
  withWorker(context, async ({ db, worker }) => {
    const body = await workerJson<HeartbeatInput>(context).catch(() => ({}) as HeartbeatInput);
    await recordHeartbeat(db, worker, body);
    return json({ ok: true, worker: worker.name });
  });
