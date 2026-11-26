import type { APIRoute } from "astro";
import { VERSION as PLUGIN_VERSION } from "@mytutor/plugin-mytutor-lms";
import type { PublicSite } from "@mytutor/plugin-mytutor-lms/model";
import theme from "../../../../package.json";
import { pluginCall } from "../../../lib/lms";

const headers = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

/** Also proves the plugin and its storage answer, through the public site route. */
export const GET: APIRoute = async ({ locals, url }) => {
  const started = Date.now();
  const site = await pluginCall<PublicSite>(locals, url, "site").catch(
    () => null,
  );
  const storage = Boolean(site?.ok);
  const versionsMatch = theme.version === PLUGIN_VERSION;
  const ok = storage && versionsMatch;
  return Response.json(
    {
      status: ok ? "ok" : "degraded",
      theme: theme.version,
      plugin: PLUGIN_VERSION,
      versionsMatch,
      storage,
      latencyMs: Date.now() - started,
    },
    { status: ok ? 200 : 503, headers },
  );
};
