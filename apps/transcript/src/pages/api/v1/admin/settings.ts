import { requireAdmin, setAdminSetting } from "@templatedesign/platform/admin";
import { d1Db } from "@templatedesign/platform/db";
import { HttpError, handleApi, json, readJson } from "@templatedesign/platform/http";
import type { APIRoute } from "astro";
import { runtimeEnv } from "../../../../lib/runtime";

export const PATCH: APIRoute = async ({ locals, request }) =>
  handleApi(request, async () => {
    const db = d1Db(runtimeEnv().DB);
    const actor = await requireAdmin(db, locals.user, runtimeEnv(), "admin");
    const body = await readJson<{ key: string; value: unknown; reason: string }>(request);
    if (!body.reason?.trim()) throw new HttpError("invalid_input", 400, "A reason is required.");
    await setAdminSetting(db, actor, body.key, body.value, body.reason.trim());
    return json({ updated: true });
  });
