import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { afterEach, beforeEach, test } from "node:test";
import { serializeSignedCookie } from "better-call";
import { DCR_LIMIT_PER_MINUTE } from "../src/agent-oauth";
import {
  type AgentPrincipal,
  handleAgentApi,
  handleOAuthDiscovery,
  listAgentGrants,
  requireScope,
  revokeAgentGrant,
  withAgentAuthorization,
} from "../src/agents";
import { createAuth } from "../src/auth";
import { resetPlatformConfig } from "../src/config";
import { HttpError } from "../src/http";
import type { PlatformEnv } from "../src/types";
import { d1FromSqlite } from "./support/d1";
import { createTestDb, type TestDb } from "./support/db";
import { configureTestPlatform } from "./support/platform";

const ORIGIN = "http://localhost:4321";
const SECRET = "0123456789abcdef0123456789abcdef";
const RESOURCE = `${ORIGIN}/mcp`;
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const SCOPES = ["images:read", "images:write", "offline_access"];
const CSRF = "c".repeat(64);

let testDb: TestDb;
let env: PlatformEnv;

function enableMcp() {
  configureTestPlatform({ mcp: { resourcePath: "/mcp", scopes: SCOPES, consentPath: "/connect/authorize" } });
}

beforeEach(() => {
  testDb = createTestDb({ modules: ["oauth"] });
  env = {
    DB: d1FromSqlite(testDb.raw),
    BETTER_AUTH_SECRET: SECRET,
    BETTER_AUTH_URL: ORIGIN,
    APP_ORIGIN: ORIGIN,
    EMAIL_PROVIDER: "console",
  };
  enableMcp();
});

afterEach(() => {
  testDb.close();
  resetPlatformConfig();
});

async function signedInUser(index = 1) {
  const now = new Date().toISOString();
  const user = { id: `usr_${index}`, email: `u${index}@example.com`, name: `User ${index}` };
  await testDb.db.run(
    'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
    [user.id, user.name, user.email, now, now],
  );
  const token = randomBytes(24).toString("hex");
  const sessionId = `ses_${index}`;
  await testDb.db.run(
    'INSERT INTO "session" (id, expiresAt, token, createdAt, updatedAt, userId) VALUES (?, ?, ?, ?, ?, ?)',
    [sessionId, new Date(Date.now() + 86_400_000).toISOString(), token, now, now, user.id],
  );
  const signed = await serializeSignedCookie("better-auth.session_token", token, SECRET);
  return { user, session: { id: sessionId }, cookie: signed.split(";")[0] as string };
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function authRequest(path: string, init: RequestInit = {}) {
  return createAuth(env).handler(new Request(`${ORIGIN}${path}`, init));
}

async function register(scope = SCOPES.join(" "), ip = "203.0.113.1") {
  return authRequest("/api/auth/oauth2/register", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: JSON.stringify({
      redirect_uris: [REDIRECT],
      client_name: "Claude",
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope,
    }),
  });
}

