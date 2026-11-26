import { localeCookie } from "@templatedesign/platform/csrf";
import { d1Db } from "@templatedesign/platform/db";
import { updateSettings } from "@templatedesign/platform/tenancy";
import type { APIRoute } from "astro";
import { runtimeEnv } from "../../../lib/runtime";

/**
 * Language switcher for the public pages. Sets the locale cookie and returns to the page the
 * visitor came from, so no page needs a duplicated `/vi/` route. A signed-in profile language wins
 * over the cookie, so it is updated too.
 */
export const GET: APIRoute = async ({ request, url, locals }) => {
  const env = runtimeEnv();
  const locale = url.searchParams.get("to") === "vi" ? "vi" : "en";
  const referer = request.headers.get("referer");
  let target = "/";
  if (referer) {
    try {
      const parsed = new URL(referer);
      if (parsed.origin === url.origin) target = `${parsed.pathname}${parsed.search}`;
    } catch {
      target = "/";
    }
  }
  if (locals.profile && locals.profile.uiLanguage !== locale) {
    try {
      await updateSettings(d1Db(env.DB), locals.profile, { uiLanguage: locale });
    } catch (error) {
      // The cookie still applies to signed-out pages; log and carry on rather than block the switch.
      console.error("locale: could not update the profile language", error);
    }
  }
  return new Response(null, {
    status: 302,
    headers: { location: target, "set-cookie": localeCookie(locale, env) },
  });
};
