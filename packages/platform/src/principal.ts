import { d1Db } from "./db";
import { HttpError } from "./http";
import { authenticateApiKey, requireApiKeyScope } from "./keys";
import { runtimeEnv } from "./runtime";
import type { AuthUser } from "./types";

export interface RequestPrincipal {
  tenantId: string;
  userId: string;
  source: "web" | "api";
  livemode: boolean;
  keyId?: string;
}

/**
 * Resolves either a signed-in browser session or a bearer API key. API-key
 * requests are never CSRF-protected because they do not rely on ambient
 * cookies; the middleware also skips the session gate for them.
 */
export async function resolvePrincipal(
  locals: { user?: AuthUser; tenantId?: string },
  request: Request,
  scope: string,
): Promise<RequestPrincipal> {
  if (locals.user && locals.tenantId) {
    return { tenantId: locals.tenantId, userId: locals.user.id, source: "web", livemode: true };
  }
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) throw new HttpError("unauthenticated", 401);
  const principal = await authenticateApiKey(d1Db(runtimeEnv().DB), header.slice(7).trim());
  if (!principal) throw new HttpError("unauthenticated", 401, "Invalid or revoked API key.");
  requireApiKeyScope(principal, scope);
  return {
    tenantId: principal.tenantId,
    userId: principal.userId,
    source: "api",
    livemode: principal.livemode,
    keyId: principal.keyId,
  };
}
