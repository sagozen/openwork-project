import { assertCsrf, CsrfError } from "@templatedesign/platform/csrf";
import { d1Db } from "@templatedesign/platform/db";
import { errorResponse, HttpError } from "@templatedesign/platform/http";
import { runtimeEnv } from "@templatedesign/platform/runtime";
import type { PlatformEnv } from "@templatedesign/platform/types";
import { requireMember, type Workspace, type WorkspaceMember } from "@templatedesign/platform/workspaces";
import type { APIContext } from "astro";
import { withSecurityHeaders } from "./security";

export interface WorkspaceApiContext {
  env: PlatformEnv & { MEDIA: R2Bucket };
  db: ReturnType<typeof d1Db>;
  workspace: Workspace;
  member: WorkspaceMember;
}

/**
 * Wraps a workspace-scoped JSON endpoint: CSRF/origin check for writes, the caller must hold one
 * of `roles` in the workspace the middleware resolved, and every error becomes a problem response.
 */
export async function workspaceApi(
  context: APIContext,
  roles: readonly string[],
  handler: (api: WorkspaceApiContext) => Promise<Response>,
): Promise<Response> {
  try {
    const env = runtimeEnv() as unknown as WorkspaceApiContext["env"];
    try {
      assertCsrf(context.request, env);
    } catch (error) {
      if (error instanceof CsrfError) throw new HttpError("forbidden", 403, "CSRF or origin check failed.");
      throw error;
    }
    const workspace = context.locals.workspace;
    const user = context.locals.user;
    if (!workspace || !user) throw new HttpError("unauthenticated", 401, "Sign in to continue.");
    const db = d1Db(env.DB);
    const member = await requireMember(db, workspace, user.id, roles);
    return withSecurityHeaders(await handler({ env, db, workspace, member }));
  } catch (error) {
    return errorResponse(error, context.request);
  }
}
