import { requireAdmin, suspendTenant, unsuspendTenant } from "@templatedesign/platform/admin";
import { d1Db } from "@templatedesign/platform/db";
import { handleApi, json, readJson } from "@templatedesign/platform/http";
import type { APIRoute } from "astro";
import { runtimeEnv } from "../../../../../../lib/runtime";

export const POST: APIRoute = async ({ locals, params, request }) =>
  handleApi(request, async () => {
    const db = d1Db(runtimeEnv().DB);
    const actor = await requireAdmin(db, locals.user, runtimeEnv(), "admin");
    const body = await readJson<{ reason: string; action?: "suspend" | "unsuspend" }>(request);
    if (body.action === "unsuspend") {
      await unsuspendTenant(db, actor, params.tenantId ?? "", body.reason ?? "support review complete");
    } else {
      await suspendTenant(db, actor, params.tenantId ?? "", body.reason ?? "");
    }
    return json({ updated: true });
  });
