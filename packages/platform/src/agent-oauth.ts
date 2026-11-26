import { mcp } from "@better-auth/mcp";
import { getOAuthProviderApi, verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import { APIError, createAuthEndpoint, getSessionFromCtx } from "better-auth/api";
import type { McpConfig } from "./config";
import { type Db, d1Db, nowIso } from "./db";
import { HttpError } from "./http";
import { takeRateLimit } from "./rate-limit";
import type { PlatformEnv } from "./types";

/**
 * The OAuth authorization server behind an app's MCP endpoint (Better Auth `mcp` plugin).
 * Internal to the platform: `auth.ts` mounts the plugin and hook, `agents.ts` exposes the
 * request helpers. Everything here runs only when the app passes `createPlatform({ mcp })`.
 *
 * Model: a user's consent for one OAuth client is one `agent_grants` row. Its `generation` is
 * stamped on every token as the consent reference; the migration's triggers refuse a token
 * whose generation is not the active one or whose scopes exceed the grant, and revoking
 * rotates the generation and deletes the client's tokens.
 */

/** Resolved, validated settings for one app. */
export interface AgentOAuthSettings {
  /** Canonical MCP resource URL, e.g. `https://app.example/mcp`. */
  resource: string;
  /** Path part of `resource`, e.g. `/mcp`. */
  resourcePath: string;
  /** OAuth issuer: the Better Auth base URL, `https://app.example/api/auth`. */
  issuer: string;
  origin: string;
  scopes: string[];
  defaultScopes: string[];
  consentPath: string;
}

export const OFFLINE_ACCESS = "offline_access";
export const DCR_LIMIT_PER_MINUTE = 5;
export const TOKEN_LIMIT_PER_MINUTE = 30;
const MAX_OAUTH_QUERY = 16_384;
const MAX_TOKEN_LENGTH = 4096;
const SCOPE_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;

export function authOrigin(env: PlatformEnv): string {
  return new URL(env.BETTER_AUTH_URL || env.APP_ORIGIN || "http://localhost:4321").origin;
}

/** Validates the app's `mcp` config once per auth instance; a bad config fails loudly. */
export function agentOAuthSettings(env: PlatformEnv, config: McpConfig): AgentOAuthSettings {
  const path = (value: string, name: string) => {
    if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || /[?#\s]/.test(value)) {
      throw new Error(`createPlatform({ mcp }): ${name} must be an absolute path such as "/mcp"`);
    }
    return value.length > 1 ? value.replace(/\/+$/, "") : value;
  };
  const resourcePath = path(config.resourcePath, "resourcePath");
  const consentPath = path(config.consentPath, "consentPath");
  const scopes = [...new Set(config.scopes)];
  if (scopes.length === 0 || scopes.some((scope) => !SCOPE_PATTERN.test(scope))) {
    throw new Error("createPlatform({ mcp }): scopes must be a non-empty list of scope names");
  }
  const defaultScopes = [...new Set(config.defaultScopes ?? scopes.filter((scope) => scope !== OFFLINE_ACCESS))];
  if (defaultScopes.length === 0 || defaultScopes.some((scope) => !scopes.includes(scope))) {
    throw new Error("createPlatform({ mcp }): defaultScopes must be a non-empty subset of scopes");
  }
  const origin = authOrigin(env);
  return {
    resource: `${origin}${resourcePath}`,
    resourcePath,
    issuer: `${origin}/api/auth`,
    origin,
    scopes,
    defaultScopes,
    consentPath,
  };
}

export interface AgentGrantRow {
  id: string;
  user_id: string;
  client_id: string;
  generation: string;
  scopes: string;
  active: number;
  created_at: string;
  revoked_at: number;
}

export interface VerifiedConsent {
  clientId: string;
  name: string;
  scopes: string[];
  oauthQuery: string;
  grant: AgentGrantRow | null;
}

function invalidQuery(): never {
  throw new APIError("BAD_REQUEST", {
    code: "INVALID_OAUTH_QUERY",
    message: "The authorization request is invalid or expired. Start a new connection.",
  });
}

function parseScopes(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((scope): scope is string => typeof scope === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Checks a signed authorization request before the consent page shows it or accepts it: the
 * signature and expiry, a single value per parameter, the session it was issued to, PKCE S256,
 * this app's resource, an enabled client, and scopes the app offers and the client registered.
 * A request issued before the user's last revocation of that client is refused.
 */
export async function verifiedConsentQuery(
  env: PlatformEnv,
  settings: AgentOAuthSettings,
  oauthQuery: string,
  sessionId: string,
  userId: string,
): Promise<VerifiedConsent> {
  const query = oauthQuery.startsWith("?") ? oauthQuery.slice(1) : oauthQuery;
  if (!query || query.length > MAX_OAUTH_QUERY || !(await verifyOAuthQueryParams(query, env.BETTER_AUTH_SECRET))) {
    invalidQuery();
  }
  const params = new URLSearchParams(query);
  for (const key of new Set(params.keys())) {
    if (key !== "resource" && key !== "ba_param" && params.getAll(key).length !== 1) invalidQuery();
  }
  const issuedAt = Number(params.get("ba_iat"));
  const expiresAt = Number(params.get("exp"));
  if (
    !Number.isFinite(issuedAt) ||
    issuedAt <= 0 ||
    issuedAt > Date.now() ||
    !Number.isFinite(expiresAt) ||
    expiresAt * 1000 < Date.now()
  ) {
    invalidQuery();
  }
  if (
    params.get("ba_pl") !== sessionId ||
    params.get("response_type") !== "code" ||
    params.get("code_challenge_method") !== "S256" ||
    !/^[A-Za-z0-9_-]{43}$/.test(params.get("code_challenge") ?? "")
  ) {
    invalidQuery();
  }
  if (params.getAll("resource").length !== 1 || params.get("resource") !== settings.resource) invalidQuery();
  const clientId = params.get("client_id");
  if (!clientId) invalidQuery();
  const db = d1Db(env.DB);
  const client = await db.first<{ clientId: string; name: string | null; disabled: number | null; scopes: string }>(
    "SELECT clientId, name, disabled, scopes FROM oauthClient WHERE clientId = ?",
    [clientId],
  );
  if (!client || client.disabled) invalidQuery();
  const registered = parseScopes(client.scopes);
  const scopes = [...new Set((params.get("scope") ?? "").split(" ").filter(Boolean))];
  if (!scopes.length || scopes.some((scope) => !settings.scopes.includes(scope) || !registered.includes(scope))) {
    invalidQuery();
  }
  const grant = await db.first<AgentGrantRow>("SELECT * FROM agent_grants WHERE user_id = ? AND client_id = ?", [
    userId,
    clientId,
  ]);
  if (grant && issuedAt <= grant.revoked_at) invalidQuery();
  return { clientId, name: client.name ?? clientId, scopes, oauthQuery: query, grant };
}

/**
 * Creates or re-activates the user's grant for the client. The upsert only takes effect when
 * the grant was not revoked after the request was issued and its generation is the one the
 * consent page saw, so two racing consents or a consent racing a revocation cannot widen it.
 */
async function consentGrant(
  db: Db,
  details: VerifiedConsent,
  userId: string,
  scopes: string[],
): Promise<AgentGrantRow> {
  const issuedAt = Number(new URLSearchParams(details.oauthQuery).get("ba_iat"));
  const generation = crypto.randomUUID();
  await db.run(
    `INSERT INTO agent_grants (id, user_id, client_id, generation, scopes, active, created_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, 0)
     ON CONFLICT (user_id, client_id) DO UPDATE SET scopes = excluded.scopes, active = 1
     WHERE agent_grants.revoked_at < ? AND agent_grants.generation = ?`,
    [
      crypto.randomUUID(),
      userId,
      details.clientId,
      generation,
      JSON.stringify(scopes),
      nowIso(),
      issuedAt,
      details.grant?.generation ?? generation,
    ],
  );
  const grant = await db.first<AgentGrantRow>(
    "SELECT * FROM agent_grants WHERE user_id = ? AND client_id = ? AND active = 1",
    [userId, details.clientId],
  );
  if (
    !grant ||
    grant.revoked_at >= issuedAt ||
    (details.grant && grant.generation !== details.grant.generation) ||
    !scopes.every((scope) => parseScopes(grant.scopes).includes(scope))
  ) {
    invalidQuery();
  }
  return grant;
}

/** Shape of the subset of Better Auth's hook context the hook reads. */
interface HookContext {
  path?: string;
  method?: string;
  body?: Record<string, unknown> | undefined;
  query?: Record<string, unknown> | undefined;
  request?: Request;
  headers?: Headers;
}

function clientIp(ctx: HookContext): string {
  const header = ctx.request?.headers.get("cf-connecting-ip") ?? ctx.headers?.get("cf-connecting-ip");
  return header?.trim().slice(0, 64) || "unknown";
}

async function limit(db: Db, bucket: string, max: number): Promise<void> {
  try {
    await takeRateLimit(db, bucket, max, 60);
  } catch (error) {
    if (error instanceof HttpError && error.status === 429) {
      throw new APIError(
        "TOO_MANY_REQUESTS",
        { error: "slow_down", error_description: error.message },
        error.headers ?? {},
      );
    }
    throw error;
  }
}

const BLOCKED_PROVIDER_PATHS =
  /^\/(?:admin\/oauth2\/|oauth2\/(?:create-client|update-client|delete-client|client\/|update-consent|delete-consent|end-session))/;

/**
 * Builds the `mcp` plugin, a server-only token verification endpoint and the `before` hook.
 * One instance per request: the consent reference travels from the hook to the plugin's
 * `consentReferenceId` callback inside the same `/oauth2/consent` call.
 */
export function agentAuthExtension(env: PlatformEnv, settings: AgentOAuthSettings) {
  const db = d1Db(env.DB);
  let consentReference: string | undefined;

  const provider = mcp({
    resource: settings.resource,
    loginPage: settings.consentPath,
    consentPage: settings.consentPath,
    scopes: settings.scopes,
    grantTypes: ["authorization_code", "refresh_token"],
    allowDynamicClientRegistration: true,
    allowUnauthenticatedClientRegistration: true,
    clientRegistrationDefaultScopes: settings.defaultScopes,
    clientRegistrationAllowedScopes: settings.scopes,
    clientRegistrationRequirePKCE: true,
    enforcePerClientResources: true,
    refreshTokenReuseInterval: 0,
    accessTokenExpiresIn: 900,
    codeExpiresIn: 600,
    // Opaque tokens keep a revocable database row; there is no JWT path to bypass revocation.
    disableJwtPlugin: true,
    storeTokens: "hashed",
    clientPrivileges: ({ action }) => action === "create",
    resourcePrivileges: () => false,
    postLogin: {
      page: settings.consentPath,
      shouldRedirect: () => false,
      consentReferenceId: () => {
        if (!consentReference) invalidQuery();
        return consentReference;
      },
    },
    customAccessTokenClaims: async ({ user, referenceId, scopes }) => {
      if (!user || !referenceId) throw new APIError("UNAUTHORIZED", { error: "invalid_token" });
      const grant = await db.first<AgentGrantRow>(
        "SELECT * FROM agent_grants WHERE user_id = ? AND generation = ? AND active = 1",
        [user.id, referenceId],
      );
      const granted = parseScopes(grant?.scopes);
      if (!grant || scopes.some((scope) => !granted.includes(scope))) {
        throw new APIError("UNAUTHORIZED", { error: "invalid_token" });
      }
      return {};
    },
  });

  const verifier = {
    id: "agent-access",
    endpoints: {
      verifyAgentAccess: createAuthEndpoint("/agent/verify", { method: "POST" }, async (ctx) => {
        const token = (ctx.body as { token?: unknown } | undefined)?.token;
        if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
          throw new APIError("UNAUTHORIZED", { error: "invalid_token" });
        }
        const claims = await getOAuthProviderApi(ctx, provider.options).requireActiveAccessToken(token);
        const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
        if (
          !audiences.includes(settings.resource) ||
          claims.iss !== settings.issuer ||
          typeof claims.sub !== "string" ||
          claims.cnf
        ) {
          throw new APIError("UNAUTHORIZED", { error: "invalid_token" });
        }
        const user = await ctx.context.internalAdapter.findUserById(claims.sub);
        if (!user) throw new APIError("UNAUTHORIZED", { error: "invalid_token" });
        return {
          user: { id: user.id, email: user.email, name: user.name },
          scopes: typeof claims.scope === "string" ? claims.scope.split(" ").filter(Boolean) : [],
        };
      }),
    },
  };

  async function before(ctx: HookContext): Promise<unknown> {
    const viaHttp = Boolean(ctx.request);
    if (viaHttp && ctx.path && BLOCKED_PROVIDER_PATHS.test(ctx.path)) throw new APIError("FORBIDDEN");

    if (ctx.path === "/oauth2/register") {
      if (viaHttp) {
        await limit(db, `oauth_register:${clientIp(ctx)}`, DCR_LIMIT_PER_MINUTE);
      }
      const body = ctx.body as Record<string, unknown> | undefined;
      const redirects = body?.redirect_uris;
      const name = body?.client_name;
      if (
        !body ||
        (Array.isArray(redirects) && redirects.length > 10) ||
        (typeof name === "string" && name.length > 120) ||
        body.jwks_uri ||
        body.jwks ||
        body.backchannel_logout_uri ||
        body.subject_type === "pairwise" ||
        ![undefined, "none", "client_secret_basic", "client_secret_post"].includes(
          body.token_endpoint_auth_method as string | undefined,
        )
      ) {
        throw new APIError("BAD_REQUEST", { error: "invalid_client_metadata" });
      }
      return;
    }

    if (ctx.path === "/oauth2/token") {
      if (viaHttp) await limit(db, `oauth_token:${clientIp(ctx)}`, TOKEN_LIMIT_PER_MINUTE);
      if (ctx.body?.grant_type === "refresh_token") {
        const refreshToken = ctx.body.refresh_token;
        if (typeof refreshToken !== "string" || refreshToken.length > MAX_TOKEN_LENGTH) {
          throw new APIError("BAD_REQUEST", { error: "invalid_grant" });
        }
        const hashed = await getOAuthProviderApi(ctx as never, provider.options).hashToken(
          refreshToken,
          "refresh_token",
        );
        // A replayed rotated token must still reach the provider so it can revoke the family.
        const refresh = await db.first<{ scopes: string; revoked: string | null; granted: string }>(
          `SELECT t.scopes, t.revoked, g.scopes AS granted FROM oauthRefreshToken t
           JOIN agent_grants g ON g.user_id = t.userId AND g.client_id = t.clientId AND g.generation = t.referenceId
           WHERE t.token = ? AND g.active = 1`,
          [hashed],
        );
        const granted = parseScopes(refresh?.granted);
        if (
          !refresh ||
          (refresh.revoked === null && parseScopes(refresh.scopes).some((scope) => !granted.includes(scope)))
        ) {
          throw new APIError("BAD_REQUEST", { error: "invalid_grant" });
        }
      }
      return;
    }

    if (
      ctx.path === "/oauth2/authorize" &&
      ctx.request &&
      new URL(ctx.request.url).pathname.replace(/\/$/, "") === "/api/auth/oauth2/authorize"
    ) {
      const post = (ctx.method ?? ctx.request.method) === "POST";
      const query = (post ? ctx.body : ctx.query) as Record<string, unknown> | undefined;
      const resources = Array.isArray(query?.resource) ? query.resource : [query?.resource];
      if (resources.length !== 1 || resources[0] !== settings.resource) {
        throw new APIError("BAD_REQUEST", { error: "invalid_target" });
      }
      if (query?.code_challenge_method !== "S256" || !query.code_challenge) {
        throw new APIError("BAD_REQUEST", { error: "invalid_request" });
      }
      const prompts = new Set(
        String(query.prompt ?? "")
          .split(" ")
          .filter(Boolean),
      );
      if (prompts.has("none")) throw new APIError("BAD_REQUEST", { error: "consent_required" });
      // Every connection shows the consent page, even when an earlier consent exists.
      prompts.add("consent");
      const authorization = { ...query, prompt: [...prompts].join(" ") };
      return { context: post ? { body: authorization } : { query: authorization } };
    }

    if (ctx.path === "/oauth2/consent") {
      const session = await getSessionFromCtx(ctx as never);
      if (!session) throw new APIError("UNAUTHORIZED");
      const body = ctx.body ?? {};
      if (typeof body.oauth_query !== "string") invalidQuery();
      const details = await verifiedConsentQuery(env, settings, body.oauth_query, session.session.id, session.user.id);
      if (body.accept === true) {
        const scopes =
          body.scope === undefined
            ? details.scopes
            : typeof body.scope === "string"
              ? [...new Set(body.scope.split(" ").filter(Boolean))]
              : [];
        if (!scopes.length || scopes.some((scope) => !details.scopes.includes(scope))) {
          throw new APIError("BAD_REQUEST", { error: "invalid_scope" });
        }
        consentReference = (await consentGrant(db, details, session.user.id, scopes)).generation;
      }
      return { context: { body: { ...body, oauth_query: details.oauthQuery } } };
    }
    return;
  }

  return {
    provider,
    plugins: [provider, verifier],
    before,
    /** The verification endpoint is server-only: `auth.api` can call it, HTTP cannot. */
    disabledPaths: ["/agent/verify"],
  };
}
