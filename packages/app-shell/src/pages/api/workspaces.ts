import { platformConfig } from "@templatedesign/platform/config";
import { assertCsrf, CsrfError } from "@templatedesign/platform/csrf";
import { d1Db } from "@templatedesign/platform/db";
import { errorResponse, HttpError, json } from "@templatedesign/platform/http";
import { runtimeEnv } from "@templatedesign/platform/runtime";
import type { PlatformEnv } from "@templatedesign/platform/types";
import { createWorkspace } from "@templatedesign/platform/workspaces";
import type { APIRoute } from "astro";

export const prerender = false;

/** POST { slug, name } — creates a free workspace owned by the signed-in user. */
export const POST: APIRoute = async (context) => {
  try {
    const env = runtimeEnv() as PlatformEnv;
    try {
      assertCsrf(context.request, env);
    } catch (error) {
      if (error instanceof CsrfError) throw new HttpError("forbidden", 403, "CSRF or origin check failed.");
      throw error;
    }
    const { user, tenantId } = context.locals;
    const app = platformConfig().appId;
    if (!user || !tenantId) throw new HttpError("unauthenticated", 401, "Sign in to continue.");
    if (!app) throw new Error("appId is not configured");

    const body = (await context.request.json().catch(() => null)) as { slug?: unknown; name?: unknown } | null;
    if (typeof body?.slug !== "string")
      throw new HttpError("invalid_input", 400, "Choose an address.", { field: "slug" });
    const name = typeof body.name === "string" ? body.name : undefined;

    const workspace = await createWorkspace(d1Db(env.DB), { app, slug: body.slug, userId: user.id, tenantId, name });
    return json({ slug: workspace.slug, redirect: `/${workspace.slug}/admin` }, { status: 201 });
  } catch (error) {
    return errorResponse(error, context.request);
  }
};
