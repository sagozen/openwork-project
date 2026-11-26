import { createAuth } from "@templatedesign/platform/auth";
import type { APIRoute } from "astro";
import { refuseNonOwnerConsent } from "../../../lib/auth/agent-api";
import { runtimeEnv } from "../../../lib/runtime";

export const prerender = false;

export const ALL: APIRoute = async ({ request }) => {
  const env = runtimeEnv();
  return (await refuseNonOwnerConsent(env, request)) ?? createAuth(env).handler(request);
};
