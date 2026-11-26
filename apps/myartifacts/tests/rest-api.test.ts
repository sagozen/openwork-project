import assert from "node:assert/strict";
import { test } from "node:test";
import { restError } from "../src/lib/api/rest";
import { ArtifactError, type ArtifactErrorCode } from "../src/lib/artifacts/errors";
import * as completeRoute from "../src/pages/api/v1/files/[id]/complete";
import * as fileRoute from "../src/pages/api/v1/files/[id]/index";
import * as linkRoute from "../src/pages/api/v1/files/[id]/link";
import * as importRoute from "../src/pages/api/v1/files/import";
import * as filesRoute from "../src/pages/api/v1/files/index";
import * as uploadsRoute from "../src/pages/api/v1/files/uploads";
import * as shareRoute from "../src/pages/api/v1/shares/[id]";
import * as sharesRoute from "../src/pages/api/v1/shares/index";
import * as usageRoute from "../src/pages/api/v1/usage";
import { OWNER_A, OWNER_B, setupApi } from "./support/api";
import { ORIGIN } from "./support/artifacts";

type Handler = (context: never) => Promise<Response> | Response;

interface Reply {
  status: number;
  headers: Headers;
  body: Record<string, unknown> & { error?: { code: string; message: string; details?: unknown } };
}

/** Calls a route handler the way Astro does: a request, its path params and its URL. */
async function hit(
  handler: Handler,
  method: string,
  path: string,
  options: {
    key?: string;
    params?: Record<string, string>;
    json?: unknown;
    body?: BodyInit;
    headers?: Record<string, string>;
    /** What the middleware resolved for a browser session of the owner. */
    locals?: { user?: { id: string }; tenantId?: string };
  } = {},
): Promise<Reply> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.key) headers.authorization = `Bearer ${options.key}`;
  let body = options.body;
  if (options.json !== undefined) {
    body = JSON.stringify(options.json);
    headers["content-type"] = "application/json";
  }
  const request = new Request(`${ORIGIN}${path}`, { method, headers, body });
  const response = await handler({
    request,
    params: options.params ?? {},
    url: new URL(request.url),
    locals: options.locals ?? {},
  } as never);
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : {} };
}

test("every route needs an API key: none, a made-up one, and one for an address that is not the owner are all refused", async () => {
  const t = await setupApi();
  try {
    const stranger = await t.account("usr_s", "stranger@example.com");
    const routes: Array<[Handler, string, string]> = [
      [filesRoute.GET, "GET", "/api/v1/files"],
      [filesRoute.POST, "POST", "/api/v1/files"],
      [uploadsRoute.POST, "POST", "/api/v1/files/uploads"],
      [importRoute.POST, "POST", "/api/v1/files/import"],
      [fileRoute.GET, "GET", "/api/v1/files/x"],
      [fileRoute.PATCH, "PATCH", "/api/v1/files/x"],
      [fileRoute.DELETE, "DELETE", "/api/v1/files/x"],
      [completeRoute.POST, "POST", "/api/v1/files/x/complete"],
      [linkRoute.GET, "GET", "/api/v1/files/x/link"],
      [sharesRoute.GET, "GET", "/api/v1/shares"],
      [sharesRoute.POST, "POST", "/api/v1/shares"],
      [shareRoute.GET, "GET", "/api/v1/shares/x"],
      [shareRoute.PATCH, "PATCH", "/api/v1/shares/x"],
      [shareRoute.DELETE, "DELETE", "/api/v1/shares/x"],
      [usageRoute.GET, "GET", "/api/v1/usage"],
    ];
    for (const [handler, method, path] of routes) {
      const params = { id: "abcdefghijklmnopqrstuvwxyz" };
      assert.equal((await hit(handler, method, path, { params })).status, 401, `${method} ${path} without a key`);
      assert.equal(
        (await hit(handler, method, path, { params, key: "ma_live_notarealkey000000000000000000" })).status,
        401,
        `${method} ${path} with a made-up key`,
      );
      const refused = await hit(handler, method, path, { params, key: stranger.key });
      assert.equal(refused.status, 403, `${method} ${path} for a non-owner`);
      assert.equal(refused.body.error?.code, "forbidden");
    }
  } finally {
    t.close();
  }
});