async function token(params: Record<string, string>) {
  return authRequest("/api/auth/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
}

async function agentApi(
  path: string,
  signedIn: Awaited<ReturnType<typeof signedInUser>>,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("cookie", `${signedIn.cookie}; td_csrf=${CSRF}`);
  headers.set("origin", ORIGIN);
  headers.set("x-csrf-token", CSRF);
  const response = await handleAgentApi(env, new Request(`${ORIGIN}${path}`, { ...init, headers }), signedIn);
  assert.ok(response, `${path} is an agents API path`);
  return response;
}

/** Registers a client and runs authorize → consent → code exchange for `scope`. */
async function connect(signedIn: Awaited<ReturnType<typeof signedInUser>>, scope = SCOPES.join(" ")) {
  const registration = await register();
  assert.equal(registration.status, 201);
  const client = (await registration.json()) as { client_id: string };
  const { verifier, challenge } = pkce();
  const authorize = new URL(`${ORIGIN}/api/auth/oauth2/authorize`);
  for (const [key, value] of Object.entries({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: REDIRECT,
    scope,
    state: "state-1",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: RESOURCE,
  })) {
    authorize.searchParams.set(key, value);
  }
  const redirect = await createAuth(env).handler(new Request(authorize, { headers: { cookie: signedIn.cookie } }));
  assert.equal(redirect.status, 302, await redirect.clone().text());
  const consentUrl = new URL(redirect.headers.get("location") ?? "", ORIGIN);
  assert.equal(consentUrl.pathname, "/connect/authorize");
  const oauthQuery = consentUrl.search.slice(1);

  const details = await agentApi(`/api/agents/consent?oauth_query=${encodeURIComponent(oauthQuery)}`, signedIn);
  assert.equal(details.status, 200, await details.clone().text());
  const consent = (await details.json()) as { clientId: string; name: string; scopes: string[] };
  assert.equal(consent.clientId, client.client_id);
  assert.equal(consent.name, "Claude");

  const accepted = await agentApi("/api/agents/consent", signedIn, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ oauthQuery, accept: true }),
  });
  assert.equal(accepted.status, 200, await accepted.clone().text());
  const callback = new URL(((await accepted.json()) as { redirectTo: string }).redirectTo);
  assert.equal(`${callback.origin}${callback.pathname}`, REDIRECT);
  assert.equal(callback.searchParams.get("state"), "state-1");
  const code = callback.searchParams.get("code");
  assert.ok(code);

  const exchanged = await token({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT,
    client_id: client.client_id,
    code_verifier: verifier,
    resource: RESOURCE,
  });
  assert.equal(exchanged.status, 200, await exchanged.clone().text());
  const tokens = (await exchanged.json()) as { access_token: string; refresh_token?: string; scope: string };
  return { clientId: client.client_id, tokens };
}

async function callMcp(accessToken: string | null) {
  let seen: AgentPrincipal | null = null;
  const headers: Record<string, string> = accessToken ? { authorization: `Bearer ${accessToken}` } : {};
  const response = await withAgentAuthorization(
    env,
    new Request(RESOURCE, { method: "POST", headers }),
    async (agent) => {
      seen = agent;
      return new Response("ok");
    },
  );
  return { response, agent: seen as AgentPrincipal | null };
}

test("a connected client registers, authorizes with PKCE, exchanges, refreshes and loses access on revoke", async () => {
  const signedIn = await signedInUser();
  const { clientId, tokens } = await connect(signedIn);
  assert.ok(tokens.refresh_token, "offline_access yields a refresh token");

  const first = await callMcp(tokens.access_token);
  assert.equal(first.response.status, 200);
  assert.equal(first.agent?.user.id, signedIn.user.id);
  assert.match(first.agent?.tenantId ?? "", /\S/);
  assert.deepEqual([...(first.agent?.scopes ?? [])].sort(), [...SCOPES].sort());

  const grants = await listAgentGrants(testDb.db, signedIn.user.id);
  assert.equal(grants.length, 1);
  assert.equal(grants[0]?.clientId, clientId);
  assert.equal(grants[0]?.name, "Claude");

  const refreshed = await token({
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
    client_id: clientId,
    resource: RESOURCE,
  });
  assert.equal(refreshed.status, 200, await refreshed.clone().text());
  const renewed = (await refreshed.json()) as { access_token: string; refresh_token: string };
  assert.notEqual(renewed.access_token, tokens.access_token);
  assert.equal((await callMcp(renewed.access_token)).response.status, 200);

  const list = await agentApi("/api/agents", signedIn);
  const listed = (await list.json()) as { mcpUrl: string; remoteReady: boolean; connections: unknown[] };
  assert.equal(listed.mcpUrl, RESOURCE);
  assert.equal(listed.remoteReady, false);
  assert.equal(listed.connections.length, 1);

  const revoked = await agentApi("/api/agents/revoke", signedIn, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: grants[0]?.id }),
  });
  assert.equal(revoked.status, 200);

  const denied = await callMcp(renewed.access_token);
  assert.equal(denied.response.status, 401);
  assert.equal(denied.agent, null);
  assert.match(
    denied.response.headers.get("www-authenticate") ?? "",
    /resource_metadata="http:\/\/localhost:4321\/\.well-known\/oauth-protected-resource\/mcp"/,
  );
  const body = (await denied.response.json()) as { jsonrpc: string; error: { code: number } };
  assert.equal(body.error.code, -32000);

  const replay = await token({
    grant_type: "refresh_token",
    refresh_token: renewed.refresh_token,
    client_id: clientId,
    resource: RESOURCE,
  });
  assert.equal(replay.status, 400);
  assert.deepEqual(await listAgentGrants(testDb.db, signedIn.user.id), []);
  assert.equal(await revokeAgentGrant(testDb.db, signedIn.user.id, grants[0]?.id ?? ""), false);
});

