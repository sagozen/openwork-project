import { auditAdmin, requireAdmin } from "@templatedesign/platform/admin";
import { d1Db } from "@templatedesign/platform/db";
import { HttpError, handleApi, json, readJson } from "@templatedesign/platform/http";
import type { APIRoute } from "astro";
import { rotateWorkerToken, setWorkerDisabled } from "../../../../../lib/images/workers";
import { runtimeEnv } from "../../../../../lib/runtime";

export const prerender = false;

/** `PATCH` with `{ action: "rotate" | "disable" | "enable", reason }`. Rotation returns the new token once. */
export const PATCH: APIRoute = async ({ locals, request, params }) =>
  handleApi(request, async () => {
    const env = runtimeEnv();
    const db = d1Db(env.DB);
    const actor = await requireAdmin(db, locals.user, env, "admin");
    const workerId = params.id ?? "";
    const body = await readJson<{ action?: string; reason?: string }>(request);
    const reason = (body.reason ?? "").trim();
    if (!reason) throw new HttpError("invalid_input", 400, "A reason is required.");

    if (body.action === "rotate") {
      const token = await rotateWorkerToken(db, workerId);
      if (!token) throw new HttpError("not_found", 404, "No such worker.");
      await auditAdmin(db, actor, "admin.worker.token_rotated", "worker", workerId, reason);
      return json({ token });
    }
    if (body.action === "disable" || body.action === "enable") {
      const changed = await setWorkerDisabled(db, workerId, body.action === "disable");
      if (!changed) throw new HttpError("not_found", 404, "No such worker.");
      await auditAdmin(db, actor, `admin.worker.${body.action}d`, "worker", workerId, reason);
      return json({ updated: true });
    }
    throw new HttpError("invalid_input", 400, "Action must be rotate, disable or enable.");
  });
