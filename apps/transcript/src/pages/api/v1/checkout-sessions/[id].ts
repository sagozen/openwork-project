import { getCheckoutStatus } from "@templatedesign/platform/checkout";
import { d1Db } from "@templatedesign/platform/db";
import { HttpError, handleApi, json } from "@templatedesign/platform/http";
import type { APIRoute } from "astro";
import { runtimeEnv } from "../../../../lib/runtime";

/** Read-only status for the return page. Never calls the provider and never grants. */
export const GET: APIRoute = async ({ locals, request, params }) =>
  handleApi(request, async () => {
    if (!locals.tenantId) throw new HttpError("unauthenticated", 401);
    return json(await getCheckoutStatus(d1Db(runtimeEnv().DB), locals.tenantId, params.id ?? ""));
  });
