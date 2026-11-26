import { withAgentAuthorization } from "@templatedesign/platform/agents";
import { platformConfig } from "@templatedesign/platform/config";
import { d1Db } from "@templatedesign/platform/db";
import { authenticateApiKey } from "@templatedesign/platform/keys";
import type { Caller } from "../images/service";
import type { Env } from "../types";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

/** Plain JSON error, used for API keys: those clients have no OAuth flow to start. */
export function plainError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), { status, headers: JSON_HEADERS });
}

function bearer(request: Request): string | null {
  const match = request.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i);
  return match?.[1] ?? null;
}

/** True when the bearer is shaped like one of this app's API keys (for example `if_live_...`). */
export function looksLikeApiKey(token: string | null): boolean {
  const prefix = platformConfig().apiKeyPrefix ?? "td";
  return token !== null && new RegExp(`^${prefix}_(live|test)_`).test(token);
}

async function isSuspended(env: Env, tenantId: string): Promise<boolean> {
  const row = await d1Db(env.DB).first<{ suspended_at: string | null }>(
    "SELECT suspended_at FROM tenants WHERE id = ?",
    [tenantId],
  );
  return Boolean(row?.suspended_at);
}

/**
 * Resolves who is calling and runs `handler` with a `Caller`. An API key (`if_live_...`) is
 * checked against the key table; anything else is verified as an OAuth access token, which starts
 * the connector sign-in again when it is missing, expired or revoked. A suspended account is
 * refused on both paths. Tools and routes never see which path was used beyond `via`.
 */
export async function withCaller(
  env: Env,
  request: Request,
  handler: (caller: Caller) => Promise<Response>,
): Promise<Response> {
  const token = bearer(request);
  if (looksLikeApiKey(token)) {
    const principal = await authenticateApiKey(d1Db(env.DB), token as string);
    if (!principal?.livemode) {
      return plainError(401, "unauthenticated", "Invalid or revoked API key.");
    }
    if (await isSuspended(env, principal.tenantId)) {
      return plainError(403, "account_suspended", "This account is suspended.");
    }
    return handler({
      tenantId: principal.tenantId,
      userId: principal.userId,
      scopes: principal.scopes,
      via: "api_key",
    });
  }
  return withAgentAuthorization(env, request, async (agent) => {
    if (await isSuspended(env, agent.tenantId)) {
      return plainError(403, "account_suspended", "This account is suspended.");
    }
    return handler({ tenantId: agent.tenantId, userId: agent.user.id, scopes: [...agent.scopes], via: "oauth" });
  });
}
