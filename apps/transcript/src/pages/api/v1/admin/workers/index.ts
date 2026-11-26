import { requireAdmin } from "@templatedesign/platform/admin";
import { d1Db } from "@templatedesign/platform/db";
import { HttpError, handleApi, json, readJson } from "@templatedesign/platform/http";
import type { APIRoute } from "astro";
import { runtimeEnv } from "../../../../../lib/runtime";
import { mapWorker, registerWorker, type WorkerRow, type WorkerTier } from "../../../../../lib/workers";

/** Admin-only worker registry. The token is returned exactly once, never stored in clear. */
export const GET: APIRoute = async ({ locals, request }) =>
  handleApi(request, async () => {
    const env = runtimeEnv();
    const db = d1Db(env.DB);
    await requireAdmin(db, locals.user, env, "support");
    const rows = await db.all<WorkerRow>("SELECT * FROM workers ORDER BY tier, name");
    return json({ data: rows.map(mapWorker) });
  });

export const POST: APIRoute = async ({ locals, request }) =>
  handleApi(request, async () => {
    const env = runtimeEnv();
    const db = d1Db(env.DB);
    const actor = await requireAdmin(db, locals.user, env, "admin");
    const body = await readJson<{ name?: string; tier?: string }>(request);
    const tier: WorkerTier = body.tier === "fallback" ? "fallback" : "primary";
    const name = (body.name ?? "").trim();
    if (!name) throw new HttpError("invalid_input", 400, "Give the worker a name.");
    const { worker, token } = await registerWorker(db, { name, tier });
    const { auditAdmin } = await import("@templatedesign/platform/admin");
    await auditAdmin(db, actor, "admin.worker.registered", "worker", worker.id, "worker registry", { tier });
    return json({ worker: mapWorker(worker), token }, { status: 201 });
  });
