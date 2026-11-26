import { createAuth } from "@templatedesign/platform/auth";
import type { APIRoute } from "astro";
import { runtimeEnv } from "../../../lib/runtime";

export const prerender = false;

export const ALL: APIRoute = async ({ request }) => createAuth(runtimeEnv()).handler(request);
