import type { APIRoute } from "astro";
import { VERSION as PLUGIN_VERSION } from "@mytutor/plugin-mytutor-lms";
import theme from "../../../package.json";

const headers = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

/** Liveness and the matched theme/plugin pair; never touches student data. */
export const GET: APIRoute = () => {
  const versionsMatch = theme.version === PLUGIN_VERSION;
  return Response.json(
    {
      status: versionsMatch ? "ok" : "version_mismatch",
      theme: theme.version,
      plugin: PLUGIN_VERSION,
      versionsMatch,
    },
    { status: versionsMatch ? 200 : 500, headers },
  );
};
