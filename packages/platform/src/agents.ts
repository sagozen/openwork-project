import { createResourceServerChallenge } from "@better-auth/oauth-provider";
import { APIError, isAPIError } from "better-auth/api";
import {
  type AgentGrantRow,
  type AgentOAuthSettings,
  agentOAuthSettings,
  authOrigin,
  OFFLINE_ACCESS,
  verifiedConsentQuery,
} from "./agent-oauth";
import { createAuth } from "./auth";
import { platformConfig } from "./config";
import { assertCsrf, CsrfError } from "./csrf";
import { type Db, d1Db } from "./db";
import { errorResponse, HttpError, json, readJson } from "./http";
import { requireProfile } from "./tenancy";
import type { PlatformEnv } from "./types";

/**
 * OAuth-connected AI clients (Claude, ChatGPT...) for an app that configures
 * `createPlatform({ mcp })`. The app mounts:
 *
 * - `handleOAuthDiscovery` on `/.well-known/*` (protected-resource and authorization-server metadata);
 * - Better Auth's handler on `/api/auth/*` as it already does (registration, authorize, token);
 * - `handleAgentApi` on `/api/agents*` (consent page data, list and revoke connections);
 * - `withAgentAuthorization` around its MCP endpoint.
 *
 * Verified endpoint paths (Better Auth 1.7.12, base path `/api/auth`):
 * - `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource<resourcePath>`
 * - `/.well-known/oauth-authorization-server/api/auth` (RFC 8414) and `/api/auth/.well-known/oauth-authorization-server`
 * - `/api/auth/oauth2/register`, `/api/auth/oauth2/authorize`, `/api/auth/oauth2/consent`,
 *   `/api/auth/oauth2/token`, `/api/auth/oauth2/revoke`, `/api/auth/oauth2/introspect`
 */

export interface AgentUser {
  id: string;
  email: string;
  name: string;
}

/** Who an OAuth access token acts for. Tools must take the tenant from here, never from input. */
export interface AgentPrincipal {
  user: AgentUser;
  tenantId: string;
  scopes: ReadonlySet<string>;
}

export interface AgentGrant {
  id: string;
  clientId: string;
  name: string;
  scopes: string[];
  createdAt: string;
}

export interface AgentConsentDetails {
  clientId: string;
  name: string;
  scopes: string[];
  oauthQuery: string;
}

const NO_STORE = { "cache-control": "no-store" };
const BEARER = /^Bearer ([A-Za-z0-9._~+/-]+={0,2})$/i;
const MAX_TOKEN_LENGTH = 4096;

function settingsFor(env: PlatformEnv): AgentOAuthSettings {
  const config = platformConfig().mcp;
  if (!config) throw new Error("The OAuth module is not enabled: pass `mcp` to createPlatform()");
  return agentOAuthSettings(env, config);
}

interface VerifyAgentAccessApi {
  verifyAgentAccess(input: { body: { token: string } }): Promise<{ user: AgentUser; scopes: string[] }>;
}

function parseScopes(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((scope): scope is string => typeof scope === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Verifies the request's OAuth bearer token (active, this app's resource and issuer, an active
 * grant) and runs `handler` with the principal. A missing, invalid, expired or revoked token
 * gets a 401 JSON-RPC error with the RFC 9728 `WWW-Authenticate` challenge that points MCP
 * clients at the protected-resource metadata, so they start a new authorization. Errors thrown
 * by `handler` propagate unchanged.
 */
export async function withAgentAuthorization(
  env: PlatformEnv,
  request: Request,
  handler: (agent: AgentPrincipal) => Promise<Response>,
): Promise<Response> {
  const settings = settingsFor(env);
  let agent: AgentPrincipal;
  try {
    const match = request.headers.get("authorization")?.match(BEARER);
    const token = match?.[1];
    if (!token || token.length > MAX_TOKEN_LENGTH) throw invalidToken();
    const api = createAuth(env).api as unknown as VerifyAgentAccessApi;
    const result = await api.verifyAgentAccess({ body: { token } });
    const profile = await requireProfile(d1Db(env.DB), result.user);
    agent = { user: result.user, tenantId: profile.tenantId, scopes: new Set(result.scopes) };
  } catch (error) {
    return challengeResponse(settings, error);
  }
  return handler(agent);
}

function invalidToken(): Error {
  return new APIError("UNAUTHORIZED", { error: "invalid_token" });
}

/** Maps an authentication failure to the MCP challenge; anything else (a database outage) propagates. */
function challengeResponse(settings: AgentOAuthSettings, error: unknown): Response {
  const challenge = isAPIError(error)
    ? createResourceServerChallenge(error, settings.resource, {
        challengeScopes: settings.scopes.filter((scope) => scope !== OFFLINE_ACCESS),
      })
    : undefined;
  if (!challenge) throw error;
  const headers = new Headers(challenge.headers);
  headers.set("cache-control", "no-store");
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: challenge.message }, id: null }),
    { status: challenge.statusCode, headers },
  );
}

