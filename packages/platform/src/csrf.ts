import type { PlatformEnv } from "./types";

export const CSRF_COOKIE = "td_csrf";
export const LOCALE_COOKIE = "td_locale";

export function parseCookies(header: string | null): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name) cookies[name] = decodeURIComponent(value);
  }
  return cookies;
}

export function createCsrfToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function csrfCookie(token: string, env: PlatformEnv): string {
  const secure = (env.APP_ORIGIN || env.BETTER_AUTH_URL || "").startsWith("https://");
  // Readable by same-origin JS so it can echo the value in X-CSRF-Token.
  return `${CSRF_COOKIE}=${encodeURIComponent(token)}; Path=/; SameSite=Lax; Max-Age=86400${secure ? "; Secure" : ""}`;
}

export function localeCookie(locale: "en" | "vi", env: PlatformEnv): string {
  const secure = (env.APP_ORIGIN || env.BETTER_AUTH_URL || "").startsWith("https://");
  return `${LOCALE_COOKIE}=${locale}; Path=/; SameSite=Lax; Max-Age=31536000${secure ? "; Secure" : ""}`;
}

export class CsrfError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export function assertSameOrigin(request: Request, env: PlatformEnv): void {
  const origin = request.headers.get("origin");
  const expected = (env.APP_ORIGIN || env.BETTER_AUTH_URL || new URL(request.url).origin).replace(/\/$/, "");
  const allowed = new Set([expected, new URL(request.url).origin]);
  if (!origin || !allowed.has(origin.replace(/\/$/, ""))) {
    throw new CsrfError("origin_check_failed");
  }
}

export function assertCsrf(request: Request, env: PlatformEnv): void {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
  assertSameOrigin(request, env);
  const cookies = parseCookies(request.headers.get("cookie"));
  const cookieToken = cookies[CSRF_COOKIE];
  const headerToken = request.headers.get("x-csrf-token");
  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    throw new CsrfError("csrf_check_failed");
  }
}
