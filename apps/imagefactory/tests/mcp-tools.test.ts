import assert from "node:assert/strict";
import { test } from "node:test";
import { generateApiKey, hashApiKey, publicPrefix } from "@templatedesign/platform/keys";
import { withCaller } from "../src/lib/auth/caller";
import type { JobContext } from "../src/lib/images/jobs";
import type { Caller, ServiceDeps } from "../src/lib/images/service";
import { DEFAULT_SETTINGS } from "../src/lib/images/settings";
import { setServiceFactory } from "../src/lib/mcp/context";
import { handleMcp } from "../src/lib/mcp/server";
import "../src/lib/platform";
import type { Env } from "../src/lib/types";
import { d1FromSqlite } from "./support/d1";
import { createTestDb } from "./support/db";
import { FakeBucket, FakeProvider, fakeImageFetch, PNG_BYTES } from "./support/fakes";

const ORIGIN = "https://imagefactory.test";
const A: Caller = { tenantId: "ten_a", userId: "usr_a", scopes: ["images:read", "images:write"], via: "oauth" };
const READ: Caller = { ...A, scopes: ["images:read"] };

async function setup() {
  const test_ = createTestDb();
  for (const id of ["ten_a", "ten_b"]) {
    await test_.db.run("INSERT INTO tenants (id, name, created_at) VALUES (?, ?, '2026-01-01T00:00:00Z')", [id, id]);
  }
  const bucket = new FakeBucket();
  const provider = new FakeProvider({
    status: { state: "done" },
    result: {
      seed: 5,
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
  const deps: ServiceDeps = {
    job,
    settings: DEFAULT_SETTINGS,
    origin: ORIGIN,
    secret: "secret",
    fetch: (async () => new Response(PNG_BYTES)) as unknown as typeof fetch,
  };
  setServiceFactory(async () => deps);
  return { ...test_, bucket, provider, deps };
}

interface RpcResult {
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

async function rpc(caller: Caller, method: string, params: Record<string, unknown> = {}): Promise<RpcResult> {
  const response = await handleMcp(
    new Request(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    caller,
    ORIGIN,
  );
  const text = await response.text();
  const body =
    text.startsWith("event:") || text.includes("\ndata:")
      ? text
          .split("\n")
          .find((line) => line.startsWith("data:"))
          ?.slice(5)
      : text;
  return JSON.parse(body ?? "{}") as RpcResult;
}

/** The structured payload of a tool reply, or an empty object when there is none. */
const structured = <T>(reply: RpcResult): T => (reply.result?.structuredContent ?? {}) as T;

const call = (caller: Caller, name: string, args: Record<string, unknown>) =>
  rpc(caller, "tools/call", { name, arguments: args });

interface ToolDescriptor {
  name: string;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean };
  inputSchema: { properties: Record<string, unknown>; additionalProperties?: boolean };
}

test("a write connection sees every tool and a read-only connection only the read tools", async () => {
  const { close } = await setup();
  try {
    const full = (await rpc(A, "tools/list")).result?.tools as ToolDescriptor[];
    assert.deepEqual(
      full.map((tool) => tool.name).sort(),
      [
        "add_brand_asset",
        "create_brand",
        "delete_brand",
        "delete_image",
        "edit_image",
        "estimate_cost",
        "generate_image",
        "get_balance",
        "get_brand",
        "get_image",
        "get_job",
        "list_brands",
        "list_images",
        "list_presets",
        "remove_brand_asset",
        "update_brand",
      ].sort(),
    );
    const readOnly = (await rpc(READ, "tools/list")).result?.tools as ToolDescriptor[];
    assert.deepEqual(readOnly.map((tool) => tool.name).sort(), [
      "estimate_cost",
      "get_balance",
      "get_brand",
      "get_image",
      "get_job",
      "list_brands",
      "list_images",
      "list_presets",
    ]);
    assert.ok(readOnly.every((tool) => tool.annotations.readOnlyHint));
  } finally {
    close();
  }
});

test("no tool accepts a tenant or user id, and every input rejects unknown fields", async () => {
  const { close } = await setup();
  try {
    const tools = (await rpc(A, "tools/list")).result?.tools as ToolDescriptor[];
    for (const tool of tools) {
      assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} is strict`);
      for (const field of Object.keys(tool.inputSchema.properties)) {
        assert.doesNotMatch(field, /tenant|user_id|workspace/, `${tool.name}.${field}`);
      }
    }
    const destructive = tools
      .filter((tool) => tool.annotations.destructiveHint)
      .map((tool) => tool.name)
      .sort();
    assert.deepEqual(destructive, ["delete_brand", "delete_image", "remove_brand_asset"]);
  } finally {
    close();
  }
});

test("generate_image replies with the public url, a markdown image, structured data and a small preview", async () => {
  const { close, bucket } = await setup();
  try {
    const reply = await call(A, "generate_image", { prompt: "A bird", preset: "pin" });
    const content = reply.result?.content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    assert.equal(content[0].type, "text");
    assert.match(content[0].text ?? "", /https:\/\/imagefactory\.test\/i\/[a-z2-7]{26}\.png/);
    assert.match(content[0].text ?? "", /!\[Image 1\]\(https:\/\/imagefactory\.test\/i\//);
    assert.equal(content[1].type, "image");
    assert.equal(content[1].mimeType, "image/png");
    assert.equal(Buffer.from(content[1].data ?? "", "base64").byteLength, PNG_BYTES.byteLength);
    const structured = reply.result?.structuredContent as {
      images: Array<{ id: string; url: string }>;
      credits_charged: number;
    };
    assert.equal(structured.images.length, 1);
    assert.equal(structured.credits_charged, 4);
    assert.equal(bucket.objects.size, 1);
  } finally {
    close();
  }
});

test("failures come back as tool errors with a stable code", async () => {
  const { close } = await setup();
  try {
    const missing = await call(A, "get_brand", { brand: "nope" });
    assert.equal(missing.result?.isError, true);
    assert.equal(structured<{ code: string }>(missing).code, "NOT_FOUND");

    const poor = await call(A, "generate_image", { prompt: "Big", num_images: 4, width: 2048, height: 1536 });
    assert.equal(structured<{ code: string }>(poor).code, "INSUFFICIENT_CREDITS");

    const unknown = await call(A, "generate_image", { prompt: "x", tenant_id: "ten_b" });
    assert.equal(unknown.result?.isError, true);
    assert.match(JSON.stringify(unknown.result?.content), /Unrecognized key: \\"tenant_id\\"/);

    const denied = await call(READ, "generate_image", { prompt: "x" });
    assert.match(JSON.stringify(denied), /insufficient_scope/);
    assert.match(JSON.stringify(denied), /images:write/);
  } finally {
    close();
  }
});

test("brand tools create, read and delete a kit inside the caller's account only", async () => {
  const { close } = await setup();
  try {
    const created = await call(A, "create_brand", {
      name: "LargePrint",
      style_prompt: "Friendly flat illustration",
      palette: [{ name: "primary", hex: "#1a73e8" }],
    });
    assert.equal(structured<{ slug: string }>(created).slug, "largeprint");
    const other: Caller = { ...A, tenantId: "ten_b" };
    const theirs = await call(other, "list_brands", {});
    assert.deepEqual(structured(theirs), { brands: [] });
    const stolen = await call(other, "get_brand", { brand: "largeprint" });
    assert.equal(stolen.result?.isError, true);
    const mine = await call(A, "list_brands", {});
    assert.equal(structured<{ brands: unknown[] }>(mine).brands.length, 1);
    const deleted = await call(A, "delete_brand", { brand: "largeprint" });
    assert.equal(deleted.result?.isError, undefined);
    const after = await call(A, "list_brands", {});
    assert.deepEqual(structured(after), { brands: [] });
  } finally {
    close();
  }
});

async function envWith(raw: ReturnType<typeof createTestDb>["raw"]): Promise<Env> {
  return {
    DB: d1FromSqlite(raw),
    BETTER_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
    BETTER_AUTH_URL: ORIGIN,
    APP_ORIGIN: ORIGIN,
    EMAIL_PROVIDER: "console",
  } as unknown as Env;
}

async function insertKey(
  db: ReturnType<typeof createTestDb>["db"],
  tenantId: string,
  scopes: string[],
  livemode = true,
) {
  const key = generateApiKey(livemode);
  await db.run(
    "INSERT OR IGNORE INTO \"user\" (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('usr_k', 'K', 'k@example.com', 1, 0, 0)",
  );
  await db.run(
    "INSERT INTO api_keys (id, tenant_id, user_id, name, prefix, hash, scopes, created_at) VALUES (?, ?, 'usr_k', 'n8n', ?, ?, ?, '2026-01-01T00:00:00Z')",
    [
      `key_${Math.random().toString(16).slice(2)}`,
      tenantId,
      publicPrefix(key),
      await hashApiKey(key),
      JSON.stringify(scopes),
    ],
  );
  return key;
}

test("an API key authenticates /mcp and /api/v1 callers with the scopes it was created with", async () => {
  const { db, raw, close } = await setup();
  try {
    const env = await envWith(raw);
    const ask = (token: string | null) =>
      withCaller(
        env,
        new Request(`${ORIGIN}/mcp`, token ? { headers: { authorization: `Bearer ${token}` } } : {}),
        async (caller) => Response.json(caller),
      );

    const key = await insertKey(db, "ten_a", ["images:read"]);
    const ok = await ask(key);
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { tenantId: "ten_a", userId: "usr_k", scopes: ["images:read"], via: "api_key" });

    const wrongTail = await ask(`${key.slice(0, -1)}${key.endsWith("a") ? "b" : "a"}`);
    assert.equal(wrongTail.status, 401);
    assert.equal(wrongTail.headers.get("www-authenticate"), null, "an API key failure does not start an OAuth flow");

    assert.equal(
      (await ask(await insertKey(db, "ten_a", ["images:read"], false))).status,
      401,
      "test-mode keys are refused",
    );

    await db.run("UPDATE api_keys SET revoked_at = '2026-02-01T00:00:00Z'");
    assert.equal((await ask(key)).status, 401, "a revoked key is refused");

    const fresh = await insertKey(db, "ten_b", ["images:write"]);
    await db.run("UPDATE tenants SET suspended_at = '2026-02-01T00:00:00Z' WHERE id = 'ten_b'");
    assert.equal((await ask(fresh)).status, 403, "a suspended account is refused");
  } finally {
    close();
  }
});

test("a missing or unknown bearer on /mcp starts the OAuth flow with a resource metadata challenge", async () => {
  const { raw, close } = await setup();
  try {
    const env = await envWith(raw);
    const response = await withCaller(
      env,
      new Request(`${ORIGIN}/mcp`, { method: "POST" }),
      async () => new Response("no"),
    );
    assert.equal(response.status, 401);
    assert.match(
      response.headers.get("www-authenticate") ?? "",
      /resource_metadata="https:\/\/imagefactory\.test\/\.well-known\/oauth-protected-resource\/mcp"/,
    );
  } finally {
    close();
  }
});
