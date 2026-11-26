import { d1Db } from "@templatedesign/platform/db";
import { HttpError, handleApi, json } from "@templatedesign/platform/http";
import { authenticateApiKey, publicPrefix } from "@templatedesign/platform/keys";
import type { APIRoute } from "astro";
import { runtimeEnv } from "../../../lib/runtime";

export const GET: APIRoute = async ({ request }) =>
  handleApi(request, async () => {
    const header = request.headers.get("authorization") ?? "";
    if (!header.startsWith("Bearer ")) throw new HttpError("unauthenticated", 401);
    const key = header.slice("Bearer ".length).trim();
    const principal = await authenticateApiKey(d1Db(runtimeEnv().DB), key);
    if (!principal) throw new HttpError("unauthenticated", 401);
    return json({
      prefix: publicPrefix(key),
      scopes: principal.scopes,
      livemode: principal.livemode,
      key_id: principal.keyId,
    });
  });
