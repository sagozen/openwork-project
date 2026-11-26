import { d1Db } from "@templatedesign/platform/db";
import type { APIRoute } from "astro";
import { handleOtaAppRequest } from "../../../http/app.js";
import { otaRuntime } from "../../../lib/ota-runtime";
import { runtimeEnv } from "../../../lib/runtime";

/**
 * Device-facing OTA API at `/<workspace>/ota/{app}/{platform}/...`. No session: manifests and bundles
 * are public to the device, and every write carries the app's bearer token, which is looked up
 * inside this workspace only. The middleware has already resolved the workspace from the slug.
 */
export const ALL: APIRoute = async ({ request, params, locals }) => {
  const workspace = locals.workspace;
  if (!workspace) return new Response("Not found", { status: 404 });
  try {
    const env = runtimeEnv();
    const runtime = await otaRuntime({
      env,
      db: d1Db(env.DB),
      workspace,
      origin: new URL(request.url).origin,
    });
    return await handleOtaAppRequest(request, params.path ?? "", runtime);
  } catch (error) {
    console.error("[ota] app route failed", { errorType: error instanceof Error ? error.name : "unknown" });
    return Response.json(
      { error: { code: "CONFIGURATION_ERROR", message: "The OTA server is not configured on this host." } },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
};
