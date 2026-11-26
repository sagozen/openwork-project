import { d1Db } from "@templatedesign/platform/db";
import { HttpError, handleApi, json } from "@templatedesign/platform/http";
import { revokeApiKey } from "@templatedesign/platform/keys";
import type { APIRoute } from "astro";
import { runtimeEnv } from "../../../../lib/runtime";

export const DELETE: APIRoute = async ({ locals, params, request }) =>
  handleApi(request, async () => {
    if (!locals.user || !locals.tenantId || !locals.profile) throw new HttpError("unauthenticated", 401);
    if (!params.id) throw new HttpError("invalid_input", 400, "Missing key id.");
    const metadata = await revokeApiKey(
      runtimeEnv(),
      d1Db(runtimeEnv().DB),
      { user: locals.user, tenantId: locals.tenantId, profile: locals.profile },
      params.id,
    );
    return json({ key: metadata });
  });
