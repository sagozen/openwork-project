import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createAuth } from "@templatedesign/platform/auth";
import { serializeSignedCookie } from "better-call";
import "../../src/lib/platform";
import type { Env } from "../../src/lib/types";
import { d1FromSqlite } from "./d1";
import { createTestDb } from "./db";

export const ORIGIN = "https://myartifacts.zhst.app";
export const SECRET = "0123456789abcdef0123456789abcdef";
export const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
export const CSRF = "c".repeat(64);
export const OWNER_EMAIL = "owner@example.com";
export const SCOPE = "artifacts:read artifacts:write offline_access";

/** A fresh in-memory database, an env that is in owner-only mode, and helpers to add signed-in users. */
export function setup(ownerEmails: string | undefined = OWNER_EMAIL) {
  const database = createTestDb();
  const env = {
    DB: d1FromSqlite(database.raw),
    BETTER_AUTH_SECRET: SECRET,
    BETTER_AUTH_URL: ORIGIN,
    APP_ORIGIN: ORIGIN,
    EMAIL_PROVIDER: "console",
    ...(ownerEmails === undefined ? {} : { OWNER_EMAILS: ownerEmails }),
  } as unknown as Env;

  /** Inserts a user and a live session for it, and returns the session cookie. */
  const signIn = async (id: string, email: string) => {
    const now = new Date().toISOString();
    await database.db.run(
      'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
      [id, "Pat", email, now, now],
    );
    const token = randomBytes(24).toString("hex");
    await database.db.run(
      'INSERT INTO "session" (id, expiresAt, token, createdAt, updatedAt, userId) VALUES (?, ?, ?, ?, ?, ?)',
      [`ses_${id}`, new Date(Date.now() + 86_400_000).toISOString(), token, now, now, id],
    );
    const cookie = (await serializeSignedCookie("__Secure-better-auth.session_token", token, SECRET)).split(
      ";",
    )[0] as string;
    return { id, email, cookie, sessionId: `ses_${id}` };
  };

  return { ...database, env, signIn };
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

/** Registers a client the way Claude does and builds its authorize URL. */
export async function startConnect(env: Env) {
  const auth = createAuth(env);
  const registration = await auth.handler(
    new Request(`${ORIGIN}/api/auth/oauth2/register`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.5" },
      body: JSON.stringify({
        redirect_uris: [REDIRECT],
        client_name: "Claude",
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        scope: SCOPE,
      }),
    }),
  );
  assert.equal(registration.status, 201);
  const client = (await registration.json()) as { client_id: string };
  const { verifier, challenge } = pkce();
  const authorize = new URL(`${ORIGIN}/api/auth/oauth2/authorize`);
  const params = {
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: REDIRECT,
    scope: SCOPE,
    state: "s1",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${ORIGIN}/mcp`,
  };
  for (const [key, value] of Object.entries(params)) authorize.searchParams.set(key, value);
  return { auth, client, verifier, authorize };
}

/** Signs in (restart with the session cookie) and returns the consent query the page would use. */
export async function bindToSession(flow: Awaited<ReturnType<typeof startConnect>>, cookie: string) {
  const signedOut = await flow.auth.handler(new Request(flow.authorize));
  assert.equal(signedOut.status, 302);
  const loginUrl = new URL(signedOut.headers.get("location") ?? "", ORIGIN);
  assert.equal(loginUrl.pathname, "/connect/authorize");
  const restarted = await flow.auth.handler(
    new Request(`${ORIGIN}/api/auth/oauth2/authorize?${loginUrl.search.slice(1)}`, { headers: { cookie } }),
  );
  assert.equal(restarted.status, 302);
  const consentUrl = new URL(restarted.headers.get("location") ?? "", ORIGIN);
  assert.equal(consentUrl.searchParams.has("ba_pl"), true, "the restarted request is bound to the session");
  return consentUrl.search.slice(1);
}

/** Exchanges an authorization code for tokens. */
export async function exchange(flow: Awaited<ReturnType<typeof startConnect>>, code: string) {
  const response = await flow.auth.handler(
    new Request(`${ORIGIN}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT,
        client_id: flow.client.client_id,
        code_verifier: flow.verifier,
        resource: `${ORIGIN}/mcp`,
      }).toString(),
    }),
  );
  assert.equal(response.status, 200);
  return (await response.json()) as { access_token: string };
}

/** Reads a JSON-RPC reply that may arrive as plain JSON or as one server-sent event. */
export async function rpcBody(response: Response) {
  const raw = await response.text();
  const data =
    raw.includes("\ndata:") || raw.startsWith("event:")
      ? (raw.split("\n").find((line) => line.startsWith("data:")) ?? "").slice(5)
      : raw;
  return JSON.parse(data) as { result?: Record<string, unknown>; error?: { message: string } };
}

export function mcpRequest(token: string, method: string, params: Record<string, unknown> = {}) {
  return new Request(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}
