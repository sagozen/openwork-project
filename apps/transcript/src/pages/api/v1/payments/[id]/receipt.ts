import { paymentReceiptUrl } from "@templatedesign/platform/checkout";
import { d1Db } from "@templatedesign/platform/db";
import { HttpError, handleApi } from "@templatedesign/platform/http";
import type { APIRoute } from "astro";
import { runtimeEnv } from "../../../../../lib/runtime";

export const GET: APIRoute = async ({ locals, request, params }) =>
  handleApi(request, async () => {
    if (!locals.tenantId) throw new HttpError("unauthenticated", 401);
    const env = runtimeEnv();
    const url = await paymentReceiptUrl(env, d1Db(env.DB), locals.tenantId, params.id ?? "");
    return new Response(null, { status: 302, headers: { location: url, "cache-control": "no-store" } });
  });
