import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import { handleAgentApi, handleOAuthDiscovery } from "@templatedesign/platform/agents";
import { createAuth } from "@templatedesign/platform/auth";
import { serializeSignedCookie } from "better-call";
import { withCaller } from "../src/lib/auth/caller";
import type { JobContext } from "../src/lib/images/jobs";
import type { ServiceDeps } from "../src/lib/images/service";
import { DEFAULT_SETTINGS } from "../src/lib/images/settings";
import { setServiceFactory } from "../src/lib/mcp/context";
import { handleMcp } from "../src/lib/mcp/server";
import "../src/lib/platform";
import type { Env } from "../src/lib/types";
import { d1FromSqlite } from "./support/d1";
import { createTestDb } from "./support/db";
import { FakeBucket, FakeProvider, fakeImageFetch } from "./support/fakes";

const ORIGIN = "https://imagefactory.zhst.app";
const SECRET = "0123456789abcdef0123456789abcdef";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const CSRF = "c".repeat(64);

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

async function setup() {
  const test_ = createTestDb();
  const env = {
    DB: d1FromSqlite(test_.raw),
    BETTER_AUTH_SECRET: SECRET,
    BETTER_AUTH_URL: ORIGIN,
    APP_ORIGIN: ORIGIN,
    EMAIL_PROVIDER: "console",
  } as unknown as Env;

  const now = new Date().toISOString();
  await test_.db.run(
    'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
    ["usr_1", "Pat", "pat@example.com", now, now],
  );
  const sessionToken = randomBytes(24).toString("hex");
  await test_.db.run(
    'INSERT INTO "session" (id, expiresAt, token, createdAt, updatedAt, userId) VALUES (?, ?, ?, ?, ?, ?)',
    ["ses_1", new Date(Date.now() + 86_400_000).toISOString(), sessionToken, now, now, "usr_1"],
  );
  const cookie = (await serializeSignedCookie("__Secure-better-auth.session_token", sessionToken, SECRET)).split(
    ";",
  )[0] as string;

  const bucket = new FakeBucket();
  const provider = new FakeProvider({
    status: { state: "done" },
    result: {
      seed: 1,
      images: [{ url: "https://fal.test/o.png", width: 816, height: 1224, contentType: "image/png", blocked: false }],
    },
  });
  const job: JobContext = {
    db: test_.db,
    images: bucket.asBucket(),
    provider,
    publicBase: `${ORIGIN}/i`,
    webhookUrl: `${ORIGIN}/api/v1/fal-webhook`,
    fetchImage: fakeImageFetch,
    sleep: async () => undefined,
  };
  const deps: ServiceDeps = { job, settings: DEFAULT_SETTINGS, origin: ORIGIN, secret: SECRET };
  setServiceFactory(async () => deps);
  return { ...test_, env, cookie };
}

