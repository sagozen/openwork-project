import { createCheckoutSession, getCheckoutStatus } from "@templatedesign/platform/checkout";
import { assertCsrf, CsrfError } from "@templatedesign/platform/csrf";
import { d1Db } from "@templatedesign/platform/db";
import { errorResponse, HttpError, json } from "@templatedesign/platform/http";
import { runtimeEnv } from "@templatedesign/platform/runtime";
import type { APIRoute } from "astro";

export const prerender = false;

/** POST { pack_id } starts a hosted checkout for a credit pack (Paddle or Stripe, whichever is configured). */
export const POST: APIRoute = async ({ locals, request }) => {
  try {
    const env = runtimeEnv();
    try {
      assertCsrf(request, env);
    } catch (error) {
      if (error instanceof CsrfError) throw new HttpError("forbidden", 403, "CSRF or origin check failed.");
      throw error;
    }
    if (!locals.user || !locals.tenantId) throw new HttpError("unauthenticated", 401, "Sign in to continue.");
    const body = (await request.json().catch(() => ({}))) as { pack_id?: unknown };
    const result = await createCheckoutSession(
      env,
      d1Db(env.DB),
      { tenantId: locals.tenantId, userId: locals.user.id, source: "web" },
      locals.user,
      body,
      request.headers.get("idempotency-key") ?? crypto.randomUUID(),
    );
    return json({ payment_id: result.payment_id, url: result.url }, { status: 201 });
  } catch (error) {
    return errorResponse(error, request);
  }
};

/** GET ?payment=<id> reports whether the payment has been credited yet (the webhook grants, never this call). */
export const GET: APIRoute = async ({ locals, request, url }) => {
  try {
    if (!locals.tenantId) throw new HttpError("unauthenticated", 401, "Sign in to continue.");
    const paymentId = url.searchParams.get("payment") ?? "";
    return json(await getCheckoutStatus(d1Db(runtimeEnv().DB), locals.tenantId, paymentId));
  } catch (error) {
    return errorResponse(error, request);
  }
};
