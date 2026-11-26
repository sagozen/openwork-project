import { auditAdmin, requireAdmin } from "@templatedesign/platform/admin";
import { d1Db } from "@templatedesign/platform/db";
import { HttpError, handleApi, json, readJson } from "@templatedesign/platform/http";
import type { APIRoute } from "astro";
import { runtimeEnv } from "../../../../../../lib/runtime";
import { rotateWorkerToken, setWorkerDisabled, updateWorkerConfig } from "../../../../../../lib/workers";

/**
 * `PATCH` enables/disables a worker, rotates its token, or changes its remote config. Remote
 * config takes effect on the next heartbeat (about 20 s) except that a concurrency change is
 * applied by the worker's slot supervisor within a couple of seconds after that.
 */
export const PATCH: APIRoute = async ({ locals, params, request }) =>
  handleApi(request, async () => {
    const env = runtimeEnv();
    const db = d1Db(env.DB);
    const actor = await requireAdmin(db, locals.user, env, "admin");
    const workerId = params.id ?? "";
    const body = await readJson<{
      disabled?: boolean;
      rotate_token?: boolean;
      reason?: string;
      config?: unknown;
    }>(request);
    if (typeof body.disabled === "boolean") {
      await setWorkerDisabled(db, workerId, body.disabled);
      await auditAdmin(db, actor, "admin.worker.disabled", "worker", workerId, body.reason ?? null, {
        disabled: body.disabled,
      });
    }
    if (body.rotate_token) {
      const token = await rotateWorkerToken(db, workerId);
      if (!token) throw new HttpError("not_found", 404, "Worker not found.");
      await auditAdmin(db, actor, "admin.worker.token_rotated", "worker", workerId, body.reason ?? null, {});
      return json({ token });
    }
    if (body.config !== undefined) {
      const updated = await updateWorkerConfig(db, workerId, body.config);
      if (!updated) throw new HttpError("not_found", 404, "Worker not found.");
      await auditAdmin(db, actor, "admin.worker.config_updated", "worker", workerId, body.reason ?? null, {
        configVersion: updated.configVersion,
        config: updated.config,
      });
      return json(updated);
    }
    return json({ ok: true });
  });