test("a narrower consent issues only the consented scopes", async () => {
  const signedIn = await signedInUser();
  const { tokens } = await connect(signedIn, "images:read");
  assert.equal(tokens.refresh_token, undefined);
  const { agent } = await callMcp(tokens.access_token);
  assert.deepEqual([...(agent?.scopes ?? [])], ["images:read"]);
  assert.throws(
    () => requireScope(agent?.scopes ?? new Set(), "images:write"),
    (error: unknown) => error instanceof HttpError && error.status === 403 && error.code === "forbidden",
  );
  requireScope(agent?.scopes ?? new Set(), "images:read");
});

test("the database refuses a token with scopes beyond the grant or for a stale generation", async () => {
  const signedIn = await signedInUser();
  await register();
  const client = await testDb.db.first<{ clientId: string }>("SELECT clientId FROM oauthClient");
  const now = new Date().toISOString();
  await testDb.db.run(
    `INSERT INTO agent_grants (id, user_id, client_id, generation, scopes, active, created_at, revoked_at)
     VALUES ('grant_1', ?, ?, 'gen_1', '["images:read"]', 1, ?, 0)`,
    [signedIn.user.id, client?.clientId, now],
  );
  const insert = (tokenValue: string, generation: string, scopes: string[]) =>
    testDb.db.run(
      `INSERT INTO oauthAccessToken (id, token, clientId, userId, referenceId, expiresAt, createdAt, scopes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [tokenValue, tokenValue, client?.clientId, signedIn.user.id, generation, now, now, JSON.stringify(scopes)],
    );
  await insert("t_ok", "gen_1", ["images:read"]);
  await assert.rejects(insert("t_wide", "gen_1", ["images:read", "images:write"]), /inactive_agent_grant/);
  await assert.rejects(insert("t_stale", "gen_0", ["images:read"]), /inactive_agent_grant/);
  await assert.rejects(
    testDb.db.run(
      `INSERT INTO oauthRefreshToken (id, token, clientId, userId, referenceId, expiresAt, createdAt, scopes)
       VALUES ('r_wide', 'r_wide', ?, ?, 'gen_1', ?, ?, '["images:write"]')`,
      [client?.clientId, signedIn.user.id, now, now],
    ),
    /inactive_agent_grant/,
  );
});

test("a missing or malformed bearer gets the MCP challenge", async () => {
  for (const value of [null, "not-a-token", "x".repeat(5000)]) {
    const { response, agent } = await callMcp(value);
    assert.equal(response.status, 401);
    assert.equal(agent, null);
    assert.match(response.headers.get("www-authenticate") ?? "", /^Bearer /);
  }
});

test("dynamic registration is rate limited per client address", async () => {
  for (let index = 0; index < DCR_LIMIT_PER_MINUTE; index += 1) {
    assert.equal((await register(undefined, "198.51.100.7")).status, 201);
  }
  const limited = await register(undefined, "198.51.100.7");
  assert.equal(limited.status, 429);
  assert.ok(limited.headers.get("retry-after"));
  assert.equal((await register(undefined, "198.51.100.8")).status, 201);
});

test("registration rejects client metadata the server does not support", async () => {
  const response = await authRequest("/api/auth/oauth2/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "private_key_jwt" }),
  });
  assert.equal(response.status, 400);
});

test("authorize requires this app's resource and PKCE S256", async () => {
  const signedIn = await signedInUser();
  const registration = (await (await register()).json()) as { client_id: string };
  const url = new URL(`${ORIGIN}/api/auth/oauth2/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", registration.client_id);
  url.searchParams.set("redirect_uri", REDIRECT);
  url.searchParams.set("scope", "images:read");
  url.searchParams.set("code_challenge", pkce().challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", "https://elsewhere.example/mcp");
  const send = () => createAuth(env).handler(new Request(url, { headers: { cookie: signedIn.cookie } }));
  const wrongResource = await send();
  assert.equal(wrongResource.status, 400);
  assert.deepEqual(await wrongResource.json(), { error: "invalid_target" });
  url.searchParams.set("resource", RESOURCE);
  url.searchParams.set("code_challenge_method", "plain");
  const plain = await send();
  assert.equal(plain.status, 400);
  assert.deepEqual(await plain.json(), { error: "invalid_request" });
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("prompt", "none");
  const silent = await send();
  assert.equal(silent.status, 400);
  assert.deepEqual(await silent.json(), { error: "consent_required" });
});

test("a signed-out user is sent to the consent page, which then needs a session-bound request", async () => {
  const signedIn = await signedInUser();
  const registration = (await (await register()).json()) as { client_id: string };
  const url = new URL(`${ORIGIN}/api/auth/oauth2/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", registration.client_id);
  url.searchParams.set("redirect_uri", REDIRECT);
  url.searchParams.set("scope", "images:read");
  url.searchParams.set("code_challenge", pkce().challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", RESOURCE);
  const redirect = await createAuth(env).handler(new Request(url));
  assert.equal(redirect.status, 302);
  const location = new URL(redirect.headers.get("location") ?? "", ORIGIN);
  assert.equal(location.pathname, "/connect/authorize");
  assert.equal(location.searchParams.get("ba_pl"), null);
  const details = await agentApi(
    `/api/agents/consent?oauth_query=${encodeURIComponent(location.search.slice(1))}`,
    signedIn,
  );
  assert.equal(details.status, 400);
});

test("declining consent returns access_denied to the client and creates no grant", async () => {
  const signedIn = await signedInUser();
  const registration = (await (await register()).json()) as { client_id: string };
  const url = new URL(`${ORIGIN}/api/auth/oauth2/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", registration.client_id);
  url.searchParams.set("redirect_uri", REDIRECT);
  url.searchParams.set("scope", "images:read");
  url.searchParams.set("state", "s");
  url.searchParams.set("code_challenge", pkce().challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", RESOURCE);
  const redirect = await createAuth(env).handler(new Request(url, { headers: { cookie: signedIn.cookie } }));
  const oauthQuery = new URL(redirect.headers.get("location") ?? "", ORIGIN).search.slice(1);

  const widened = await agentApi("/api/agents/consent", signedIn, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ oauthQuery, accept: true, scope: "images:read images:write" }),
  });
  assert.equal(widened.status, 400);

  const declined = await agentApi("/api/agents/consent", signedIn, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ oauthQuery, accept: false }),
  });
  assert.equal(declined.status, 200);
  const callback = new URL(((await declined.json()) as { redirectTo: string }).redirectTo);
  assert.equal(callback.searchParams.get("error"), "access_denied");
  assert.equal(callback.searchParams.get("code"), null);
  assert.deepEqual(await listAgentGrants(testDb.db, signedIn.user.id), []);
});

