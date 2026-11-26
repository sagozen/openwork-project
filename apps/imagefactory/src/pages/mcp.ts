import type { APIRoute } from "astro";
import { plainError, withCaller } from "../lib/auth/caller";
import { handleMcp } from "../lib/mcp/server";
import { runtimeEnv } from "../lib/runtime";

export const prerender = false;

/**
 * MCP endpoint (streamable HTTP, stateless). Browser pages cannot call it: a request that carries
 * an Origin header must come from this app's own origin.
 */
const handle: APIRoute = async ({ request }) => {
  const env = runtimeEnv();
  const origin = new URL(env.BETTER_AUTH_URL).origin;
  const incoming = request.headers.get("origin");
  if (incoming !== null && incoming !== origin) {
    return plainError(403, "invalid_origin", "Request origin is not allowed.");
  }
  return withCaller(env, request, (caller) => handleMcp(request, caller, origin));
};

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
