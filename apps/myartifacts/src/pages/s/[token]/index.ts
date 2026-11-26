import type { APIRoute } from "astro";
import { runtimeEnv } from "../../../lib/runtime";
import { renderSharePage, submitSharePassword } from "../../../lib/shares/public";
import { shareDeps } from "../../../lib/shares/service";

export const prerender = false;

/** Public share page: the password form or the viewer. The token in the path is the capability. */
export const GET: APIRoute = ({ request, params }) =>
  renderSharePage(shareDeps(runtimeEnv()), request, params.token ?? "");

export const POST: APIRoute = ({ request, params }) =>
  submitSharePassword(shareDeps(runtimeEnv()), request, params.token ?? "");