test("save a file, list it, fetch it, get a link, and delete it", async () => {
  const t = await setupApi();
  try {
    const { key } = await t.account("usr_a", OWNER_A);
    const created = await hit(filesRoute.POST, "POST", "/api/v1/files", {
      key,
      json: { name: "Báo cáo.txt", content: "xin chào" },
    });
    assert.equal(created.status, 201);
    assert.equal(created.headers.get("cache-control"), "no-store");
    assert.match(created.headers.get("content-type") ?? "", /^application\/json/);
    const file = created.body.file as { id: string; size: number; name: string; status: string };
    assert.deepEqual(
      { name: file.name, status: file.status, size: file.size },
      { name: "Báo cáo.txt", status: "ready", size: Buffer.byteLength("xin chào") },
    );

    const list = await hit(filesRoute.GET, "GET", "/api/v1/files?limit=5&query=b%C3%A1o", { key });
    assert.equal(list.status, 200);
    assert.deepEqual(
      (list.body.items as Array<{ id: string }>).map((item) => item.id),
      [file.id],
    );
    assert.equal((await hit(filesRoute.GET, "GET", "/api/v1/files?query=nothing", { key })).body.items?.toString(), "");

    const params = { id: file.id };
    const one = await hit(fileRoute.GET, "GET", `/api/v1/files/${file.id}`, { key, params });
    assert.equal((one.body.file as { id: string }).id, file.id);

    const link = await hit(linkRoute.GET, "GET", `/api/v1/files/${file.id}/link?ttl=600&disposition=inline`, {
      key,
      params,
    });
    assert.equal(link.status, 200);
    assert.equal(new URL(link.body.url as string).searchParams.get("X-Amz-Expires"), "600");
    assert.equal(link.body.disposition, "inline");
    assert.equal(
      (await hit(linkRoute.GET, "GET", `/api/v1/files/${file.id}/link`, { key, params })).body.disposition,
      "attachment",
    );
    assert.equal((await hit(linkRoute.GET, "GET", `/api/v1/files/${file.id}/link?ttl=5`, { key, params })).status, 422);

    assert.deepEqual((await hit(usageRoute.GET, "GET", "/api/v1/usage", { key })).body, { files: 1, bytes: file.size });

    const removed = await hit(fileRoute.DELETE, "DELETE", `/api/v1/files/${file.id}`, { key, params });
    assert.deepEqual(removed.body, { id: file.id, deleted: true });
    assert.equal(
      (await hit(fileRoute.DELETE, "DELETE", `/api/v1/files/${file.id}`, { key, params })).status,
      200,
      "repeating is fine",
    );
    assert.equal((await hit(fileRoute.GET, "GET", `/api/v1/files/${file.id}`, { key, params })).status, 404);
  } finally {
    t.close();
  }
});

test("a presigned upload is created, completed, and refused when the size is wrong", async () => {
  const t = await setupApi();
  try {
    const { key } = await t.account("usr_a", OWNER_A);
    const started = await hit(uploadsRoute.POST, "POST", "/api/v1/files/uploads", {
      key,
      json: { name: "big.bin", size: 4, mime: "application/octet-stream" },
    });
    assert.equal(started.status, 201);
    const upload = started.body as { file_id: string; upload_url: string; method: string; content_length: number };
    assert.equal(upload.method, "PUT");
    assert.equal(upload.content_length, 4);
    const params = { id: upload.file_id };

    const early = await hit(completeRoute.POST, "POST", `/api/v1/files/${upload.file_id}/complete`, { key, params });
    assert.equal(early.status, 404);
    assert.equal(early.body.error?.code, "UPLOAD_NOT_FOUND");

    const objectKey = (
      await t.db.first<{ object_key: string }>("SELECT object_key FROM artifacts WHERE id = ?", [upload.file_id])
    )?.object_key as string;
    t.store.objects.set(objectKey, { bytes: new Uint8Array(4), contentType: "application/octet-stream" });
    const done = await hit(completeRoute.POST, "POST", `/api/v1/files/${upload.file_id}/complete`, { key, params });
    assert.equal(done.status, 200);
    assert.deepEqual(
      { status: (done.body.file as { status: string }).status, size: (done.body.file as { size: number }).size },
      { status: "ready", size: 4 },
    );

    const other = await hit(uploadsRoute.POST, "POST", "/api/v1/files/uploads", {
      key,
      json: { name: "x.bin", size: 2 },
    });
    const otherKey = (
      await t.db.first<{ object_key: string }>("SELECT object_key FROM artifacts WHERE id = ?", [
        (other.body as { file_id: string }).file_id,
      ])
    )?.object_key as string;
    t.store.objects.set(otherKey, { bytes: new Uint8Array(3), contentType: "application/octet-stream" });
    const wrong = await hit(
      completeRoute.POST,
      "POST",
      `/api/v1/files/${(other.body as { file_id: string }).file_id}/complete`,
      { key, params: { id: (other.body as { file_id: string }).file_id } },
    );
    assert.equal(wrong.status, 422);
    assert.equal(wrong.body.error?.code, "INVALID_INPUT");
  } finally {
    t.close();
  }
});

