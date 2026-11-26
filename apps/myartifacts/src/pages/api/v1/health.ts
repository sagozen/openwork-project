import { d1Db } from "@templatedesign/platform/db";
import { json } from "@templatedesign/platform/http";
import type { APIRoute } from "astro";
import { checkHealth } from "../../../lib/health";
import { runtimeEnv } from "../../../lib/runtime";
import { storageFromEnv } from "../../../lib/storage/s3";

export const prerender = false;

/** Reports D1 and the object store. Public and read-only; 503 when either is down. */
export const GET: APIRoute = async () => {
  const env = runtimeEnv();
  const health = await checkHealth(d1Db(env.DB), () => storageFromEnv(env));
  return json(health, { status: health.status === "ok" ? 200 : 503, headers: { "cache-control": "no-store" } });
};
