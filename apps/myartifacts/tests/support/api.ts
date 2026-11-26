import { randomBytes } from "node:crypto";
import { createAuth, getSessionContext } from "@templatedesign/platform/auth";
import { d1Db } from "@templatedesign/platform/db";
import { createApiKey } from "@templatedesign/platform/keys";
import { serializeSignedCookie } from "better-call";
import type { Caller } from "../../src/lib/auth/caller";
import { type ServiceContext, setServiceFactory } from "../../src/lib/mcp/context";
import { handleMcp } from "../../src/lib/mcp/server";
import type { Env } from "../../src/lib/types";
import { ORIGIN, setupArtifacts } from "./artifacts";
import { d1FromSqlite } from "./d1";

export const AUTH_SECRET = "0123456789abcdef0123456789abcdef";
export const OWNER_A = "owner-a@example.com";
export const OWNER_B = "owner-b@example.com";

/**
 * The artifact test setup plus a Worker-like env, a service context the MCP and REST layers read
 * through their test seam, and a way to create signed-in accounts with a working API key.
 */
export async function setupApi() {
  const base = await setupArtifacts();
  const env = {
    DB: d1FromSqlite(base.raw),
    BETTER_AUTH_SECRET: AUTH_SECRET,
    BETTER_AUTH_URL: ORIGIN,
    APP_ORIGIN: ORIGIN,
    EMAIL_PROVIDER: "console",
    OWNER_EMAILS: `${OWNER_A}, ${OWNER_B}`,
    ADMIN_EMAILS: OWNER_A,
    S3_ENDPOINT: "https://s3.test",
    S3_REGION: "usc1",
    S3_BUCKET: "myartifact",
    S3_ACCESS_KEY_ID: "AKTEST",
    S3_SECRET_ACCESS_KEY: "SKTEST",
  } as unknown as Env;
  const services: ServiceContext = { env, artifacts: base.deps, shares: base.shareDeps };
  setServiceFactory(async () => services);

  /** A real user with a tenant, and an API key for it. */
  const account = async (id: string, email: string, scopes: string[] = ["artifacts:read", "artifacts:write"]) => {
    const now = new Date().toISOString();
    await base.db.run(
      'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
      [id, "Pat", email, now, now],
    );
    const token = randomBytes(24).toString("hex");
    await base.db.run(
      'INSERT INTO "session" (id, expiresAt, token, createdAt, updatedAt, userId) VALUES (?, ?, ?, ?, ?, ?)',
      [`ses_${id}`, new Date(Date.now() + 86_400_000).toISOString(), token, now, now, id],
    );
    const cookie = (await serializeSignedCookie("__Secure-better-auth.session_token", token, AUTH_SECRET)).split(
      ";",
    )[0];
    const session = await getSessionContext(createAuth(env), env, new Request(ORIGIN, { headers: { cookie } }));
    if (!session) throw new Error("test session did not resolve");
    const { key } = await createApiKey(
      env,
      d1Db(env.DB),
      { user: session.user, tenantId: session.tenantId, profile: session.profile },
      { name: "test", scopes },
    );
    const caller: Caller = {
      tenantId: session.tenantId,
      userId: id,
      scopes,
      via: "api_key",
    };
    return { id, email, tenantId: session.tenantId, key, caller };
  };

  return { ...base, env, services, account };
}

export type Api = Awaited<ReturnType<typeof setupApi>>;

export interface RpcResult {
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/** One MCP request as `caller`. Replies that arrive as an event stream are unwrapped. */
export async function rpc(
  caller: Caller,
  method: string,
  params: Record<string, unknown> = {},
  origin: string = ORIGIN,
): Promise<RpcResult & { status: number }> {
  const response = await handleMcp(
    new Request(`${origin}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    caller,
    origin,
  );
  const text = await response.text();
  const data =
    text.startsWith("event:") || text.includes("\ndata:")
      ? text
          .split("\n")
          .find((line) => line.startsWith("data:"))
          ?.slice(5)
      : text;
  let parsed: RpcResult = {};
  try {
    parsed = JSON.parse(data ?? "{}") as RpcResult;
  } catch {
    // A non-JSON body (an HTTP-level refusal) leaves the parsed reply empty; the status says what happened.
  }
  return { ...parsed, status: response.status };
}

export const call = (caller: Caller, name: string, args: Record<string, unknown> = {}, origin?: string) =>
  rpc(caller, "tools/call", { name, arguments: args }, origin);

/** The structured payload of a tool reply, or an empty object when there is none. */
export const structured = <T = Record<string, unknown>>(reply: RpcResult): T =>
  (reply.result?.structuredContent ?? {}) as T;

export const isToolError = (reply: RpcResult) => reply.result?.isError === true;