test("a raw application/octet-stream body is saved with its fields from the query, up to the inline cap", async () => {
  const t = await setupApi();
  try {
    const { key } = await t.account("usr_a", OWNER_A);
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9]);
    const saved = await hit(filesRoute.POST, "POST", "/api/v1/files?name=pic.png&expires_in_days=2&note=hi", {
      key,
      body: bytes,
      headers: { "content-type": "application/octet-stream" },
    });
    assert.equal(saved.status, 201);
    const file = saved.body.file as {
      mime: string;
      size: number;
      expires_at: string;
      note: string;
      source: string;
      sha256: string;
    };
    assert.deepEqual(
      { mime: file.mime, size: file.size, note: file.note, source: file.source },
      { mime: "image/png", size: 6, note: "hi", source: "inline" },
    );
    assert.equal(file.expires_at, "2026-11-24T10:00:00.000Z");
    assert.match(file.sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual([...[...t.store.objects.values()][0].bytes], [...bytes]);

    t.deps.settings.maxInlineBytes = 5;
    const declared = await hit(filesRoute.POST, "POST", "/api/v1/files?name=big.bin", {
      key,
      body: bytes,
      headers: { "content-type": "application/octet-stream" },
    });
    assert.equal(declared.status, 413);
    assert.equal(declared.body.error?.code, "TOO_LARGE");
    // A body that does not declare its length is still counted as it is read.
    const streamed = await hit(filesRoute.POST, "POST", "/api/v1/files?name=big.bin", {
      key,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
      headers: { "content-type": "application/octet-stream" },
    }).catch((error: unknown) => error);
    assert.ok(streamed instanceof Error || (streamed as Reply).status === 413, "a stream over the cap is refused");
    assert.equal(t.store.objects.size, 1, "nothing oversized was stored");
    t.deps.settings.maxInlineBytes = 4 * 1024 * 1024;

    const noName = await hit(filesRoute.POST, "POST", "/api/v1/files", {
      key,
      body: bytes,
      headers: { "content-type": "application/octet-stream" },
    });
    assert.equal(noName.status, 422);
    const unknown = await hit(filesRoute.POST, "POST", "/api/v1/files?name=a.bin&tenant_id=ten_b", {
      key,
      body: bytes,
      headers: { "content-type": "application/octet-stream" },
    });
    assert.equal(unknown.status, 422);
    const wrongType = await hit(filesRoute.POST, "POST", "/api/v1/files?name=a.bin", {
      key,
      body: "x",
      headers: { "content-type": "text/plain" },
    });
    assert.equal(wrongType.status, 422);
    assert.match(wrongType.body.error?.message ?? "", /application\/octet-stream/);
  } finally {
    t.close();
  }
});

test("import fetches a public URL and refuses a private one", async () => {
  const t = await setupApi();
  try {
    const { key } = await t.account("usr_a", OWNER_A);
    t.deps.fetch = (async () =>
      new Response("hello", { headers: { "content-type": "text/plain", "content-length": "5" } })) as typeof fetch;
    const done = await hit(importRoute.POST, "POST", "/api/v1/files/import", {
      key,
      json: { url: "https://example.com/a/hello.txt" },
    });
    assert.equal(done.status, 201);
    assert.equal((done.body.file as { name: string; source: string }).source, "url");
    const blocked = await hit(importRoute.POST, "POST", "/api/v1/files/import", {
      key,
      json: { url: "https://127.0.0.1/x" },
    });
    assert.equal(blocked.status, 422);
    assert.equal(blocked.body.error?.code, "INVALID_INPUT");
  } finally {
    t.close();
  }
});

