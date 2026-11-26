import assert from "node:assert/strict";
import { test } from "node:test";
import type { Db } from "@templatedesign/platform/db";
import { putInline } from "../src/lib/artifacts/service";
import { createShare } from "../src/lib/shares/service";
import * as completeRoute from "../src/pages/api/v1/files/[id]/complete";
import * as fileRoute from "../src/pages/api/v1/files/[id]/index";
import * as linkRoute from "../src/pages/api/v1/files/[id]/link";
import * as importRoute from "../src/pages/api/v1/files/import";
import * as filesRoute from "../src/pages/api/v1/files/index";
import * as uploadsRoute from "../src/pages/api/v1/files/uploads";
import * as shareRoute from "../src/pages/api/v1/shares/[id]";
import * as sharesRoute from "../src/pages/api/v1/shares/index";
import * as usageRoute from "../src/pages/api/v1/usage";
import { call, isToolError, OWNER_A, OWNER_B, setupApi, structured } from "./support/api";
import { ORIGIN } from "./support/artifacts";

const MARKER_NAME = "MARKER-A-NAME-7f3.txt";
const MARKER_CONTENT = "MARKER-A-CONTENT-91c";
const MARKER_TITLE = "MARKER-A-TITLE-5d2";

const TABLES = /\b(?:FROM|JOIN|INTO|UPDATE)\s+(?:artifacts|shares|share_items)\b/;

/** A database that records every statement it is asked to run. */
function recording(db: Db, log: string[]): Db {
  return {
    first: (sql, params) => {
      log.push(sql);
      return db.first(sql, params);
    },
    all: (sql, params) => {
      log.push(sql);
      return db.all(sql, params);
    },
    run: (sql, params) => {
      log.push(sql);
      return db.run(sql, params);
    },
    batch: (statements) => {
      log.push(...statements.map((statement) => statement.sql));
      return db.batch(statements);
    },
    exec: (sql) => {
      log.push(sql);
      return db.exec(sql);
    },
  };
}

/** Statements on a business table that never mention tenant_id. */
const unscoped = (log: string[]) => log.filter((sql) => TABLES.test(sql) && !/tenant_id/.test(sql));

type Handler = (context: never) => Promise<Response> | Response;

