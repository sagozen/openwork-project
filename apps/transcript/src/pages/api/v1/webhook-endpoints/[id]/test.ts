import { d1Db } from "@templatedesign/platform/db";
import { handleApi, json } from "@templatedesign/platform/http";
import { resolvePrincipal } from "@templatedesign/platform/principal";
import { sendTestWebhook } from "@templatedesign/platform/webhooks";
import type { APIRoute } from "astro";
import { runtimeEnv } from "../../../../../lib/runtime";

export const POST: APIRoute = async ({ locals, params, request }) =>
  handleApi(request, async () => {
    const principal = await resolvePrincipal(locals, request, "jobs:write");
    return json(await sendTestWebhook(runtimeEnv(), d1Db(runtimeEnv().DB), principal.tenantId, params.id ?? ""));
  });
