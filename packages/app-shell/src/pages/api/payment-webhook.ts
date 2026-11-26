import { processWebhook } from "@templatedesign/platform/checkout";
import { d1Db } from "@templatedesign/platform/db";
import { handleApi, json } from "@templatedesign/platform/http";
import { runtimeEnv } from "@templatedesign/platform/runtime";
import type { APIRoute } from "astro";

export const prerender = false;

/** POST /api/v1/payment-webhooks/<paddle|stripe>. No session or CSRF: the provider signature is the credential. */
export const POST: APIRoute = async ({ params, request }) =>
  handleApi(request, async () => {
    const provider = params.provider;
    if (provider !== "paddle" && provider !== "stripe") return json({ error: "unknown provider" }, { status: 404 });
    const env = runtimeEnv();
    // Read the body exactly once: the signature is computed over these raw bytes.
    const raw = await request.text();
    const result = await processWebhook(env, d1Db(env.DB), provider, raw, request.headers);
    return json({ received: true, outcome: result.outcome });
  });
