import { extendAbuseBlock, getAbuseBlock, releaseAbuseBlock } from "@templatedesign/platform/abuse";
import { auditAdmin, requireAdmin } from "@templatedesign/platform/admin";
import { d1Db } from "@templatedesign/platform/db";
import { HttpError, handleApi, json, readJson } from "@templatedesign/platform/http";
import type { APIRoute } from "astro";
import { runtimeEnv } from "../../../../../lib/runtime";

const EXTEND_MINUTES = 24 * 60;

/**
 * `PATCH {action: "release" | "extend" | "permanent", reason?}`. Release lifts the block at once;
 * extend sets the end to 24 h from now; permanent keeps it until an admin releases it.
 */
export const PATCH: APIRoute = async ({ locals, params, request }) =>
  handleApi(request, async () => {
    const env = runtimeEnv();
    const db = d1Db(env.DB);
    const actor = await requireAdmin(db, locals.user, env, "admin");
    const blockId = params.id ?? "";
    const body = await readJson<{ action?: unknown; reason?: unknown }>(request);
    const action = body.action;
    if (action !== "release" && action !== "extend" && action !== "permanent") {
      throw new HttpError("invalid_input", 400, "Action must be release, extend or permanent.", { field: "action" });
    }
    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) || null : null;
    const existing = blockId.length <= 128 ? await getAbuseBlock(db, blockId) : null;
    if (!existing) throw new HttpError("not_found", 404, "Block not found.");
    if (existing.released_at) throw new HttpError("invalid_input", 409, "This block was already released.");

    if (action === "release") {
      await releaseAbuseBlock(db, blockId, actor.userId);
      await auditAdmin(db, actor, "admin.abuse.released", "abuse_block", blockId, reason, {
        subject: `${existing.subject_kind}:${existing.subject_id}`,
      });
    } else {
      await extendAbuseBlock(db, blockId, action === "extend" ? EXTEND_MINUTES : null);
      const updated = await getAbuseBlock(db, blockId);
      await auditAdmin(db, actor, "admin.abuse.extended", "abuse_block", blockId, reason, {
        subject: `${existing.subject_kind}:${existing.subject_id}`,
        until: updated?.blocked_until ?? null,
      });
    }
    return json({ block: await getAbuseBlock(db, blockId) });
  });
