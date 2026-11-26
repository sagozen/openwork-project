import type { Db } from "@templatedesign/platform/db";
import { d1Db } from "@templatedesign/platform/db";
import { errorResponse, HttpError, json, readJson } from "@templatedesign/platform/http";
import type { APIContext } from "astro";
import { runtimeEnv } from "../../../../lib/runtime";
import type { Env } from "../../../../lib/types";
import { authenticateWorker, type WorkerRow } from "../../../../lib/workers";

/**
 * Shared plumbing for the worker API. Every route authenticates with the worker's own bearer
 * token (hashed in D1) and never with a session or API key, so a leaked dashboard key cannot
 * lease jobs.
 */
export interface WorkerContext {
  env: Env;
  db: Db;
  worker: WorkerRow;
}

export async function withWorker(
  context: APIContext,
  run: (worker: WorkerContext) => Promise<Response>,
): Promise<Response> {
  try {
    const env = runtimeEnv();
    const db = d1Db(env.DB);
    const worker = await authenticateWorker(db, context.request);
    if (!worker) {
      return json({ error: "unauthenticated", detail: "Worker token is missing or revoked." }, { status: 401 });
    }
    return await run({ env, db, worker });
  } catch (error) {
    return errorResponse(error, context.request);
  }
}

export async function workerJson<T>(context: APIContext): Promise<T> {
  try {
    return await readJson<T>(context.request);
  } catch {
    throw new HttpError("invalid_input", 400, "Request body must be valid JSON.");
  }
}

export function jobIdFrom(context: APIContext): string {
  const id = context.params.id;
  if (!id) throw new HttpError("invalid_input", 400, "Missing job id.");
  return id;
}