test("the token verification endpoint is not reachable over HTTP", async () => {
  const response = await authRequest("/api/auth/agent/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "anything" }),
  });
  assert.equal(response.status, 404);
});

test("discovery serves protected-resource and authorization-server metadata", async () => {
  const resource = await handleOAuthDiscovery(env, new Request(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`));
  assert.equal(resource?.status, 200);
  const resourceBody = (await resource?.json()) as { resource: string; authorization_servers: string[] };
  assert.equal(resourceBody.resource, RESOURCE);
  assert.deepEqual(resourceBody.authorization_servers, [`${ORIGIN}/api/auth`]);

  for (const path of ["/.well-known/oauth-authorization-server/api/auth", "/.well-known/oauth-authorization-server"]) {
    const metadata = await handleOAuthDiscovery(env, new Request(`${ORIGIN}${path}`));
    assert.equal(metadata?.status, 200, path);
    const body = (await metadata?.json()) as Record<string, unknown>;
    assert.equal(body.issuer, `${ORIGIN}/api/auth`);
    assert.equal(body.registration_endpoint, `${ORIGIN}/api/auth/oauth2/register`);
    assert.equal(body.authorization_endpoint, `${ORIGIN}/api/auth/oauth2/authorize`);
    assert.equal(body.token_endpoint, `${ORIGIN}/api/auth/oauth2/token`);
    assert.deepEqual(body.code_challenge_methods_supported, ["S256"]);
  }
  assert.equal(await handleOAuthDiscovery(env, new Request(`${ORIGIN}/.well-known/security.txt`)), null);
  const post = await handleOAuthDiscovery(
    env,
    new Request(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`, { method: "POST" }),
  );
  assert.equal(post?.status, 405);
});

