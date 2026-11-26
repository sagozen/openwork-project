import { processWebhook } from "@templatedesign/platform/checkout";
import { d1Db } from "@templatedesign/platform/db";
import { handleApi, json } from "@templatedesign/platform/http";
import type { APIRoute } from "astro";
import { runtimeEnv } from "../../../../lib/runtime";

export const POST: APIRoute = async ({ request }) =>
  handleApi(request, async () => {
    const env = runtimeEnv();
    // Read the body exactly once: the signature is computed over these raw bytes.
    const raw = await request.text();
    const result = await processWebhook(env, d1Db(env.DB), "stripe", raw, request.headers);
    return json({ received: true, outcome: result.outcome });
  });
