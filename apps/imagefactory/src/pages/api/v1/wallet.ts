import { getWallet, listLedger } from "@templatedesign/platform/credits";
import { d1Db } from "@templatedesign/platform/db";
import { HttpError, handleApi, json } from "@templatedesign/platform/http";
import type { APIRoute } from "astro";
import { runtimeEnv } from "../../../lib/runtime";

export const GET: APIRoute = async ({ locals, request }) =>
  handleApi(request, async () => {
    if (!locals.tenantId) throw new HttpError("unauthenticated", 401);
    const db = d1Db(runtimeEnv().DB);
    return json({ wallet: await getWallet(db, locals.tenantId), ledger: await listLedger(db, locals.tenantId) });
  });
