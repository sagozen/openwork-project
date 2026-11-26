import { d1Db } from "@templatedesign/platform/db";
import { getDeletionRequest, requestDeletion } from "@templatedesign/platform/deletion";
import { HttpError, handleApi, json } from "@templatedesign/platform/http";
import type { APIRoute } from "astro";
import { runtimeEnv } from "../../../../lib/runtime";

export const POST: APIRoute = async ({ locals, request }) =>
  handleApi(request, async () => {
    if (!locals.user || !locals.tenantId || !locals.profile) throw new HttpError("unauthenticated", 401);
    const result = await requestDeletion(runtimeEnv(), d1Db(runtimeEnv().DB), {
      user: locals.user,
      tenantId: locals.tenantId,
      profile: locals.profile,
    });
    return json(result, { status: 202 });
  });

export const GET: APIRoute = async ({ locals, request }) =>
  handleApi(request, async () => {
    if (!locals.user) throw new HttpError("unauthenticated", 401);
    const result = await getDeletionRequest(d1Db(runtimeEnv().DB), locals.user.id);
    return json({ deletion: result });
  });
