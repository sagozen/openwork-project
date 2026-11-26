import { HttpError, json } from "@templatedesign/platform/http";
import { addMember, removeMember } from "@templatedesign/platform/workspaces";
import type { APIRoute } from "astro";
import { workspaceApi } from "../../api-guard";

export const prerender = false;

const ROLES = ["admin"];

/** POST { email, role } — adds an existing account to the workspace. */
export const POST: APIRoute = (context) =>
  workspaceApi(context, ROLES, async ({ db, workspace }) => {
    const body = (await context.request.json().catch(() => null)) as { email?: unknown; role?: unknown } | null;
    if (typeof body?.email !== "string" || typeof body.role !== "string") {
      throw new HttpError("invalid_input", 400, "Send an email and a role.");
    }
    const user = await db.first<{ id: string }>('SELECT id FROM "user" WHERE lower(email) = lower(?)', [
      body.email.trim(),
    ]);
    if (!user) throw new HttpError("not_found", 404, "No account with that email yet. Ask them to sign up first.");
    await addMember(db, workspace.id, user.id, body.role);
    return json({ ok: true }, { status: 201 });
  });

/** DELETE { userId } — removes a member. The owner cannot be removed. */
export const DELETE: APIRoute = (context) =>
  workspaceApi(context, ROLES, async ({ db, workspace }) => {
    const body = (await context.request.json().catch(() => null)) as { userId?: unknown } | null;
    if (typeof body?.userId !== "string") throw new HttpError("invalid_input", 400, "Send a userId.");
    await removeMember(db, workspace.id, body.userId);
    return json({ ok: true });
  });
