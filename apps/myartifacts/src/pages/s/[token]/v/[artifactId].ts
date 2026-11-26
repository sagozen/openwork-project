import type { APIRoute } from "astro";
import { runtimeEnv } from "../../../../lib/runtime";
import { redirectToFile } from "../../../../lib/shares/public";
import { shareDeps } from "../../../../lib/shares/service";

export const prerender = false;

/** View one file of a share: a redirect to a short-lived inline link (attachment for unsafe types). */
export const GET: APIRoute = ({ request, params }) =>
  redirectToFile(shareDeps(runtimeEnv()), request, params.token ?? "", params.artifactId ?? "", "view");
