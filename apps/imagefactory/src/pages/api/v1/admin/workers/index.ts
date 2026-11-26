import { auditAdmin, requireAdmin } from "@templatedesign/platform/admin";
import { d1Db } from "@templatedesign/platform/db";
import { HttpError, handleApi, json, readJson } from "@templatedesign/platform/http";
import type { APIRoute } from "astro";
import { listWorkers, mapWorker, registerWorker } from "../../../../../lib/images/workers";
import { runtimeEnv } from "../../../../../lib/runtime";

export const prerender = false;

/** Admin-only worker registry. The token is returned exactly once and stored only as a hash. */
export const GET: APIRoute = async ({ locals, request }) =>
  handleApi(request, async () => {
    const env = runtimeEnv();
    const db = d1Db(env.DB);
    await requireAdmin(db, locals.user, env, "support");
    return json({ data: await listWorkers(db) });
  });

export const POST: APIRoute = async ({ locals, request }) =>
  handleApi(request, async () => {
    const env = runtimeEnv();
    const db = d1Db(env.DB);
    const actor = await requireAdmin(db, locals.user, env, "admin");
    const body = await readJson<{ name?: string }>(request);
    const name = (body.name ?? "").trim();
    if (!name) throw new HttpError("invalid_input", 400, "Give the worker a name.");
    const { worker, token } = await registerWorker(db, name);
    await auditAdmin(db, actor, "admin.worker.registered", "worker", worker.id, "worker registry");
    return json({ worker: mapWorker(worker), token }, { status: 201 });
  });
