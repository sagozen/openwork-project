import { d1Db } from "@templatedesign/platform/db";
import { HttpError, handleApi, json, readJson } from "@templatedesign/platform/http";
import { type SettingsInput, SettingsValidationError, updateSettings } from "@templatedesign/platform/tenancy";
import type { APIRoute } from "astro";
import { runtimeEnv } from "../../../lib/runtime";

export const PATCH: APIRoute = async ({ locals, request }) =>
  handleApi(request, async () => {
    if (!locals.user || !locals.profile) throw new HttpError("unauthenticated", 401);
    const input = await readJson<SettingsInput>(request);
    const allowed = new Set([
      "displayName",
      "uiLanguage",
      "docLanguage",
      "defaultRetentionSeconds",
      "numberLocale",
      "dateLocale",
      "lowBalanceEmail",
    ]);
    for (const key of Object.keys(input)) {
      if (!allowed.has(key)) throw new HttpError("invalid_input", 400, `Unknown settings field: ${key}`);
    }
    try {
      const profile = await updateSettings(d1Db(runtimeEnv().DB), locals.profile, input);
      return json({ profile });
    } catch (error) {
      if (error instanceof SettingsValidationError) {
        throw new HttpError("invalid_input", 400, "Check the highlighted settings.", { errors: error.issues });
      }
      throw error;
    }
  });
