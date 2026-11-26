import { defineMiddleware, sequence } from "astro:middleware";
import { createShellMiddleware } from "@templatedesign/app-shell/middleware";
import { createAuth, getSessionContext } from "@templatedesign/platform/auth";
import { CSRF_COOKIE, createCsrfToken, LOCALE_COOKIE, parseCookies } from "@templatedesign/platform/csrf";
import "./lib/platform";
import { runtimeEnv } from "./lib/runtime";

/** Device-facing OTA routes, `/<workspace>/ota/...`: bearer-token clients that never carry a session or cookie. */
const DEVICE_PATH = /^\/[^/]+\/ota\//;

/** Session, locale and the CSRF cookie. The shell middleware below resolves the workspace. */
const session = defineMiddleware(async (context, next) => {
  const env = runtimeEnv();
  const path = context.url.pathname;
  if (DEVICE_PATH.test(path)) {
    context.locals.locale = "en";
    return next();
  }
  const cookies = parseCookies(context.request.headers.get("cookie"));
  context.locals.locale = cookies[LOCALE_COOKIE] === "vi" ? "vi" : "en";

  let csrfToken = cookies[CSRF_COOKIE];
  if (!csrfToken) {
    csrfToken = createCsrfToken();
    context.cookies.set(CSRF_COOKIE, csrfToken, {
      path: "/",
      sameSite: "lax",
      httpOnly: false,
      secure: context.url.protocol === "https:",
      maxAge: 60 * 60 * 24,
    });
  }
  context.locals.csrfToken = csrfToken;

  if (path.startsWith("/api/auth") || path.startsWith("/_astro/") || path.startsWith("/brand/")) return next();

  const found = await getSessionContext(createAuth(env), env, context.request);
  if (found) {
    context.locals.user = found.user;
    context.locals.session = found.session;
    context.locals.tenantId = found.tenantId;
    context.locals.profile = found.profile;
    context.locals.locale = found.profile.uiLanguage;
  }
  return next();
});

export const onRequest = sequence(session, createShellMiddleware());