/** Throws a 403 `forbidden` problem when the token was not granted `scope`. */
export function requireScope(scopes: ReadonlySet<string> | readonly string[], scope: string): void {
  const granted = scopes instanceof Set ? scopes : new Set(scopes as readonly string[]);
  if (!granted.has(scope)) {
    throw new HttpError("forbidden", 403, "This connection does not have the required scope.", {
      required: scope,
      scopes: [...granted],
    });
  }
}

/** The user's active connections, newest first. */
export async function listAgentGrants(db: Db, userId: string): Promise<AgentGrant[]> {
  const rows = await db.all<{ id: string; client_id: string; name: string | null; scopes: string; created_at: string }>(
    `SELECT g.id, g.client_id, c.name, g.scopes, g.created_at
     FROM agent_grants g JOIN oauthClient c ON c.clientId = g.client_id
     WHERE g.user_id = ? AND g.active = 1 ORDER BY g.created_at DESC, g.id DESC`,
    [userId],
  );
  return rows.map((row) => ({
    id: row.id,
    clientId: row.client_id,
    name: row.name ?? row.client_id,
    scopes: parseScopes(row.scopes),
    createdAt: row.created_at,
  }));
}

/**
 * Revokes one of the user's connections. In one atomic batch: deactivates the grant and rotates
 * its generation (so a token being issued right now for the old generation is refused by the
 * triggers), then deletes the client's access and refresh tokens, consents and pending
 * authorization codes for this user. Returns false when the grant is not the user's or not active.
 */
export async function revokeAgentGrant(db: Db, userId: string, grantId: string): Promise<boolean> {
  const grant = await db.first<AgentGrantRow>(
    "SELECT * FROM agent_grants WHERE id = ? AND user_id = ? AND active = 1",
    [grantId, userId],
  );
  if (!grant) return false;
  await db.batch([
    {
      sql: "UPDATE agent_grants SET active = 0, generation = ?, revoked_at = ? WHERE id = ? AND user_id = ?",
      params: [crypto.randomUUID(), Date.now(), grant.id, userId],
    },
    { sql: "DELETE FROM oauthAccessToken WHERE userId = ? AND clientId = ?", params: [userId, grant.client_id] },
    { sql: "DELETE FROM oauthRefreshToken WHERE userId = ? AND clientId = ?", params: [userId, grant.client_id] },
    { sql: "DELETE FROM oauthConsent WHERE userId = ? AND clientId = ?", params: [userId, grant.client_id] },
    {
      sql: `DELETE FROM verification WHERE json_valid(value)
            AND json_extract(value, '$.type') = 'authorization_code'
            AND json_extract(value, '$.userId') = ? AND json_extract(value, '$.query.client_id') = ?`,
      params: [userId, grant.client_id],
    },
  ]);
  return true;
}

/** The MCP URL to paste into a client, and whether a remote AI service can reach it. */
export function agentConnectorUrl(env: PlatformEnv): { mcpUrl: string; remoteReady: boolean } {
  const endpoint = new URL(settingsFor(env).resource);
  const local =
    endpoint.hostname === "localhost" || endpoint.hostname === "[::1]" || endpoint.hostname.startsWith("127.");
  return { mcpUrl: endpoint.href, remoteReady: endpoint.protocol === "https:" && !local };
}

/**
 * Serves OAuth discovery for `/.well-known/*`; returns null for any other path so the app can
 * fall through. Covers the protected-resource metadata (`/.well-known/oauth-protected-resource`
 * and `/.well-known/oauth-protected-resource<resourcePath>`), the RFC 8414 authorization-server
 * metadata (`/.well-known/oauth-authorization-server/api/auth`) and, for clients that ignore
 * the issuer path, `/.well-known/oauth-authorization-server`.
 */
export async function handleOAuthDiscovery(env: PlatformEnv, request: Request): Promise<Response | null> {
  const settings = settingsFor(env);
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");
  const protectedResource = new Set([
    "/.well-known/oauth-protected-resource",
    `/.well-known/oauth-protected-resource${settings.resourcePath}`,
  ]);
  const authorizationServer = new Set([
    "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-authorization-server/api/auth",
  ]);
  if (!protectedResource.has(path) && !authorizationServer.has(path)) return null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
  }
  const auth = createAuth(env);
  if (protectedResource.has(path)) {
    return auth.handler(new Request(`${authOrigin(env)}${path}`, { method: request.method }));
  }
  return auth.handler(
    new Request(`${authOrigin(env)}/api/auth/.well-known/oauth-authorization-server`, { method: request.method }),
  );
}

