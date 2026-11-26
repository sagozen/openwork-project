import { auditAdmin, requireAdmin } from "@templatedesign/platform/admin";
import { d1Db } from "@templatedesign/platform/db";
import { HttpError, handleApi, json, readJson } from "@templatedesign/platform/http";
import type { APIRoute } from "astro";
import { runtimeEnv } from "../../../../../../../lib/runtime";
import { setWorkerReleaseActive } from "../../../../../../../lib/worker-releases";

/** `PATCH /api/v1/admin/workers/releases/[id]` — deactivate a bad release. */
export const PATCH: APIRoute = async ({ locals, params, request }) =>
  handleApi(request, async () => {
    const env = runtimeEnv();
    const db = d1Db(env.DB);
    const actor = await requireAdmin(db, locals.user, env, "admin");
    const body = await readJson<{ active?: boolean }>(request);
    if (typeof body.active !== "boolean") {
      throw new HttpError("invalid_input", 400, "active must be true or false.");
    }
    const releaseId = params.id ?? "";
    if (!(await setWorkerReleaseActive(db, releaseId, body.active))) {
      throw new HttpError("not_found", 404, "Release not found.");
    }
    await auditAdmin(
      db,
      actor,
      body.active ? "admin.worker.release_activated" : "admin.worker.release_deactivated",
      "worker_release",
      releaseId,
      null,
      {},
    );
    return json({ ok: true });
  });
