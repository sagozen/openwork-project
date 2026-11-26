import { defineMiddleware } from "astro:middleware";
import { withSecurityHeaders } from "@templatedesign/app-shell/security";
import { createAuth, getSessionContext } from "@templatedesign/platform/auth";
import { platformConfig } from "@templatedesign/platform/config";
import {
  assertCsrf,
  CSRF_COOKIE,
  CsrfError,
  createCsrfToken,
  LOCALE_COOKIE,
  parseCookies,
} from "@templatedesign/platform/csrf";
import { errorResponse, HttpError } from "@templatedesign/platform/http";
import type { APIContext, MiddlewareNext } from "astro";
import { isOwner } from "./lib/auth/owner";
import "./lib/platform";
import { runtimeEnv } from "./lib/runtime";

/**
 * Routes that authenticate themselves with a bearer token or a signature instead of a browser
 * session: the MCP endpoint, the OAuth discovery documents, the Better Auth handler and the health
 * check. They skip the session redirect and the cookie CSRF check.
 */
const isSelfAuthenticated = (path: string) =>
  path === "/mcp" || path.startsWith("/.well-known/") || path.startsWith("/api/auth") || path === "/api/v1/health";

const isStatic = (path: string) => path.startsWith("/_astro/") || path === "/favicon.svg" || path === "/robots.txt";

/** A bearer that looks like one of this app's API keys, so the key check skips cookie CSRF. */
function hasApiKey(request: Request): boolean {
  const prefix = platformConfig().apiKeyPrefix ?? "td";
  return request.headers.get("authorization")?.startsWith(`Bearer ${prefix}_`) ?? false;
}

const notOwner = (request: Request) =>
  errorResponse(new HttpError("forbidden", 403, "This account is not the owner of this app."), request);

/**
 * Session, locale and the API CSRF gate. Only the owner's session is ever exposed to pages and
 * routes: a session for any other address leaves `locals.user` unset and sets `locals.nonOwner`, so
 * a page or route that forgets to check still sees an anonymous request.
 */
async function handle(context: APIContext, next: MiddlewareNext): Promise<Response> {
  const env = runtimeEnv();
  if (!env) throw new Error("Cloudflare bindings are missing. Run with the Cloudflare adapter.");

  const path = context.url.pathname;
  // Public share pages: the token and the password cookie are the whole check, and they set no app cookies.
  if (path.startsWith("/s/")) return next();
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

  if (isStatic(path) || isSelfAuthenticated(path)) return next();

  const session = await getSessionContext(createAuth(env), env, context.request);
  if (session && isOwner(session.user.email, env)) {
    context.locals.user = session.user;
    context.locals.session = session.session;
    context.locals.tenantId = session.tenantId;
    context.locals.profile = session.profile;
  } else if (session) {
    context.locals.nonOwner = true;
  }

  if ((path.startsWith("/admin") || path === "/account") && !context.locals.user) {
    const nextUrl = `${path}${context.url.search}`;
    const reason = context.locals.nonOwner ? "&error=not_owner" : "";
    return context.redirect(`/sign-in?next=${encodeURIComponent(nextUrl)}${reason}`);
  }

  if (path.startsWith("/api/agents") && context.locals.nonOwner) return notOwner(context.request);

  if (path.startsWith("/api/v1")) {
    const apiKey = hasApiKey(context.request);
    if (!context.locals.user && !apiKey) {
      return context.locals.nonOwner
        ? notOwner(context.request)
        : errorResponse(new HttpError("unauthenticated", 401), context.request);
    }
    if (!apiKey && !["GET", "HEAD", "OPTIONS"].includes(context.request.method)) {
      try {
        assertCsrf(context.request, env);
      } catch (error) {
        if (error instanceof CsrfError) {
          return errorResponse(
            new HttpError("forbidden", 403, "CSRF or origin check failed.", { reason: error.message }),
            context.request,
          );
        }
        throw error;
      }
    }
  }

  return next();
}

/** Every response carries the shared security headers: no framing, no sniffing, a tight CSP. */
export const onRequest = defineMiddleware(async (context, next) => withSecurityHeaders(await handle(context, next)));
