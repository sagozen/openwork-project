import { auditAdmin, requireAdmin } from "@templatedesign/platform/admin";
import { d1Db } from "@templatedesign/platform/db";
import { handleApi, json } from "@templatedesign/platform/http";
import { runReconciliation } from "@templatedesign/platform/reconcile";
import type { APIRoute } from "astro";
import { runtimeEnv } from "../../../../../lib/runtime";

/** Manual reconciliation run. Admin-only, CSRF-protected by middleware, and audited. */
export const POST: APIRoute = async ({ locals, request }) =>
  handleApi(request, async () => {
    const env = runtimeEnv();
    const db = d1Db(env.DB);
    const actor = await requireAdmin(db, locals.user, env, "admin");
    const result = await runReconciliation(env, db, new Date());
    const reason = request.headers.get("x-reason")?.trim() || "manual reconciliation run";
    await auditAdmin(db, actor, "admin.reconciliation.run", "reconciliation", result.runAt, reason, result.counts);
    return json(result);
  });
