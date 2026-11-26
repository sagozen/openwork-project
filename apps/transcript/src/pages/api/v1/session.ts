import { d1Db } from "@templatedesign/platform/db";
import { getDeletionRequest } from "@templatedesign/platform/deletion";
import { json } from "@templatedesign/platform/http";
import type { APIRoute } from "astro";
import { runtimeEnv } from "../../../lib/runtime";

export const GET: APIRoute = async ({ locals }) => {
  if (!locals.user || !locals.profile) {
    return json({ user: null, csrfToken: locals.csrfToken, locale: locals.locale, guestId: locals.guestId });
  }
  const deletion = await getDeletionRequest(d1Db(runtimeEnv().DB), locals.user.id);
  return json({
    user: {
      id: locals.user.id,
      email: locals.user.email,
      name: locals.user.name,
      emailVerified: locals.user.emailVerified,
    },
    tenantId: locals.tenantId,
    profile: locals.profile,
    csrfToken: locals.csrfToken,
    locale: locals.locale,
    guestId: locals.guestId,
    deletion,
  });
};
