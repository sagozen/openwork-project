import { workspaceApi } from "@templatedesign/app-shell/api-guard";
import type { APIRoute } from "astro";
import { handleOtaAdminRequest } from "../../../../http/admin.js";
import { otaRuntime } from "../../../../lib/ota-runtime";
import type { Env } from "../../../../lib/types";

/**
 * Admin JSON API for the OTA workspace at `/<workspace>/admin/api/<action>`. `workspaceApi` checks the
 * CSRF token and requires the signed-in user to be an admin (or the owner) of this workspace; the
 * handler then runs every action against that workspace only.
 */
export const ALL: APIRoute = (context) =>
  workspaceApi(context, ["admin"], async ({ env, db, workspace, member }) => {
    const runtime = await otaRuntime({
      env: env as Env,
      db,
      workspace,
      origin: new URL(context.request.url).origin,
    });
    return handleOtaAdminRequest(context.request, context.params.action ?? "", {
      ...runtime,
      actor: { id: member.userId, administrator: true },
    });
  });
