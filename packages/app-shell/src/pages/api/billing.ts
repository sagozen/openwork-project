import { HttpError, json } from "@templatedesign/platform/http";
import { purchasePlan, setWorkspacePlan } from "@templatedesign/platform/workspaces";
import type { APIRoute } from "astro";
import { workspaceApi } from "../../api-guard";

export const prerender = false;

/**
 * POST { action: "upgrade", plan } spends credits from the owner's wallet for one period of `plan`.
 * POST { action: "downgrade" } returns to the free plan. Only the owner may call it, because the
 * credits belong to the owner's account. Downgrading keeps all data; it only blocks creating more
 * than the free limits allow.
 */
export const POST: APIRoute = (context) =>
  workspaceApi(context, [], async ({ db, workspace, member }) => {
    if (member.role !== "owner") throw new HttpError("forbidden", 403, "Only the owner can change the plan.");
    const body = (await context.request.json().catch(() => null)) as { action?: unknown; plan?: unknown } | null;
    if (body?.action === "upgrade" && typeof body.plan === "string") {
      const result = await purchasePlan(db, workspace, body.plan);
      return json({ plan: result.workspace.plan, expiresAt: result.workspace.planExpiresAt, charged: result.charged });
    }
    if (body?.action === "downgrade") {
      const updated = await setWorkspacePlan(db, workspace, "free");
      return json({ plan: updated.plan, expiresAt: null, charged: 0 });
    }
    throw new HttpError("invalid_input", 400, "Send { action: 'upgrade', plan } or { action: 'downgrade' }.");
  });
