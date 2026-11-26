import { defineMiddleware } from "astro:middleware";
import { createAuth, getSessionContext } from "@templatedesign/platform/auth";
import {
  assertCsrf,
  CSRF_COOKIE,
  CsrfError,
  createCsrfToken,
  LOCALE_COOKIE,
  localeCookie,
  parseCookies,
} from "@templatedesign/platform/csrf";
import { errorResponse, HttpError } from "@templatedesign/platform/http";
import { legacyRedirect } from "@templatedesign/platform/legacy-redirects";
import "./lib/platform";
import { runtimeEnv } from "./lib/runtime";

export const GUEST_COOKIE = "ta_guest";

const PUBLIC_API = new Set([
  "/api/v1/health",
  "/api/v1/session",
  "/api/v1/key",
  "/api/v1/packs",
  "/api/v1/capabilities",
  "/api/v1/locale",
  "/api/v1/links/preview",
  "/api/v1/internal/sweep",
  "/api/v1/payment-webhooks/paddle",
  "/api/v1/payment-webhooks/stripe",
]);

const isPublicApi = (path: string) => PUBLIC_API.has(path) || path.startsWith("/api/v1/library");

/**
 * Endpoints a visitor without an account may call: the free tier is the product's hook. The route
 * still resolves the actor (guest cookie, API key or session) and enforces ownership.
 */
const isGuestApi = (path: string) =>
  path === "/api/v1/transcriptions" || path.startsWith("/api/v1/transcriptions/") || path === "/api/v1/uploads";
const isSignedWebhook = (path: string) => path.startsWith("/api/v1/payment-webhooks/");

/**
 * Worker endpoints authenticate with a per-worker bearer token (hashed in D1), so they are
 * outside the cookie/CSRF path entirely: no session, no origin check, no admin gate.
 */
const isWorkerApi = (path: string) => path.startsWith("/api/internal/worker/");

/**
 * Session, locale, guest identity and the API CSRF gate. The platform owns the auth and CSRF
 * primitives; this file only states which routes are public.
 */
export const onRequest = defineMiddleware(async (context, next) => {
  const env = runtimeEnv();
  if (!env) throw new Error("Cloudflare bindings are missing. Run with the Cloudflare adapter.");

  // Retired customer URLs 301 to their state on the three-page site before any session work.
  if (["GET", "HEAD"].includes(context.request.method)) {
    const legacy = legacyRedirect(context.url, "transcript");
    if (legacy) {
      const headers = new Headers({ location: legacy.location });
      if (legacy.setLocale) headers.append("set-cookie", localeCookie(legacy.setLocale, env));
      return new Response(null, { status: 301, headers });
    }
  }

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

  let guestId = cookies[GUEST_COOKIE];
  if (!guestId || !/^gst_[a-f0-9]{32}$/.test(guestId)) {
    guestId = `gst_${[...crypto.getRandomValues(new Uint8Array(16))]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")}`;
    context.cookies.set(GUEST_COOKIE, guestId, {
      path: "/",
      sameSite: "lax",
      httpOnly: true,
      secure: context.url.protocol === "https:",
      maxAge: 60 * 60 * 24 * 365,
    });
  }
  context.locals.guestId = guestId;

  if (path.startsWith("/api/auth") || isWorkerApi(path)) return next();
  if (path.startsWith("/_astro/") || path === "/favicon.svg" || path === "/robots.txt") return next();

  const auth = createAuth(env);
  const session = await getSessionContext(auth, env, context.request);
  if (session) {
    context.locals.user = session.user;
    context.locals.session = session.session;
    context.locals.tenantId = session.tenantId;
    context.locals.profile = session.profile;
    context.locals.locale = session.profile.uiLanguage;
  }

  if (path.startsWith("/admin") && !session) {
    const nextUrl = `${path}${context.url.search}`;
    return context.redirect(`/auth/sign-in?next=${encodeURIComponent(nextUrl)}`);
  }

  const hasApiKey = context.request.headers.get("authorization")?.startsWith("Bearer tt_") ?? false;

  if (path.startsWith("/api/v1")) {
    if (!session && !hasApiKey && !isPublicApi(path) && !isGuestApi(path)) {
      return errorResponse(new HttpError("unauthenticated", 401), context.request);
    }
    if (!hasApiKey && !isSignedWebhook(path) && !["GET", "HEAD", "OPTIONS"].includes(context.request.method)) {
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
});
