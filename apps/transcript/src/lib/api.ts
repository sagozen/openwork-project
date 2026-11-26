import { HttpError } from "@templatedesign/platform/http";
import { type RequestPrincipal, resolvePrincipal } from "@templatedesign/platform/principal";
/** The subset of `Astro.locals` this module reads (Astro has no exported `App` type). */
export interface ApiLocals {
  user?: { id: string; email: string; name: string; emailVerified: boolean };
  tenantId?: string;
  guestId?: string;
}

type Locals = ApiLocals;

export interface Actor {
  tenantId: string | null;
  userId: string | null;
  guestId: string | null;
  viaApi: boolean;
  livemode: boolean;
}

/**
 * Resolves who is asking: a signed-in browser, an API key with the right scope, or a guest
 * identified by the `ta_guest` cookie. Guests can only create free jobs.
 */
export async function resolveActor(
  locals: Locals,
  request: Request,
  scope: "transcriptions:write" | "transcriptions:read" | "usage:read" = "transcriptions:write",
): Promise<Actor> {
  if (locals.user && locals.tenantId) {
    return {
      tenantId: locals.tenantId,
      userId: locals.user.id,
      guestId: null,
      viaApi: false,
      livemode: true,
    };
  }
  const principal: RequestPrincipal | null = locals.user
    ? null
    : await resolvePrincipal({ user: locals.user, tenantId: locals.tenantId }, request, scope).catch(() => null);
  if (principal) {
    return {
      tenantId: principal.tenantId,
      userId: principal.userId,
      guestId: null,
      viaApi: true,
      livemode: principal.livemode,
    };
  }
  const guestId = locals.guestId ?? "";
  if (!guestId) throw new HttpError("unauthenticated", 401);
  return { tenantId: null, userId: null, guestId, viaApi: false, livemode: true };
}

export { actorOwnsJob } from "./job-owner";

export function actorSubject(actor: Actor): string {
  return actor.tenantId ?? actor.guestId ?? "";
}

export async function verifyTurnstile(
  env: { TURNSTILE_SECRET?: string },
  token: unknown,
  remoteIp: string | null,
): Promise<void> {
  const secret = env.TURNSTILE_SECRET;
  if (!secret) return;
  if (typeof token !== "string" || token.length < 10) {
    throw new HttpError("forbidden", 403, "Complete the bot check and try again.", { reason: "turnstile_required" });
  }
  const body = new URLSearchParams({ secret, response: token });
  if (remoteIp) body.set("remoteip", remoteIp);
  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body,
  }).catch(() => null);
  if (!response?.ok) {
    throw new HttpError("forbidden", 403, "The bot check could not be verified.", { reason: "turnstile_failed" });
  }
  const result = (await response.json().catch(() => ({}))) as { success?: boolean };
  if (!result.success) {
    throw new HttpError("forbidden", 403, "The bot check failed. Try again.", { reason: "turnstile_failed" });
  }
}
