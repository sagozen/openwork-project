import assert from "node:assert/strict";
import { test } from "node:test";
import { createAuth, getSessionContext } from "@templatedesign/platform/auth";
import { d1Db } from "@templatedesign/platform/db";
import { createApiKey } from "@templatedesign/platform/keys";
import { handleOwnerAgentApi, refuseNonOwnerConsent } from "../src/lib/auth/agent-api";
import { looksLikeApiKey, withCaller } from "../src/lib/auth/caller";
import { isOwner } from "../src/lib/auth/owner";
import type { Env } from "../src/lib/types";
import { bindToSession, CSRF, exchange, mcpRequest, ORIGIN, OWNER_EMAIL, setup, startConnect } from "./support/auth";

const OTHER_EMAIL = "stranger@example.com";

test("only an address on OWNER_EMAILS is the owner, and a missing or empty list admits nobody", () => {
  const env = { OWNER_EMAILS: " Owner@Example.com , second@example.com " };
  assert.equal(isOwner("owner@example.com", env), true);
  assert.equal(isOwner("SECOND@example.com", env), true);
  assert.equal(isOwner(OTHER_EMAIL, env), false);
  assert.equal(isOwner(OWNER_EMAIL, { OWNER_EMAILS: "" }), false);
  assert.equal(isOwner(OWNER_EMAIL, {}), false);
  assert.equal(isOwner(undefined, env), false);
  assert.equal(isOwner(null, env), false);
});

test("sign-in by email link is refused for any address that is not the owner", async () => {
  const { env, db, close } = setup();
  try {
    const request = (email: string) =>
      new Request(`${ORIGIN}/api/auth/sign-in/magic-link`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN, "cf-connecting-ip": "203.0.113.9" },
        body: JSON.stringify({ email, callbackURL: "/" }),
      });
    const auth = createAuth(env);
    const refused = await auth.handler(request(OTHER_EMAIL));
    assert.equal(refused.status, 403);
    assert.match(JSON.stringify(await refused.json()), /not allowed to sign in/);
    assert.equal((await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM verification"))?.n, 0);

    const accepted = await auth.handler(request(OWNER_EMAIL));
    assert.equal(accepted.status, 200);
    assert.equal((await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM verification"))?.n, 1);
  } finally {
    close();
  }
});

test("an account cannot be created for any address that is not the owner (the Google path)", async () => {
  const { env, db, close } = setup();
  try {
    const context = await createAuth(env).$context;
    await assert.rejects(
      () =>
        context.internalAdapter.createUser(
          { email: OTHER_EMAIL, name: "Stranger", emailVerified: true },
          { method: "social" },
        ),
      /not allowed to sign in/,
    );
    const created = await context.internalAdapter.createUser(
      { email: OWNER_EMAIL, name: "Owner", emailVerified: true },
      { method: "social" },
    );
    assert.equal(created.email, OWNER_EMAIL);
    const users = await db.all<{ email: string }>('SELECT email FROM "user"');
    assert.deepEqual(
      users.map((row) => row.email),
      [OWNER_EMAIL],
    );
  } finally {
    close();
  }
});

test("a signed-in address that is not the owner cannot reach the connector consent decision", async () => {
  // A session for a non-owner can only exist if the list was narrowed after sign-in; it must still be refused.
  const { env, signIn, close } = setup();
  try {
    const stranger = await signIn("usr_stranger", OTHER_EMAIL);
    const owner = await signIn("usr_owner", OWNER_EMAIL);

    const consent = (cookie: string) =>
      new Request(`${ORIGIN}/api/auth/oauth2/consent`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ accept: true, oauth_query: "x" }),
      });
    assert.equal((await refuseNonOwnerConsent(env, consent(stranger.cookie)))?.status, 403);
    assert.equal(await refuseNonOwnerConsent(env, consent(owner.cookie)), null, "the owner proceeds to Better Auth");
    assert.equal(await refuseNonOwnerConsent(env, consent("")), null, "no session is left to Better Auth to reject");
    const other = new Request(`${ORIGIN}/api/auth/get-session`, { headers: { cookie: stranger.cookie } });
    assert.equal(await refuseNonOwnerConsent(env, other), null, "only the consent endpoint is guarded");

    // The page-facing agent API: the middleware marks the session, and the handler refuses before the platform runs.
    const agentRequest = new Request(`${ORIGIN}/api/agents/consent`, {
      method: "POST",
      headers: { cookie: stranger.cookie, origin: ORIGIN, "x-csrf-token": CSRF, "content-type": "application/json" },
      body: JSON.stringify({ oauthQuery: "x", accept: true }),
    });
    const nonOwner = await handleOwnerAgentApi(env, agentRequest, { nonOwner: true });
    assert.equal(nonOwner.status, 403);
    const anonymous = await handleOwnerAgentApi(env, agentRequest, {});
    assert.equal(anonymous.status, 401);
  } finally {
    close();
  }
});

test("an API key and a connector token stop working when their user leaves the owner list", async () => {
  const { env, signIn, close } = setup();
  try {
    const owner = await signIn("usr_owner", OWNER_EMAIL);
    const session = await getSessionContext(
      createAuth(env),
      env,
      new Request(`${ORIGIN}/`, { headers: { cookie: owner.cookie } }),
    );
    assert.ok(session);
    const { key } = await createApiKey(
      env,
      d1Db(env.DB),
      { user: session.user, tenantId: session.tenantId, profile: session.profile },
      {
        name: "n8n",
      },
    );
    assert.equal(looksLikeApiKey(key), true);
    assert.match(key, /^ma_live_/);

    const flow = await startConnect(env);
    const oauthQuery = await bindToSession(flow, owner.cookie);
    const consent = await handleOwnerAgentApi(
      env,
      new Request(`${ORIGIN}/api/agents/consent`, {
        method: "POST",
        headers: {
          cookie: `${owner.cookie}; td_csrf=${CSRF}`,
          origin: ORIGIN,
          "x-csrf-token": CSRF,
          "content-type": "application/json",
        },
        body: JSON.stringify({ oauthQuery, accept: true }),
      }),
      { user: { id: owner.id, email: owner.email, name: "Pat" }, session: { id: owner.sessionId } },
    );
    const callback = new URL(((await consent.json()) as { redirectTo: string }).redirectTo);
    const { access_token } = await exchange(flow, callback.searchParams.get("code") ?? "");

    const call = async (target: Env, token: string) => {
      let reached: { tenantId: string; via: string } | null = null;
      const response = await withCaller(target, mcpRequest(token, "tools/list"), async (caller) => {
        reached = { tenantId: caller.tenantId, via: caller.via };
        return new Response("ok");
      });
      return { status: response.status, reached };
    };

    for (const [token, via] of [
      [key, "api_key"],
      [access_token, "oauth"],
    ] as const) {
      const allowed = await call(env, token);
      assert.equal(allowed.status, 200, via);
      assert.deepEqual(allowed.reached, { tenantId: session.tenantId, via });

      const narrowed = await call({ ...env, OWNER_EMAILS: "someone-else@example.com" }, token);
      assert.equal(narrowed.status, 403, via);
      assert.equal(narrowed.reached, null, `${via} never reaches the handler`);

      const closed = await call({ ...env, OWNER_EMAILS: undefined }, token);
      assert.equal(closed.status, 403, `${via} with OWNER_EMAILS unset fails closed`);
    }

    const forged = await call(env, "ma_live_not_a_real_key_00000000000000000000");
    assert.equal(forged.status, 401);
  } finally {
    close();
  }
});
