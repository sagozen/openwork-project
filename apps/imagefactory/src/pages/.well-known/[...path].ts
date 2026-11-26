import { handleOAuthDiscovery } from "@templatedesign/platform/agents";
import type { APIRoute } from "astro";
import { runtimeEnv } from "../../lib/runtime";

export const prerender = false;

/** OAuth discovery documents for the MCP connector (protected-resource and authorization-server). */
export const ALL: APIRoute = async ({ request }) =>
  (await handleOAuthDiscovery(runtimeEnv(), request)) ?? new Response("Not found", { status: 404 });
