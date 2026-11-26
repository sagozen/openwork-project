import { d1Db } from "@templatedesign/platform/db";
import { handleApi, json, readJson } from "@templatedesign/platform/http";
import { resolvePrincipal } from "@templatedesign/platform/principal";
import { createWebhookEndpoint, listWebhookEndpoints } from "@templatedesign/platform/webhooks";
import type { APIRoute } from "astro";
import { runtimeEnv } from "../../../../lib/runtime";

export const GET: APIRoute = async ({ locals, request }) =>
  handleApi(request, async () => {
    const principal = await resolvePrincipal(locals, request, "jobs:read");
    return json({ data: await listWebhookEndpoints(d1Db(runtimeEnv().DB), principal.tenantId) });
  });

export const POST: APIRoute = async ({ locals, request }) =>
  handleApi(request, async () => {
    const principal = await resolvePrincipal(locals, request, "jobs:write");
    const input = await readJson<{ url: string; events?: string[] }>(request);
    const result = await createWebhookEndpoint(
      runtimeEnv(),
      d1Db(runtimeEnv().DB),
      { tenantId: principal.tenantId, userId: principal.userId },
      input,
    );
    return json(result, { status: 201 });
  });
