import { d1Db } from "@templatedesign/platform/db";
import { json } from "@templatedesign/platform/http";
import type { APIRoute } from "astro";
import { runtimeEnv } from "../../../lib/runtime";

export const GET: APIRoute = async () => {
  try {
    await d1Db(runtimeEnv().DB).first("SELECT 1 AS ok");
    return json({ status: "ok" });
  } catch {
    return json({ status: "degraded" }, { status: 503 });
  }
};
