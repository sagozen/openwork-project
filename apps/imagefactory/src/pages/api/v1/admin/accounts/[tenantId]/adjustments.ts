import { adjustCredits, requireAdmin } from "@templatedesign/platform/admin";
import { d1Db } from "@templatedesign/platform/db";
import { handleApi, json, readJson } from "@templatedesign/platform/http";
import type { APIRoute } from "astro";
import { runtimeEnv } from "../../../../../../lib/runtime";

export const POST: APIRoute = async ({ locals, params, request }) =>
  handleApi(request, async () => {
    const db = d1Db(runtimeEnv().DB);
    const actor = await requireAdmin(db, locals.user, runtimeEnv(), "support");
    const body = await readJson<{ credits: number; reason: string }>(request);
    const wallet = await adjustCredits(db, actor, {
      tenantId: params.tenantId ?? "",
      credits: Number(body.credits),
      reason: body.reason ?? "",
    });
    return json({ wallet }, { status: 201 });
  });
