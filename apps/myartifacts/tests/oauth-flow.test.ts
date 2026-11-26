import assert from "node:assert/strict";
import { test } from "node:test";
import { handleOAuthDiscovery } from "@templatedesign/platform/agents";
import { d1Db } from "@templatedesign/platform/db";
import { DEFAULT_SETTINGS } from "../src/lib/artifacts/settings";
import { handleOwnerAgentApi } from "../src/lib/auth/agent-api";
import { withCaller } from "../src/lib/auth/caller";
import { setServiceFactory } from "../src/lib/mcp/context";
import { handleMcp } from "../src/lib/mcp/server";
import { fakeStorage } from "./support/artifacts";
import {
  bindToSession,
  CSRF,
  exchange,
  mcpRequest,
  ORIGIN,
  OWNER_EMAIL,
  REDIRECT,
  rpcBody,
  setup,
  startConnect,
} from "./support/auth";

test("connecting Claude as the owner: consent, token, MCP call, then revoke ends access", async () => {
  const { env, signIn, close } = setup();
  try {
    const owner = await signIn("usr_owner", OWNER_EMAIL);
    const flow = await startConnect(env);
    const oauthQuery = await bindToSession(flow, owner.cookie);

    const agentApi = (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      headers.set("cookie", `${owner.cookie}; td_csrf=${CSRF}`);
      headers.set("origin", ORIGIN);
      headers.set("x-csrf-token", CSRF);
      return handleOwnerAgentApi(env, new Request(`${ORIGIN}${path}`, { ...init, headers }), {
        user: { id: owner.id, email: owner.email, name: "Pat" },
        session: { id: owner.sessionId },
      });
    };

    const details = await agentApi(`/api/agents/consent?oauth_query=${encodeURIComponent(oauthQuery)}`);
    assert.equal(details.status, 200);
    const consent = (await details.json()) as { name: string; scopes: string[] };
    assert.equal(consent.name, "Claude");
    assert.ok(consent.scopes.includes("artifacts:write"));

    const accepted = await agentApi("/api/agents/consent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ oauthQuery, accept: true }),
    });
    assert.equal(accepted.status, 200);
    const callback = new URL(((await accepted.json()) as { redirectTo: string }).redirectTo);
    assert.equal(callback.origin + callback.pathname, REDIRECT);

    const { access_token } = await exchange(flow, callback.searchParams.get("code") ?? "");
    // The connector's requests reach the tools with the account the token belongs to.
    const store = fakeStorage();
    const database = d1Db(env.DB);
    setServiceFactory(async () => ({
      env,
      artifacts: { db: database, storage: store.storage, settings: DEFAULT_SETTINGS },
      shares: { db: database, storage: store.storage, origin: ORIGIN, storageOrigin: "https://s3.test", secret: "s" },
    }));
    const mcp = (method: string, params: Record<string, unknown> = {}) => {
      const request = mcpRequest(access_token, method, params);
      return withCaller(env, request, (caller) => handleMcp(request, caller, ORIGIN));
    };

    const initialized = await mcp("initialize");
    assert.equal(initialized.status, 200);
    const listed = await mcp("tools/list");
    assert.equal(listed.status, 200);
    const listedTools = ((await rpcBody(listed)).result?.tools ?? []) as Array<{ name: string }>;
    const tools = listedTools.map((tool) => tool.name);
    assert.equal(tools.length, 16);
    assert.ok(tools.includes("put_file") && tools.includes("create_share"), "write access was granted");

    const saved = await mcp("tools/call", {
      name: "put_file",
      arguments: { name: "from-claude.txt", content: "hello" },
    });
    const file = (await rpcBody(saved)).result?.structuredContent as { file: { id: string; name: string } };
    assert.equal(file.file.name, "from-claude.txt");
    const row = await database.first<{ tenant_id: string }>("SELECT tenant_id FROM artifacts WHERE id = ?", [
      file.file.id,
    ]);
    const profile = await database.first<{ tenant_id: string }>("SELECT tenant_id FROM profiles WHERE user_id = ?", [
      owner.id,
    ]);
    assert.equal(row?.tenant_id, profile?.tenant_id, "the file belongs to the signed-in account");
    const listedFiles = await mcp("tools/call", { name: "list_files", arguments: {} });
    const filesReply = (await rpcBody(listedFiles)).result?.structuredContent as { items: unknown[] };
    assert.equal(filesReply.items.length, 1);

    // Revoking the connection makes the next call a 401 that restarts the connector sign-in.
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

test("the MCP endpoint refuses a request with no token and points at the discovery document", async () => {
  const { env, close } = setup();
  try {
    const request = new Request(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const response = await withCaller(env, request, (caller) => handleMcp(request, caller, ORIGIN));
    assert.equal(response.status, 401);
    assert.match(response.headers.get("www-authenticate") ?? "", /resource_metadata=/);
  } finally {
    close();
  }
});

test("discovery documents point clients at this origin and advertise the artifact scopes", async () => {
  const { env, close } = setup();
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
    assert.ok(metadata.scopes_supported.includes("artifacts:read"));
    assert.ok(metadata.scopes_supported.includes("artifacts:write"));

    const server = await handleOAuthDiscovery(env, new Request(`${ORIGIN}/.well-known/oauth-authorization-server`));
    const issuer = (await server?.json()) as { issuer: string; registration_endpoint: string };
    assert.equal(issuer.issuer, `${ORIGIN}/api/auth`);
    assert.equal(issuer.registration_endpoint, `${ORIGIN}/api/auth/oauth2/register`);
  } finally {
    close();
  }
});