export interface AgentApiSession {
  user: { id: string; email: string; name: string };
  session: { id: string };
}

/**
 * JSON API behind the signed-in session for the consent page and the connections list. Returns
 * null for paths outside `/api/agents`. State-changing requests require the CSRF token.
 *
 * - `GET  /api/agents` → `{ mcpUrl, remoteReady, connections: AgentGrant[] }`
 * - `POST /api/agents/revoke` `{ id }` → `{ revoked: true }`
 * - `GET  /api/agents/consent?oauth_query=…` → `AgentConsentDetails`
 * - `POST /api/agents/consent` `{ oauthQuery, accept, scope? }` → `{ redirectTo }` (the client's
 *   redirect with the code, or with `error=access_denied` when declined)
 */
export async function handleAgentApi(
  env: PlatformEnv,
  request: Request,
  session: AgentApiSession | null,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/agents" && !url.pathname.startsWith("/api/agents/")) return null;
  try {
    if (!session) throw new HttpError("unauthenticated", 401, "Sign in to manage connected apps.");
    if (!["GET", "HEAD"].includes(request.method)) {
      try {
        assertCsrf(request, env);
      } catch (error) {
        if (error instanceof CsrfError) {
          throw new HttpError("forbidden", 403, "CSRF or origin check failed.", { reason: error.message });
        }
        throw error;
      }
    }
    const db = d1Db(env.DB);
    const path = url.pathname.replace(/\/+$/, "");
    if (path === "/api/agents" && request.method === "GET") {
      return json(
        { ...agentConnectorUrl(env), connections: await listAgentGrants(db, session.user.id) },
        { headers: NO_STORE },
      );
    }
    if (path === "/api/agents/revoke" && request.method === "POST") {
      const body = await readJson<{ id?: unknown }>(request);
      if (typeof body?.id !== "string" || body.id.length === 0 || body.id.length > 64) {
        throw new HttpError("invalid_input", 400, "A connection id is required.");
      }
      if (!(await revokeAgentGrant(db, session.user.id, body.id))) {
        throw new HttpError("not_found", 404, "Connection not found.");
      }
      return json({ revoked: true }, { headers: NO_STORE });
    }
    if (path === "/api/agents/consent" && request.method === "GET") {
      const details = await verifiedConsentQuery(
        env,
        settingsFor(env),
        url.searchParams.get("oauth_query") ?? "",
        session.session.id,
        session.user.id,
      );
      const response: AgentConsentDetails = {
        clientId: details.clientId,
        name: details.name,
        scopes: details.scopes,
        oauthQuery: details.oauthQuery,
      };
      return json(response, { headers: NO_STORE });
    }
    if (path === "/api/agents/consent" && request.method === "POST") {
      const body = await readJson<{ oauthQuery?: unknown; accept?: unknown; scope?: unknown }>(request);
      if (
        typeof body?.oauthQuery !== "string" ||
        typeof body.accept !== "boolean" ||
        (body.scope !== undefined && typeof body.scope !== "string")
      ) {
        throw new HttpError("invalid_input", 400, "oauthQuery and accept are required.");
      }
      const result = await createAuth(env).api.oauth2Consent({
        // The provider reads the session and origin from the original request.
        request,
        headers: request.headers,
        asResponse: true,
        body: {
          accept: body.accept,
          oauth_query: body.oauthQuery,
          ...(body.scope === undefined ? {} : { scope: body.scope }),
        },
      });
      const outcome = (await result.json().catch(() => null)) as ProviderErrorBody & { url?: unknown };
      if (!result.ok) throw providerError(result.status, outcome);
      const redirect = outcome?.url;
      if (typeof redirect !== "string") throw new HttpError("dependency_unavailable", 503);
      return json({ redirectTo: new URL(redirect, authOrigin(env)).href }, { headers: NO_STORE });
    }
    throw new HttpError("not_found", 404, "Agent endpoint not found.");
  } catch (error) {
    return errorResponse(isAPIError(error) ? providerError(error.statusCode, error.body) : error, request);
  }
}

type ProviderErrorBody = { message?: unknown; error_description?: unknown } | null | undefined;

/** Maps a Better Auth OAuth error to the platform's problem codes. */
function providerError(status: number, body: ProviderErrorBody): HttpError {
  if (status >= 500) return new HttpError("dependency_unavailable", 503);
  const message =
    typeof body?.message === "string"
      ? body.message
      : typeof body?.error_description === "string"
        ? body.error_description
        : "Unable to complete the authorization.";
  if (status === 401) return new HttpError("unauthenticated", 401, message);
  if (status === 403) return new HttpError("forbidden", 403, message);
  if (status === 429) return new HttpError("rate_limited", 429, message);
  return new HttpError("invalid_input", 400, message);
}
