import { HttpError, handleApi, json } from "@templatedesign/platform/http";
import type { APIRoute } from "astro";
import { jobContext } from "../../../lib/images/context";
import { findJobByProviderId, handleProviderWebhook, type WebhookPayload } from "../../../lib/images/jobs";
import { verifyFalWebhook } from "../../../lib/images/webhook-verify";
import { runtimeEnv, waitUntil } from "../../../lib/runtime";

export const prerender = false;

/**
 * fal.ai completion callback. The signature is verified over the raw body before anything is
 * parsed. A job the app does not know yet (the callback raced the submit response) gets a 404 so
 * fal retries; everything else answers 200 quickly and finishes the work after the response.
 */
export const POST: APIRoute = ({ request }) =>
  handleApi(request, async () => {
    const raw = new Uint8Array(await request.arrayBuffer());
    if (!(await verifyFalWebhook(request.headers, raw))) {
      throw new HttpError("unauthenticated", 401, "Invalid webhook signature.");
    }
    let payload: WebhookPayload;
    try {
      payload = JSON.parse(new TextDecoder().decode(raw)) as WebhookPayload;
    } catch {
      throw new HttpError("invalid_input", 400, "Webhook body must be valid JSON.");
    }
    if (typeof payload.request_id !== "string" || !["OK", "ERROR"].includes(payload.status)) {
      throw new HttpError("invalid_input", 400, "Unexpected webhook payload.");
    }

    // The signature covers the request id header, so the body must name the same request.
    if (payload.request_id !== request.headers.get("x-fal-webhook-request-id")) {
      throw new HttpError("invalid_input", 400, "Webhook body does not match the signed request id.");
    }

    const context = jobContext(runtimeEnv());
    // The callback can beat the submit response that stores the request id: answer 404 so fal retries.
    if (!(await findJobByProviderId(context, payload.request_id))) {
      return json({ received: false, outcome: "unknown_job" }, { status: 404 });
    }
    const work = handleProviderWebhook(context, payload).catch((error) => {
      console.error(
        JSON.stringify({ evt: "fal_webhook_failed", error: error instanceof Error ? error.message : "unknown" }),
      );
    });
    waitUntil(work);
    return json({ received: true });
  });
