import { d1Db } from "@templatedesign/platform/db";
import { HttpError, handleApi, json, readJson } from "@templatedesign/platform/http";
import { type CreateApiKeyInput, createApiKey, listApiKeys } from "@templatedesign/platform/keys";
import type { APIRoute } from "astro";
import { runtimeEnv } from "../../../../lib/runtime";

export const GET: APIRoute = async ({ locals, request }) =>
  handleApi(request, async () => {
    if (!locals.tenantId) throw new HttpError("unauthenticated", 401);
    return json({ data: await listApiKeys(d1Db(runtimeEnv().DB), locals.tenantId) });
  });

export const POST: APIRoute = async ({ locals, request }) =>
  handleApi(request, async () => {
    if (!locals.user || !locals.tenantId || !locals.profile) throw new HttpError("unauthenticated", 401);
    const input = await readJson<CreateApiKeyInput>(request);
    const result = await createApiKey(
      runtimeEnv(),
      d1Db(runtimeEnv().DB),
      { user: locals.user, tenantId: locals.tenantId, profile: locals.profile },
      input,
    );
    return json(result, { status: 201 });
  });
