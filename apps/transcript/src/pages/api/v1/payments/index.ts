import { listPaymentSummaries } from "@templatedesign/platform/checkout";
import { d1Db } from "@templatedesign/platform/db";
import { HttpError, handleApi, json } from "@templatedesign/platform/http";
import type { APIRoute } from "astro";
import { runtimeEnv } from "../../../../lib/runtime";

export const GET: APIRoute = async ({ locals, request }) =>
  handleApi(request, async () => {
    if (!locals.tenantId) throw new HttpError("unauthenticated", 401);
    return json({ data: await listPaymentSummaries(d1Db(runtimeEnv().DB), locals.tenantId) });
  });
