import { assignRole, requireAdmin } from "@templatedesign/platform/admin";
import { d1Db } from "@templatedesign/platform/db";
import { handleApi, json, readJson } from "@templatedesign/platform/http";
import type { APIRoute } from "astro";
import { runtimeEnv } from "../../../../lib/runtime";

export const POST: APIRoute = async ({ locals, request }) =>
  handleApi(request, async () => {
    const db = d1Db(runtimeEnv().DB);
    const actor = await requireAdmin(db, locals.user, runtimeEnv(), "admin");
    const body = await readJson<{ email: string; role: "admin" | "support"; reason: string }>(request);
    await assignRole(db, actor, body.email, body.role, body.reason ?? "role assignment");
    return json({ updated: true });
  });