test("shares: create with a generated password, list, show, change, and revoke with DELETE", async () => {
  const t = await setupApi();
  try {
    const { key } = await t.account("usr_a", OWNER_A);
    const file = (
      (await hit(filesRoute.POST, "POST", "/api/v1/files", { key, json: { name: "a.txt", content: "a" } })).body
        .file as { id: string }
    ).id;
    const created = await hit(sharesRoute.POST, "POST", "/api/v1/shares", {
      key,
      json: { file_ids: [file], title: "T", password: "generate", expires_in_days: 3 },
    });
    assert.equal(created.status, 201);
    const share = created.body as { share_id: string; url: string; password: string };
    assert.equal(share.url, `${ORIGIN}/s/${share.share_id}`);
    assert.match(share.password, /^[A-HJ-NP-Z2-9]{16}$/);
    const params = { id: share.share_id };

    const list = await hit(sharesRoute.GET, "GET", "/api/v1/shares?limit=10&include_revoked=false", { key });
    assert.equal((list.body.items as unknown[]).length, 1);
    assert.ok(!JSON.stringify(list.body).includes(share.password));
    const one = await hit(shareRoute.GET, "GET", `/api/v1/shares/${share.share_id}`, { key, params });
    assert.equal((one.body.share as { items: unknown[] }).items.length, 1);
    const patched = await hit(shareRoute.PATCH, "PATCH", `/api/v1/shares/${share.share_id}`, {
      key,
      params,
      json: { title: "New", password: null },
    });
    assert.deepEqual(
      {
        title: (patched.body.share as { title: string }).title,
        has_password: (patched.body.share as { has_password: boolean }).has_password,
      },
      { title: "New", has_password: false },
    );
    assert.equal(
      (await hit(shareRoute.PATCH, "PATCH", `/api/v1/shares/${share.share_id}`, { key, params, json: {} })).status,
      422,
    );
    const revoked = await hit(shareRoute.DELETE, "DELETE", `/api/v1/shares/${share.share_id}`, { key, params });
    assert.equal((revoked.body.share as { state: string }).state, "revoked");
    assert.equal(
      ((await hit(sharesRoute.GET, "GET", "/api/v1/shares?include_revoked=true", { key })).body.items as unknown[])
        .length,
      1,
    );
    assert.equal(((await hit(sharesRoute.GET, "GET", "/api/v1/shares", { key })).body.items as unknown[]).length, 0);
    assert.equal((await hit(sharesRoute.GET, "GET", "/api/v1/shares?include_revoked=maybe", { key })).status, 422);
  } finally {
    t.close();
  }
});

test("a read-only key can read and cannot write", async () => {
  const t = await setupApi();
  try {
    const writer = await t.account("usr_a", OWNER_A);
    const reader = await t.account("usr_b", OWNER_B, ["artifacts:read"]);
    // The reader is another account, so give it a file of its own to read.
    const file = await (await import("../src/lib/artifacts/service")).putInline(
      t.deps,
      { ...reader.caller, scopes: ["artifacts:write"] },
      { name: "r.txt", content: "r" },
    );
    assert.equal((await hit(filesRoute.GET, "GET", "/api/v1/files", { key: reader.key })).status, 200);
    assert.equal(
      (await hit(fileRoute.GET, "GET", `/api/v1/files/${file.id}`, { key: reader.key, params: { id: file.id } }))
        .status,
      200,
    );
    for (const [handler, method, path, json] of [
      [filesRoute.POST, "POST", "/api/v1/files", { name: "x", content: "x" }],
      [uploadsRoute.POST, "POST", "/api/v1/files/uploads", { name: "x", size: 1 }],
      [importRoute.POST, "POST", "/api/v1/files/import", { url: "https://example.com/x" }],
      [sharesRoute.POST, "POST", "/api/v1/shares", { file_ids: [file.id] }],
    ] as const) {
      const refused = await hit(handler, method, path, { key: reader.key, json });
      assert.equal(refused.status, 403, `${method} ${path}`);
      assert.equal(refused.body.error?.code, "INSUFFICIENT_SCOPE");
    }
    assert.equal(
      (await hit(fileRoute.DELETE, "DELETE", `/api/v1/files/${file.id}`, { key: reader.key, params: { id: file.id } }))
        .status,
      403,
    );
    assert.equal(
      (await hit(filesRoute.POST, "POST", "/api/v1/files", { key: writer.key, json: { name: "x", content: "x" } }))
        .status,
      201,
    );
  } finally {
    t.close();
  }
});

