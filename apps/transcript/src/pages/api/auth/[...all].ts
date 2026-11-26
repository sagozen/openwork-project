import { createAuth } from "@templatedesign/platform/auth";
import type { APIRoute } from "astro";
import { runtimeEnv } from "../../../lib/runtime";

export const ALL: APIRoute = async ({ request }) => {
  const auth = createAuth(runtimeEnv());
  return auth.handler(request);
};
