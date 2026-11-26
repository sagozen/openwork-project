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
import "./lib/platform";
import { runtimeEnv } from "./lib/runtime";

/** Endpoints that need no session: health, the provider callback and the machine-facing API. */
const PUBLIC_API = new Set(["/api/v1/health", "/api/v1/fal-webhook"]);

/**
 * Routes that authenticate themselves with a bearer token or a signature instead of a browser
 * session: the MCP endpoint, the OAuth discovery documents, the public image host, the worker API
 * (its own `wkr_` token) and the Better Auth handler. They skip the session redirect and the cookie CSRF check.
 */
const isSelfAuthenticated = (path: string) =>
  path === "/mcp" ||
  path.startsWith("/.well-known/") ||
  path.startsWith("/api/auth") ||
  path.startsWith("/i/") ||
  path.startsWith("/api/internal/worker/") ||
  PUBLIC_API.has(path);

const isStatic = (path: string) => path.startsWith("/_astro/") || path === "/favicon.svg" || path === "/robots.txt";

/** A bearer that looks like one of this app's API keys, so the key check skips cookie CSRF. */
function hasApiKey(request: Request): boolean {
  const prefix = platformConfig().apiKeyPrefix ?? "td";
  return request.headers.get("authorization")?.startsWith(`Bearer ${prefix}_`) ?? false;
}

/**
 * Session, locale and the API CSRF gate. The platform owns the auth and CSRF primitives; this file
 * only states which routes are public or self-authenticated.
 */
async function handle(context: APIContext, next: MiddlewareNext): Promise<Response> {
  const env = runtimeEnv();
  if (!env) throw new Error("Cloudflare bindings are missing. Run with the Cloudflare adapter.");

  const path = context.url.pathname;
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

  const auth = createAuth(env);
  const session = await getSessionContext(auth, env, context.request);
  if (session) {
    context.locals.user = session.user;
    context.locals.session = session.session;
    context.locals.tenantId = session.tenantId;
    context.locals.profile = session.profile;
  }

  if ((path.startsWith("/admin") || path === "/account") && !session) {
    const nextUrl = `${path}${context.url.search}`;
    return context.redirect(`/sign-in?next=${encodeURIComponent(nextUrl)}`);
  }

  if (path.startsWith("/api/v1")) {
    const apiKey = hasApiKey(context.request);
    if (!session && !apiKey) return errorResponse(new HttpError("unauthenticated", 401), context.request);
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
