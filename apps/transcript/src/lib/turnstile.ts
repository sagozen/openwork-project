import type { APIContext } from "astro";

/**
 * Guest verification. A Turnstile token is single use, so the first successful check (usually the
 * link preview) mints a short-lived HttpOnly cookie; creating the job afterwards accepts either a
 * fresh token or that cookie. This keeps one human check per visitor per 15 minutes instead of one
 * per request, without letting a script create jobs directly.
 */
export const HUMAN_COOKIE = "ta_human";

export const HUMAN_COOKIE_MAX_AGE = 15 * 60;

export function isHumanCookie(context: APIContext): boolean {
  return context.cookies.get(HUMAN_COOKIE)?.value === "1";
}

export function markHuman(context: APIContext): void {
  context.cookies.set(HUMAN_COOKIE, "1", {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: context.url.protocol === "https:",
    maxAge: HUMAN_COOKIE_MAX_AGE,
  });
}

export function turnstileRequired(env: { TURNSTILE_SECRET?: string }): boolean {
  return Boolean(env.TURNSTILE_SECRET);
}
