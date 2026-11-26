import { handleAgentApi } from "@templatedesign/platform/agents";
import type { APIRoute } from "astro";
import { runtimeEnv } from "../../../lib/runtime";

export const prerender = false;

/** Connected apps for the signed-in user: list, revoke, and the OAuth consent decision. */
export const ALL: APIRoute = async ({ request, locals }) => {
  const session = locals.user && locals.session ? { user: locals.user, session: { id: locals.session.id } } : null;
  return (await handleAgentApi(runtimeEnv(), request, session)) ?? new Response("Not found", { status: 404 });
};
