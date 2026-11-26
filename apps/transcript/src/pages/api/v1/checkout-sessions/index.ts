import { createCheckoutSession } from "@templatedesign/platform/checkout";
import { d1Db } from "@templatedesign/platform/db";
import { HttpError, handleApi, json, readJson } from "@templatedesign/platform/http";
import type { APIRoute } from "astro";
import { runtimeEnv } from "../../../../lib/runtime";

export const POST: APIRoute = async ({ locals, request }) =>
  handleApi(request, async () => {
    if (!locals.user || !locals.tenantId) throw new HttpError("unauthenticated", 401);
    const body = await readJson<{ pack_id?: unknown }>(request);
    const result = await createCheckoutSession(
      runtimeEnv(),
      d1Db(runtimeEnv().DB),
      { tenantId: locals.tenantId, userId: locals.user.id, source: "web" },
      locals.user,
      body,
      request.headers.get("idempotency-key"),
    );
    return json({ payment_id: result.payment_id, url: result.url }, { status: 201 });
  });
