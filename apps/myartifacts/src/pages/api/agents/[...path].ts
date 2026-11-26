import type { APIRoute } from "astro";
import { handleOwnerAgentApi } from "../../../lib/auth/agent-api";
import { runtimeEnv } from "../../../lib/runtime";

export const prerender = false;

/** Connected apps for the signed-in owner: list, revoke, and the OAuth consent decision. */
export const ALL: APIRoute = async ({ request, locals }) => handleOwnerAgentApi(runtimeEnv(), request, locals);
