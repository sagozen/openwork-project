import { HttpError, json } from "@templatedesign/platform/http";
import { getBranding, updateBranding } from "@templatedesign/platform/workspaces";
import type { APIRoute } from "astro";
import { workspaceApi } from "../../api-guard";
import { removeLogo, storeLogo } from "../../branding/upload";

export const prerender = false;

const ROLES = ["admin"];

/**
 * POST multipart: `displayName`, `accentColor` (#rrggbb), `logo` (file), `clearLogo=1`.
 * Owner and admin only. A new logo replaces the old object in R2.
 */
export const POST: APIRoute = (context) =>
  workspaceApi(context, ROLES, async ({ env, db, workspace }) => {
    const form = await context.request.formData().catch(() => null);
    if (!form) throw new HttpError("invalid_input", 400, "Send the form as multipart data.");

    const patch: Parameters<typeof updateBranding>[2] = {};
    const displayName = form.get("displayName");
    if (typeof displayName === "string") patch.displayName = displayName.trim() === "" ? null : displayName;
    const accent = form.get("accentColor");
    if (typeof accent === "string") patch.accentColor = accent.trim() === "" ? null : accent.trim();

    const before = await getBranding(db, workspace.id);
    const file = form.get("logo");
    if (file instanceof File && file.size > 0) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      patch.logoKey = await storeLogo(env.MEDIA, workspace.id, bytes, file.type || undefined);
    } else if (form.get("clearLogo") === "1") {
      patch.logoKey = null;
    }

    const branding = await updateBranding(db, workspace.id, patch);
    if (patch.logoKey !== undefined && before.logoKey !== branding.logoKey) {
      await removeLogo(env.MEDIA, workspace.id, before.logoKey);
    }
    return json({ branding });
  });