async function hit(
  handler: Handler,
  method: string,
  path: string,
  key: string,
  params: Record<string, string> = {},
  json?: unknown,
) {
  const request = new Request(`${ORIGIN}${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, ...(json === undefined ? {} : { "content-type": "application/json" }) },
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  const response = await handler({ request, params, url: new URL(request.url) } as never);
  const text = await response.text();
  return {
    status: response.status,
    text,
    body: (text ? JSON.parse(text) : {}) as { error?: { code: string }; items?: unknown[] },
  };
}

async function world() {
  const t = await setupApi();
  const log: string[] = [];
  const db = recording(t.db, log);
  t.services.artifacts.db = db;
  t.services.shares.db = db;
  const a = await t.account("usr_a", OWNER_A);
  const b = await t.account("usr_b", OWNER_B);

  const file = await putInline(t.deps, a.caller, { name: MARKER_NAME, content: MARKER_CONTENT });
  const pending = (await call(a.caller, "create_upload", { name: "pending-a.bin", size: 3 })).result
    ?.structuredContent as { file_id: string };
  const share = await createShare(t.shareDeps, a.caller, {
    artifact_ids: [file.id],
    title: MARKER_TITLE,
    password: "generate",
  });
  return {
    t,
    a,
    b,
    log,
    fileId: file.id,
    pendingId: pending.file_id,
    shareId: share.share_id,
    password: share.password as string,
  };
}

/** Everything of account A's that a second account must not be able to change. */
async function snapshot(t: Awaited<ReturnType<typeof setupApi>>, tenantId: string) {
  const rows = {
    artifacts: await t.db.all("SELECT * FROM artifacts WHERE tenant_id = ? ORDER BY id", [tenantId]),
    shares: await t.db.all("SELECT * FROM shares WHERE tenant_id = ? ORDER BY id", [tenantId]),
    items: await t.db.all("SELECT * FROM share_items WHERE tenant_id = ? ORDER BY share_id, artifact_id", [tenantId]),
  };
  const keys = (
    await t.db.all<{ object_key: string }>("SELECT object_key FROM artifacts WHERE tenant_id = ?", [tenantId])
  ).map((row) => row.object_key);
  return JSON.stringify({ rows, objects: keys.map((key) => [key, t.store.objects.has(key)]) });
}

test("a second account replays every tool against the first account's ids and gets nothing and changes nothing", async () => {
  const w = await world();
  try {
    const before = await snapshot(w.t, w.a.tenantId);
    const replies: string[] = [];
    const notFound = async (name: string, args: Record<string, unknown>) => {
      const reply = await call(w.b.caller, name, args);
      replies.push(JSON.stringify(reply));
      assert.equal(isToolError(reply), true, name);
      assert.equal(structured<{ code: string }>(reply).code, "NOT_FOUND", name);
    };
    const absent = "abcdefghijklmnopqrstuvwxyz";

    for (const name of [
      "get_file",
      "read_file",
      "get_download_link",
      "complete_upload",
      "set_file_expiry",
      "delete_file",
    ]) {
      await notFound(name, { file_id: w.fileId, ...(name === "set_file_expiry" ? { expires_in_days: 1 } : {}) });
    }
    await notFound("complete_upload", { file_id: w.pendingId });
    await notFound("get_share", { share_id: w.shareId });
    await notFound("update_share", { share_id: w.shareId, title: "hijacked", password: null });
    await notFound("revoke_share", { share_id: w.shareId });
    await notFound("create_share", { file_ids: [w.fileId] });
    // Another account's id behaves exactly like an id that does not exist.
    for (const [name, args] of [
      ["get_file", { file_id: absent }],
      ["get_share", { share_id: absent }],
    ] as const) {
      const missing = structured(await call(w.b.caller, name, args));
      const theirs = structured(
        await call(w.b.caller, name, name === "get_file" ? { file_id: w.fileId } : { share_id: w.shareId }),
      );
      assert.deepEqual(theirs, missing, `${name}: no way to tell an existing id from a missing one`);
    }

    for (const [name, args] of [
      ["list_files", { status: "ready" }],
      ["list_files", { status: "pending" }],
      ["list_files", { query: "MARKER" }],
      ["list_shares", { include_revoked: true }],
    ] as const) {
      const reply = await call(w.b.caller, name, args);
      replies.push(JSON.stringify(reply));
      assert.deepEqual(structured<{ items: unknown[] }>(reply).items, [], `${name} ${JSON.stringify(args)}`);
    }
    const usage = await call(w.b.caller, "get_usage");
    replies.push(JSON.stringify(usage));
    assert.deepEqual(structured(usage), { files: 0, bytes: 0 });

    // The tools that create things only ever create them for the caller.
    const own = structured<{ file: { id: string } }>(
      await call(w.b.caller, "put_file", { name: MARKER_NAME, content: "b's own" }),
    );
    w.t.deps.fetch = (async () => new Response("b", { headers: { "content-length": "1" } })) as typeof fetch;
    await call(w.b.caller, "import_from_url", { url: "https://example.com/b.txt" });
    await call(w.b.caller, "create_upload", { name: "b.bin", size: 1 });
    await call(w.b.caller, "create_share", { file_ids: [own.file.id] });
    const owners = await w.t.db.all<{ tenant_id: string }>(
      "SELECT DISTINCT tenant_id FROM artifacts WHERE id != ? AND id != ? AND tenant_id != ?",
      [w.fileId, w.pendingId, w.a.tenantId],
    );
    assert.deepEqual(
      owners.map((row) => row.tenant_id),
      [w.b.tenantId],
    );

    for (const marker of [MARKER_NAME, MARKER_CONTENT, MARKER_TITLE, w.password]) {
      assert.ok(!replies.some((reply) => reply.includes(marker)), `a reply leaked ${marker}`);
    }
    assert.equal(await snapshot(w.t, w.a.tenantId), before, "account A's data is untouched");
  } finally {
    w.t.close();
  }
});

test("a second account replays every REST route against the first account's ids and gets nothing and changes nothing", async () => {
  const w = await world();
  try {
    const before = await snapshot(w.t, w.a.tenantId);
    const { key } = w.b;
    const fileParams = { id: w.fileId };
    const shareParams = { id: w.shareId };
    const results = [
      await hit(fileRoute.GET, "GET", `/api/v1/files/${w.fileId}`, key, fileParams),
      await hit(fileRoute.PATCH, "PATCH", `/api/v1/files/${w.fileId}`, key, fileParams, { expires_in_days: 1 }),
      await hit(fileRoute.DELETE, "DELETE", `/api/v1/files/${w.fileId}`, key, fileParams),
      await hit(linkRoute.GET, "GET", `/api/v1/files/${w.fileId}/link?ttl=600`, key, fileParams),
      await hit(completeRoute.POST, "POST", `/api/v1/files/${w.pendingId}/complete`, key, { id: w.pendingId }),
      await hit(shareRoute.GET, "GET", `/api/v1/shares/${w.shareId}`, key, shareParams),
      await hit(shareRoute.PATCH, "PATCH", `/api/v1/shares/${w.shareId}`, key, shareParams, { title: "hijacked" }),
      await hit(shareRoute.DELETE, "DELETE", `/api/v1/shares/${w.shareId}`, key, shareParams),
      await hit(sharesRoute.POST, "POST", "/api/v1/shares", key, {}, { file_ids: [w.fileId] }),
    ];
    for (const result of results) {
      assert.equal(result.status, 404, result.text);
      assert.equal(result.body.error?.code, "NOT_FOUND");
    }
    const lists = [
      await hit(filesRoute.GET, "GET", "/api/v1/files?status=ready", key),
      await hit(filesRoute.GET, "GET", "/api/v1/files?status=pending", key),
      await hit(filesRoute.GET, "GET", "/api/v1/files?query=MARKER", key),
      await hit(sharesRoute.GET, "GET", "/api/v1/shares?include_revoked=true", key),
    ];
    for (const list of lists) {
      assert.equal(list.status, 200);
      assert.deepEqual(list.body.items, []);
    }
    const usage = await hit(usageRoute.GET, "GET", "/api/v1/usage", key);
    assert.deepEqual(usage.body, { files: 0, bytes: 0 });

    w.t.deps.fetch = (async () => new Response("b", { headers: { "content-length": "1" } })) as typeof fetch;
    const own = await hit(filesRoute.POST, "POST", "/api/v1/files", key, {}, { name: MARKER_NAME, content: "b's own" });
    assert.equal(own.status, 201);
    assert.equal(
      (await hit(importRoute.POST, "POST", "/api/v1/files/import", key, {}, { url: "https://example.com/b.txt" }))
        .status,
      201,
    );
    assert.equal(
      (await hit(uploadsRoute.POST, "POST", "/api/v1/files/uploads", key, {}, { name: "b.bin", size: 1 })).status,
      201,
    );

    for (const marker of [MARKER_NAME, MARKER_CONTENT, MARKER_TITLE, w.password]) {
      const everything = [...results, ...lists, usage].map((reply) => reply.text).join("\n");
      assert.ok(!everything.includes(marker), `a reply leaked ${marker}`);
    }
    assert.equal(await snapshot(w.t, w.a.tenantId), before, "account A's data is untouched");
  } finally {
    w.t.close();
  }
});

test("every query on a business table, from every tool, names tenant_id", async () => {
  const w = await world();
  try {
    // Exercise every tool as the owner so each statement the services can run is on the record.
    const { fileId, shareId } = w;
    const calls: Array<[string, Record<string, unknown>]> = [
      ["list_files", {}],
      ["list_files", { query: "x", status: "pending" }],
      ["get_file", { file_id: fileId }],
      ["read_file", { file_id: fileId }],
      ["get_download_link", { file_id: fileId }],
      ["get_usage", {}],
      ["list_shares", {}],
      ["get_share", { share_id: shareId }],
      ["create_upload", { name: "u.bin", size: 2 }],
      ["put_file", { name: "p.txt", content: "p" }],
      ["set_file_expiry", { file_id: fileId, expires_in_days: 3 }],
      ["update_share", { share_id: shareId, title: "t" }],
    ];
    for (const [name, args] of calls) await call(w.a.caller, name, args);
    const extra = structured<{ file: { id: string } }>(
      await call(w.a.caller, "put_file", { name: "extra.txt", content: "e" }),
    );
    const created = structured<{ share_id: string }>(
      await call(w.a.caller, "create_share", { file_ids: [extra.file.id] }),
    );
    const upload = structured<{ file_id: string }>(await call(w.a.caller, "create_upload", { name: "c.bin", size: 1 }));
    await call(w.a.caller, "complete_upload", { file_id: upload.file_id });
    w.t.deps.fetch = (async () => new Response("i", { headers: { "content-length": "1" } })) as typeof fetch;
    await call(w.a.caller, "import_from_url", { url: "https://example.com/i.txt" });
    await call(w.a.caller, "revoke_share", { share_id: created.share_id });
    await call(w.a.caller, "delete_file", { file_id: extra.file.id });
    await call(w.b.caller, "get_file", { file_id: fileId });

    assert.ok(w.log.filter((sql) => TABLES.test(sql)).length > 30, "the recorder saw the services' statements");
    assert.deepEqual(unscoped(w.log), []);
  } finally {
    w.t.close();
  }
});

test("the recorder flags a statement that forgets the tenant", () => {
  assert.deepEqual(
    unscoped([
      "SELECT * FROM artifacts WHERE id = ?",
      "SELECT * FROM artifacts WHERE id = ? AND tenant_id = ?",
      "SELECT 1",
    ]),
    ["SELECT * FROM artifacts WHERE id = ?"],
  );
  assert.deepEqual(unscoped(["UPDATE shares SET revoked_at = ? WHERE id = ?"]), [
    "UPDATE shares SET revoked_at = ? WHERE id = ?",
  ]);
});
