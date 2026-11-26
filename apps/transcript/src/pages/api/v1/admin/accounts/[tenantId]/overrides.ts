import { requireAdmin, setTenantOverride } from "@templatedesign/platform/admin";
import { d1Db } from "@templatedesign/platform/db";
import { handleApi, json, readJson } from "@templatedesign/platform/http";
import type { APIRoute } from "astro";
import { runtimeEnv } from "../../../../../../lib/runtime";

export const POST: APIRoute = async ({ locals, params, request }) =>
  handleApi(request, async () => {
    const db = d1Db(runtimeEnv().DB);
    const actor = await requireAdmin(db, locals.user, runtimeEnv(), "admin");
    const body = await readJson<{
      key: "test_daily_cap" | "free_monthly_credits" | "jobs_per_minute";
      value: number | null;
      expiresAt?: string | null;
      reason: string;
    }>(request);
    await setTenantOverride(
      db,
      actor,
      params.tenantId ?? "",
      body.key,
      body.value,
      body.expiresAt ?? null,
      body.reason ?? "",
    );
    return json({ updated: true });
  });