test("the agents API needs a session and the CSRF token", async () => {
  const signedIn = await signedInUser();
  const anonymous = await handleAgentApi(env, new Request(`${ORIGIN}/api/agents`), null);
  assert.equal(anonymous?.status, 401);
  const forged = await handleAgentApi(
    env,
    new Request(`${ORIGIN}/api/agents/revoke`, {
      method: "POST",
      headers: { origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ id: "grant_x" }),
    }),
    signedIn,
  );
  assert.equal(forged?.status, 403);
  const missing = await agentApi("/api/agents/revoke", signedIn, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "grant_x" }),
  });
  assert.equal(missing.status, 404);
  assert.equal(await handleAgentApi(env, new Request(`${ORIGIN}/api/other`), signedIn), null);
});

test("another user cannot revoke or list a connection", async () => {
  const owner = await signedInUser(1);
  const other = await signedInUser(2);
  await connect(owner);
  const [grant] = await listAgentGrants(testDb.db, owner.user.id);
  assert.deepEqual(await listAgentGrants(testDb.db, other.user.id), []);
  assert.equal(await revokeAgentGrant(testDb.db, other.user.id, grant?.id ?? ""), false);
  assert.equal((await listAgentGrants(testDb.db, owner.user.id)).length, 1);
});

test("without the mcp option the OAuth endpoints do not exist", async () => {
  resetPlatformConfig();
  configureTestPlatform();
  const registration = await register();
  assert.equal(registration.status, 404);
  const metadata = await authRequest("/.well-known/oauth-protected-resource/mcp");
  assert.equal(metadata.status, 404);
  await assert.rejects(handleOAuthDiscovery(env, new Request(`${ORIGIN}/.well-known/oauth-protected-resource`)));
});

test("an invalid mcp config fails when auth is created", () => {
  configureTestPlatform({ mcp: { resourcePath: "mcp", scopes: SCOPES, consentPath: "/connect/authorize" } });
  assert.throws(() => createAuth(env), /resourcePath/);
  configureTestPlatform({ mcp: { resourcePath: "/mcp", scopes: [], consentPath: "/connect/authorize" } });
  assert.throws(() => createAuth(env), /scopes/);
});