test("each error code maps to its HTTP status, with the same envelope", async () => {
  const read = async (response: Response) => ({
    status: response.status,
    body: (await response.json()) as { error: { code: string; message: string; details?: unknown } },
  });
  const expected: Record<ArtifactErrorCode, number> = {
    NOT_FOUND: 404,
    UPLOAD_NOT_FOUND: 404,
    INSUFFICIENT_SCOPE: 403,
    INVALID_INPUT: 422,
    VALIDATION_ERROR: 422,
    TOO_LARGE: 413,
    UPLOADS_DISABLED: 503,
    PROVIDER_ERROR: 502,
    INTERNAL_ERROR: 500,
  };
  for (const [code, status] of Object.entries(expected)) {
    const { status: actual, body } = await read(
      restError(new ArtifactError(code as ArtifactErrorCode, "message", { a: 1 })),
    );
    assert.equal(actual, status, code);
    assert.deepEqual(body.error, { code, message: "message", details: { a: 1 } });
  }
  const unknown = await read(restError(new Error("SQLITE_CORRUPT at /srv/db")));
  assert.equal(unknown.status, 500);
  assert.equal(unknown.body.error.message, "The request could not be completed.");
});

test("errors come through the routes as the right status: validation, size, off switch, storage, and a crash", async () => {
  const t = await setupApi();
  try {
    const { key, caller } = await t.account("usr_a", OWNER_A);
    const bad = await hit(filesRoute.POST, "POST", "/api/v1/files", {
      key,
      json: { name: "x", content: "x", tenant_id: "ten_b" },
    });
    assert.equal(bad.status, 422);
    assert.equal(bad.body.error?.code, "VALIDATION_ERROR");
    assert.ok(JSON.stringify(bad.body.error?.details).includes("tenant_id"));
    assert.equal(
      (
        await hit(filesRoute.POST, "POST", "/api/v1/files", {
          key,
          body: "{nope",
          headers: { "content-type": "application/json" },
        })
      ).status,
      422,
    );
    assert.equal(
      (
        await hit(filesRoute.POST, "POST", "/api/v1/files", {
          key,
          body: "[1]",
          headers: { "content-type": "application/json" },
        })
      ).status,
      422,
    );
    assert.equal((await hit(filesRoute.GET, "GET", "/api/v1/files?limit=abc", { key })).status, 422);
    assert.equal((await hit(filesRoute.GET, "GET", "/api/v1/files?surprise=1", { key })).status, 422);

    const huge = await hit(filesRoute.POST, "POST", "/api/v1/files", {
      key,
      body: "x",
      headers: { "content-type": "application/json", "content-length": String(7 * 1024 * 1024) },
    }).catch(() => null);
    assert.ok(huge === null || huge.status === 413, "a JSON body over 6 MB is refused");

    assert.equal(
      (
        await hit(uploadsRoute.POST, "POST", "/api/v1/files/uploads", {
          key,
          json: { name: "x", size: 5 * 1024 ** 3 + 1 },
        })
      ).status,
      413,
    );

    t.deps.settings.enabled = false;
    const off = await hit(filesRoute.POST, "POST", "/api/v1/files", { key, json: { name: "x", content: "x" } });
    assert.equal(off.status, 503);
    assert.equal(off.body.error?.code, "UPLOADS_DISABLED");
    t.deps.settings.enabled = true;

    const file = await (await import("../src/lib/artifacts/service")).putInline(t.deps, caller, {
      name: "a.txt",
      content: "x",
    });
    t.store.faults.delete = true;
    const storage = await hit(fileRoute.DELETE, "DELETE", `/api/v1/files/${file.id}`, { key, params: { id: file.id } });
    assert.equal(storage.status, 502);
    assert.equal(storage.body.error?.code, "PROVIDER_ERROR");
    t.store.faults.delete = false;

    const realDb = t.services.artifacts.db;
    t.services.artifacts.db = {
      ...realDb,
      first: async () => {
        throw new Error("SQLITE_CORRUPT /srv/db");
      },
    } as typeof realDb;
    const crash = await hit(fileRoute.GET, "GET", `/api/v1/files/${file.id}`, { key, params: { id: file.id } });
    assert.equal(crash.status, 500);
    assert.equal(crash.body.error?.code, "INTERNAL_ERROR");
    assert.ok(!JSON.stringify(crash.body).includes("SQLITE"));
    t.services.artifacts.db = realDb;
  } finally {
    t.close();
  }
});