/** Connects a client the way Claude does and returns its tokens. */
async function connect(env: Env, cookie: string | null) {
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
        scope: "images:read images:write offline_access",
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
    scope: "images:read images:write offline_access",
    state: "s1",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${ORIGIN}/mcp`,
  };
  for (const [key, value] of Object.entries(params)) authorize.searchParams.set(key, value);
  return { auth, client, verifier, authorize, cookie };
}

test("connecting Claude: sign-in restart, consent, token, tool call, then revoke ends access", async () => {
  const { env, cookie, db, close } = await setup();
  try {
    const flow = await connect(env, null);

    // Signed out: the provider sends the client to our consent page, which asks for sign-in.
    const signedOut = await flow.auth.handler(new Request(flow.authorize));
    assert.equal(signedOut.status, 302);
    const loginUrl = new URL(signedOut.headers.get("location") ?? "", ORIGIN);
    assert.equal(loginUrl.pathname, "/connect/authorize");
    assert.equal(loginUrl.searchParams.has("ba_pl"), false);

    // After sign-in the page restarts authorization with the same query and lands on a session-bound request.
    const restarted = await flow.auth.handler(
      new Request(`${ORIGIN}/api/auth/oauth2/authorize?${loginUrl.search.slice(1)}`, { headers: { cookie } }),
    );
    assert.equal(restarted.status, 302);
    const consentUrl = new URL(restarted.headers.get("location") ?? "", ORIGIN);
    assert.equal(consentUrl.pathname, "/connect/authorize");
    assert.equal(consentUrl.searchParams.has("ba_pl"), true, "the restarted request is bound to the session");
    assert.equal(consentUrl.searchParams.get("redirect_uri"), REDIRECT);

    const session = { user: { id: "usr_1", email: "pat@example.com", name: "Pat" }, session: { id: "ses_1" } };
    const agentApi = (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      headers.set("cookie", `${cookie}; td_csrf=${CSRF}`);
      headers.set("origin", ORIGIN);
      headers.set("x-csrf-token", CSRF);
      return handleAgentApi(env, new Request(`${ORIGIN}${path}`, { ...init, headers }), session) as Promise<Response>;
    };

    const oauthQuery = consentUrl.search.slice(1);
    const details = await agentApi(`/api/agents/consent?oauth_query=${encodeURIComponent(oauthQuery)}`);
    assert.equal(details.status, 200);
    assert.equal(((await details.json()) as { name: string }).name, "Claude");

    const accepted = await agentApi("/api/agents/consent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ oauthQuery, accept: true }),
    });
    assert.equal(accepted.status, 200);
    const callback = new URL(((await accepted.json()) as { redirectTo: string }).redirectTo);
    assert.equal(callback.origin + callback.pathname, REDIRECT);

    const exchanged = await flow.auth.handler(
      new Request(`${ORIGIN}/api/auth/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: callback.searchParams.get("code") ?? "",
          redirect_uri: REDIRECT,
          client_id: flow.client.client_id,
          code_verifier: flow.verifier,
          resource: `${ORIGIN}/mcp`,
        }).toString(),
      }),
    );
    assert.equal(exchanged.status, 200);
    const { access_token } = (await exchanged.json()) as { access_token: string };

    // The connector's first request: tools are listed and generate_image works for this account.
    const mcp = (method: string, params: Record<string, unknown> = {}, token = access_token) =>
      withCaller(
        env,
        new Request(`${ORIGIN}/mcp`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        }),
        (caller) =>
          handleMcp(
            new Request(`${ORIGIN}/mcp`, {
              method: "POST",
              headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
              body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
            }),
            caller,
            ORIGIN,
          ),
      );
    const text = async (response: Response) => {
      const raw = await response.text();
      return raw.includes("\ndata:") || raw.startsWith("event:")
        ? (raw.split("\n").find((l) => l.startsWith("data:")) ?? "").slice(5)
        : raw;
    };

    const listed = await mcp("tools/list");
    assert.equal(listed.status, 200);
    assert.ok(JSON.parse(await text(listed)).result.tools.length >= 16);

    const generated = await mcp("tools/call", {
      name: "generate_image",
      arguments: { prompt: "A bird", preset: "pin" },
    });
    const body = JSON.parse(await text(generated));
    assert.match(body.result.content[0].text, /https:\/\/imagefactory\.zhst\.app\/i\/[a-z2-7]{26}\.png/);
    const owner = await db.first<{ tenant_id: string }>("SELECT tenant_id FROM image_jobs");
    const profile = await db.first<{ tenant_id: string }>("SELECT tenant_id FROM profiles WHERE user_id = 'usr_1'");
    assert.equal(owner?.tenant_id, profile?.tenant_id, "the job belongs to the signed-in account");

    // Revoking the connection (the account page does exactly this) makes the next call a 401 that restarts sign-in.
    const grants = (await (await agentApi("/api/agents")).json()) as { connections: Array<{ id: string }> };
    assert.equal(grants.connections.length, 1);
    const revoked = await agentApi("/api/agents/revoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: grants.connections[0].id }),
    });
    assert.equal(revoked.status, 200);
    const after = await mcp("tools/list");
    assert.equal(after.status, 401);
    assert.match(after.headers.get("www-authenticate") ?? "", /resource_metadata=/);
  } finally {
    close();
  }
});

test("discovery documents point clients at this origin", async () => {
  const { env, close } = await setup();
  try {
    const resource = await handleOAuthDiscovery(env, new Request(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`));
    assert.equal(resource?.status, 200);
    const metadata = (await resource?.json()) as {
      resource: string;
      authorization_servers: string[];
      scopes_supported: string[];
    };
    assert.equal(metadata.resource, `${ORIGIN}/mcp`);
    assert.deepEqual(metadata.authorization_servers, [`${ORIGIN}/api/auth`]);
    assert.ok(metadata.scopes_supported.includes("images:write"));

    const server = await handleOAuthDiscovery(env, new Request(`${ORIGIN}/.well-known/oauth-authorization-server`));
    const issuer = (await server?.json()) as {
      issuer: string;
      registration_endpoint: string;
      code_challenge_methods_supported: string[];
    };
    assert.equal(issuer.issuer, `${ORIGIN}/api/auth`);
    assert.equal(issuer.registration_endpoint, `${ORIGIN}/api/auth/oauth2/register`);
    assert.deepEqual(issuer.code_challenge_methods_supported, ["S256"]);
  } finally {
    close();
  }
});
