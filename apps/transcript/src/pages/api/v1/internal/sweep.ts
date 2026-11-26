import { d1Db } from "@templatedesign/platform/db";
import { HttpError, handleApi, json } from "@templatedesign/platform/http";
import type { APIRoute } from "astro";
import { runDailyCron, runMinuteCron } from "../../../../lib/ops";
import { runtimeEnv } from "../../../../lib/runtime";

/**
 * Manual trigger for the same jobs the crons run. Staging and incident response only; it is
 * protected by `INTERNAL_SWEEP_SECRET` and 404s when that secret is not set.
 */
export const POST: APIRoute = async ({ request, url }) =>
  handleApi(request, async () => {
    const env = runtimeEnv();
    const secret = env.INTERNAL_SWEEP_SECRET;
    if (!secret) throw new HttpError("not_found", 404);
    if (request.headers.get("authorization") !== `Bearer ${secret}`) throw new HttpError("forbidden", 403);
    await d1Db(env.DB).first("SELECT 1 AS ok");
    const scope = url.searchParams.get("scope") ?? "minute";
    if (scope === "daily") return json({ scope, result: await runDailyCron(env) });
    return json({ scope, result: await runMinuteCron(env) });
  });