test("PATCH /files/{id} sets and clears the expiry through the same tool, and only for the owner of the file", async () => {
  const t = await setupApi();
  try {
    const a = await t.account("usr_a", OWNER_A);
    const b = await t.account("usr_b", OWNER_B);
    const file = (
      await hit(filesRoute.POST, "POST", "/api/v1/files", { key: a.key, json: { name: "a.txt", content: "a" } })
    ).body.file as {
      id: string;
      expires_at: string | null;
    };
    assert.equal(file.expires_at, null);
    const params = { id: file.id };
    const patch = (key: string, json: unknown) =>
      hit(fileRoute.PATCH, "PATCH", `/api/v1/files/${file.id}`, { key, params, json });

    const set = await patch(a.key, { expires_in_days: 3 });
    assert.equal(set.status, 200);
    assert.equal((set.body.file as { expires_at: string }).expires_at, "2026-11-25T10:00:00.000Z");
    const cleared = await patch(a.key, { expires_in_days: null });
    assert.equal((cleared.body.file as { expires_at: string | null }).expires_at, null);

    for (const bad of [
      {},
      { expires_in_days: 0 },
      { expires_in_days: "soon" },
      { expires_in_days: 5, tenant_id: "ten_b" },
      { expires_in_days: 99_999 },
    ]) {
      const refused = await patch(a.key, bad);
      assert.equal(refused.status, 422, JSON.stringify(bad));
      assert.equal(refused.body.error?.code, "VALIDATION_ERROR");
    }
    // The id comes from the path; one in the body cannot redirect the change.
    assert.equal((await patch(a.key, { expires_in_days: 1, file_id: file.id })).status, 200);

    assert.equal((await patch(b.key, { expires_in_days: 1 })).status, 404, "another account");
    const after = await hit(fileRoute.GET, "GET", `/api/v1/files/${file.id}`, { key: a.key, params });
    assert.equal(
      (after.body.file as { expires_at: string | null }).expires_at,
      "2026-11-23T10:00:00.000Z",
      "only the owner's change applied",
    );
  } finally {
    t.close();
  }
});

test("a read-only key cannot change an expiry", async () => {
  const t = await setupApi();
  try {
    const reader = await t.account("usr_r", OWNER_B, ["artifacts:read"]);
    const file = await (await import("../src/lib/artifacts/service")).putInline(
      t.deps,
      { ...reader.caller, scopes: ["artifacts:write"] },
      { name: "r.txt", content: "r" },
    );
    const refused = await hit(fileRoute.PATCH, "PATCH", `/api/v1/files/${file.id}`, {
      key: reader.key,
      params: { id: file.id },
      json: { expires_in_days: 2 },
    });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error?.code, "INSUFFICIENT_SCOPE");
  } finally {
    t.close();
  }
});

test("the owner's browser session is accepted in place of a key, a bearer header takes precedence, and it never crosses accounts", async () => {
  const t = await setupApi();
  try {
    const a = await t.account("usr_a", OWNER_A);
    const b = await t.account("usr_b", OWNER_B);
    const asA = { user: { id: "usr_a" }, tenantId: a.tenantId };
    const asB = { user: { id: "usr_b" }, tenantId: b.tenantId };

    const created = await hit(filesRoute.POST, "POST", "/api/v1/files", {
      locals: asA,
      json: { name: "s.txt", content: "s" },
    });
    assert.equal(created.status, 201);
    const id = (created.body.file as { id: string }).id;
    const owner = await t.db.first<{ tenant_id: string }>("SELECT tenant_id FROM artifacts WHERE id = ?", [id]);
    assert.equal(owner?.tenant_id, a.tenantId);

    assert.equal(
      ((await hit(filesRoute.GET, "GET", "/api/v1/files", { locals: asA })).body.items as unknown[]).length,
      1,
    );
    assert.equal(
      ((await hit(filesRoute.GET, "GET", "/api/v1/files", { locals: asB })).body.items as unknown[]).length,
      0,
    );
    assert.equal(
      (await hit(fileRoute.DELETE, "DELETE", `/api/v1/files/${id}`, { locals: asB, params: { id } })).status,
      404,
    );
    assert.equal(
      (await hit(linkRoute.GET, "GET", `/api/v1/files/${id}/link?ttl=3600`, { locals: asA, params: { id } })).status,
      200,
    );

    // A bearer header is authenticated as a key, whatever the session says.
    const withBadKey = await hit(filesRoute.GET, "GET", "/api/v1/files", {
      locals: asA,
      key: "ma_live_notarealkey000000000000000000",
    });
    assert.equal(withBadKey.status, 401);
    assert.equal((await hit(filesRoute.GET, "GET", "/api/v1/files")).status, 401);
    assert.equal(
      (await hit(fileRoute.DELETE, "DELETE", `/api/v1/files/${id}`, { locals: asA, params: { id } })).status,
      200,
    );
  } finally {
    t.close();
  }
});
