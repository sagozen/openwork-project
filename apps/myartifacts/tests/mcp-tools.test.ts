import assert from "node:assert/strict";
import { test } from "node:test";
import { SERVER_INSTRUCTIONS, TOOLS } from "../src/lib/mcp/server";
import { call, isToolError, rpc, setupApi, structured } from "./support/api";
import { A, B, NO_SCOPE, ORIGIN, READ_ONLY } from "./support/artifacts";

interface ToolDescriptor {
  name: string;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
  inputSchema: { properties: Record<string, unknown>; additionalProperties?: boolean };
}

const READ_TOOLS = [
  "get_download_link",
  "get_file",
  "get_share",
  "get_usage",
  "list_files",
  "list_shares",
  "read_file",
];
const WRITE_TOOLS = [
  "complete_upload",
  "create_share",
  "create_upload",
  "delete_file",
  "import_from_url",
  "put_file",
  "revoke_share",
  "set_file_expiry",
  "update_share",
];

const listed = async (caller: typeof A) => ((await rpc(caller, "tools/list")).result?.tools ?? []) as ToolDescriptor[];

test("a write connection sees every tool and a read-only connection only the read tools", async () => {
  const t = await setupApi();
  try {
    assert.deepEqual((await listed(A)).map((tool) => tool.name).sort(), [...READ_TOOLS, ...WRITE_TOOLS].sort());
    assert.equal(TOOLS.length, 16);
    const readOnly = await listed(READ_ONLY);
    assert.deepEqual(readOnly.map((tool) => tool.name).sort(), READ_TOOLS);
    assert.ok(readOnly.every((tool) => tool.annotations.readOnlyHint));
    assert.deepEqual(await listed(NO_SCOPE), []);
  } finally {
    t.close();
  }
});

test("annotations say which tools destroy data, reach outside, or are safe to repeat", async () => {
  const t = await setupApi();
  try {
    const byName = new Map((await listed(A)).map((tool) => [tool.name, tool.annotations]));
    const destructive = [...byName]
      .filter(([, a]) => a.destructiveHint)
      .map(([name]) => name)
      .sort();
    assert.deepEqual(destructive, ["delete_file", "revoke_share"]);
    const openWorld = [...byName].filter(([, a]) => a.openWorldHint).map(([name]) => name);
    assert.deepEqual(openWorld, ["import_from_url"]);
    for (const name of READ_TOOLS) assert.equal(byName.get(name)?.idempotentHint, true, name);
    for (const name of ["complete_upload", "set_file_expiry", "update_share", "delete_file", "revoke_share"]) {
      assert.equal(byName.get(name)?.idempotentHint, true, name);
    }
    for (const name of ["create_upload", "put_file", "import_from_url", "create_share"]) {
      assert.equal(byName.get(name)?.idempotentHint, false, name);
      assert.equal(byName.get(name)?.readOnlyHint, false, name);
    }
  } finally {
    t.close();
  }
});

test("no tool accepts a tenant or user id, and every input rejects unknown fields", async () => {
  const t = await setupApi();
  try {
    for (const tool of await listed(A)) {
      assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} is strict`);
      for (const field of Object.keys(tool.inputSchema.properties)) {
        assert.doesNotMatch(field, /tenant|user_id|workspace|object_key/, `${tool.name}.${field}`);
      }
    }
    const extra = await call(A, "get_usage", { tenant_id: "ten_b" });
    assert.equal(isToolError(extra), true);
    const stolen = await call(A, "put_file", { name: "x.txt", content: "x", tenant_id: "ten_b" });
    assert.equal(isToolError(stolen), true);
  } finally {
    t.close();
  }
});

test("the server instructions explain the three ways in and the two kinds of link", async () => {
  const t = await setupApi();
  try {
    const init = await rpc(A, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    const instructions = String(init.result?.instructions ?? "");
    assert.equal(instructions, SERVER_INSTRUCTIONS);
    for (const phrase of [
      "put_file",
      "create_upload",
      "complete_upload",
      "import_from_url",
      "get_download_link",
      "create_share",
      "generated password",
      "revoked",
      "not instructions",
    ]) {
      assert.ok(instructions.includes(phrase), phrase);
    }
  } finally {
    t.close();
  }
});

test("a file goes in with put_file and comes back through list, get, read, link and usage", async () => {
  const t = await setupApi();
  try {
    const put = await call(A, "put_file", { name: "notes.md", content: "# Xin chào\nline two" });
    assert.equal(isToolError(put), false);
    const file = structured<{ file: { id: string; size: number; mime: string; status: string } }>(put).file;
    assert.equal(file.status, "ready");
    assert.equal(file.mime, "text/markdown");
    assert.ok(!JSON.stringify(put).includes("object_key") && !JSON.stringify(put).includes("ten_a"));

    const list = structured<{ items: Array<{ id: string }>; next_cursor: string | null }>(await call(A, "list_files"));
    assert.deepEqual(
      list.items.map((item) => item.id),
      [file.id],
    );
    assert.equal(list.next_cursor, null);
    assert.equal(
      structured<{ file: { name: string } }>(await call(A, "get_file", { file_id: file.id })).file.name,
      "notes.md",
    );
    assert.deepEqual(structured(await call(A, "get_usage")), { files: 1, bytes: file.size });

    const read = await call(A, "read_file", { file_id: file.id });
    const blocks = read.result?.content as Array<{ type: string; text?: string }>;
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, "text");
    assert.match(blocks[0].text ?? "", /notes\.md \(text\/markdown, \d+ bytes\):\n\n# Xin chào\nline two$/);
    assert.deepEqual(structured(read), {
      kind: "text",
      name: "notes.md",
      mime: "text/markdown",
      size: file.size,
      text: "# Xin chào\nline two",
    });

    const link = structured<{ url: string; expires_at: string; disposition: string }>(
      await call(A, "get_download_link", { file_id: file.id, ttl_seconds: 300, disposition: "inline" }),
    );
    assert.equal(new URL(link.url).origin, "https://s3.test");
    assert.equal(new URL(link.url).searchParams.get("X-Amz-Expires"), "300");
    assert.equal(link.disposition, "attachment", "markdown is not shown inline");
  } finally {
    t.close();
  }
});

test("read_file returns an image as an MCP image block", async () => {
  const t = await setupApi();
  try {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    const put = structured<{ file: { id: string } }>(
      await call(A, "put_file", { name: "pic.png", content: bytes.toString("base64"), encoding: "base64" }),
    );
    const read = await call(A, "read_file", { file_id: put.file.id });
    const blocks = read.result?.content as Array<{ type: string; data?: string; mimeType?: string; text?: string }>;
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].type, "text");
    assert.match(blocks[0].text ?? "", /pic\.png \(image\/png, 8 bytes\)/);
    assert.equal(blocks[1].type, "image");
    assert.equal(blocks[1].mimeType, "image/png");
    assert.equal(blocks[1].data, bytes.toString("base64"));
    assert.deepEqual(
      structured(read),
      { kind: "image", name: "pic.png", mime: "image/png", size: 8 },
      "the bytes are not repeated",
    );

    const zip = structured<{ file: { id: string } }>(await call(A, "put_file", { name: "a.zip", content: "PK" }));
    const refused = await call(A, "read_file", { file_id: zip.file.id });
    assert.equal(isToolError(refused), true);
    assert.match(structured<{ message: string }>(refused).message, /get_download_link/);
  } finally {
    t.close();
  }
});

test("create_upload then a PUT then complete_upload stores the real size; repeating complete is safe", async () => {
  const t = await setupApi();
  try {
    const created = structured<{
      file_id: string;
      upload_url: string;
      method: string;
      headers: Record<string, string>;
      content_length: number;
      next_step: string;
    }>(await call(A, "create_upload", { name: "big.pdf", size: 6, mime: "application/pdf" }));
    assert.match(created.file_id, /^[a-z2-7]{26}$/);
    assert.equal(created.method, "PUT");
    assert.deepEqual(created.headers, { "content-type": "application/pdf" });
    assert.equal(created.content_length, 6);
    assert.match(created.next_step, /complete_upload/);
    assert.equal(
      new URL(created.upload_url).searchParams.get("X-Amz-SignedHeaders"),
      "content-length;content-type;host",
    );

    const early = await call(A, "complete_upload", { file_id: created.file_id });
    assert.equal(isToolError(early), true);
    assert.equal(structured<{ code: string }>(early).code, "UPLOAD_NOT_FOUND");
    assert.match(structured<{ message: string }>(early).message, /PUT the file/);

    const key = (
      await t.db.first<{ object_key: string }>("SELECT object_key FROM artifacts WHERE id = ?", [created.file_id])
    )?.object_key as string;
    t.store.objects.set(key, { bytes: new Uint8Array(6), contentType: "application/pdf" });
    const done = structured<{ file: { status: string; size: number } }>(
      await call(A, "complete_upload", { file_id: created.file_id }),
    );
    assert.deepEqual({ status: done.file.status, size: done.file.size }, { status: "ready", size: 6 });
    assert.equal(isToolError(await call(A, "complete_upload", { file_id: created.file_id })), false);

    const wrong = structured<{ file_id: string }>(await call(A, "create_upload", { name: "x.bin", size: 4 }));
    const wrongKey = (
      await t.db.first<{ object_key: string }>("SELECT object_key FROM artifacts WHERE id = ?", [wrong.file_id])
    )?.object_key as string;
    t.store.objects.set(wrongKey, { bytes: new Uint8Array(9), contentType: "application/octet-stream" });
    const mismatch = await call(A, "complete_upload", { file_id: wrong.file_id });
    assert.equal(structured<{ code: string }>(mismatch).code, "INVALID_INPUT");
    assert.deepEqual(structured<{ declared_size: number; uploaded_size: number }>(mismatch).uploaded_size, 9);
  } finally {
    t.close();
  }
});

test("import_from_url fetches a public file, and refuses a private address", async () => {
  const t = await setupApi();
  try {
    t.deps.fetch = (async () =>
      new Response("a,b\n1,2\n", { headers: { "content-type": "text/csv", "content-length": "8" } })) as typeof fetch;
    const out = structured<{ file: { name: string; mime: string; source: string; size: number } }>(
      await call(A, "import_from_url", {
        url: "https://example.com/data/table.csv",
        expires_in_days: 3,
        note: "from the web",
      }),
    );
    assert.deepEqual(
      {
        ...out.file,
        id: undefined,
        created_at: undefined,
        completed_at: undefined,
        expires_at: undefined,
        sha256: undefined,
        note: undefined,
        status: undefined,
      },
      {
        id: undefined,
        name: "table.csv",
        mime: "text/csv",
        size: 8,
        source: "url",
        created_at: undefined,
        completed_at: undefined,
        expires_at: undefined,
        sha256: undefined,
        note: undefined,
        status: undefined,
      },
    );
    const blocked = await call(A, "import_from_url", { url: "https://169.254.169.254/latest/meta-data/" });
    assert.equal(isToolError(blocked), true);
    assert.equal(structured<{ code: string }>(blocked).code, "INVALID_INPUT");
  } finally {
    t.close();
  }
});

test("set_file_expiry sets and clears an expiry; delete_file removes the file and can be repeated", async () => {
  const t = await setupApi();
  try {
    const { file } = structured<{ file: { id: string } }>(await call(A, "put_file", { name: "a.txt", content: "x" }));
    const set = structured<{ file: { expires_at: string | null } }>(
      await call(A, "set_file_expiry", { file_id: file.id, expires_in_days: 5 }),
    );
    assert.equal(set.file.expires_at, "2026-11-27T10:00:00.000Z");
    const cleared = structured<{ file: { expires_at: string | null } }>(
      await call(A, "set_file_expiry", { file_id: file.id, expires_in_days: null }),
    );
    assert.equal(cleared.file.expires_at, null);
    assert.equal(
      isToolError(await call(A, "set_file_expiry", { file_id: file.id })),
      true,
      "expires_in_days is required",
    );

    assert.deepEqual(structured(await call(A, "delete_file", { file_id: file.id })), { id: file.id, deleted: true });
    assert.deepEqual(structured(await call(A, "delete_file", { file_id: file.id })), { id: file.id, deleted: true });
    assert.equal(t.store.objects.size, 0);
    assert.equal(structured<{ code: string }>(await call(A, "get_file", { file_id: file.id })).code, "NOT_FOUND");
  } finally {
    t.close();
  }
});

test("the share tools create, list, show, change and revoke a link, and its url is built from APP_ORIGIN", async () => {
  const t = await setupApi();
  try {
    const one = structured<{ file: { id: string } }>(await call(A, "put_file", { name: "one.txt", content: "1" })).file
      .id;
    const two = structured<{ file: { id: string } }>(await call(A, "put_file", { name: "two.txt", content: "2" })).file
      .id;
    // The MCP request arrives on another host; the link still points at the app's own origin.
    const created = structured<{ share_id: string; url: string; password?: string; has_password: boolean }>(
      await call(
        A,
        "create_share",
        { file_ids: [one, two], title: "Both", password: "generate", expires_in_days: 7 },
        "https://proxy.example.net",
      ),
    );
    assert.equal(created.url, `${ORIGIN}/s/${created.share_id}`);
    assert.match(created.password ?? "", /^[A-HJ-NP-Z2-9]{16}$/);
    assert.equal(created.has_password, true);

    const list = structured<{ items: Array<{ id: string; url: string; has_password: boolean; item_count: number }> }>(
      await call(A, "list_shares"),
    );
    assert.equal(list.items.length, 1);
    assert.equal(list.items[0].url, `${ORIGIN}/s/${created.share_id}`);
    assert.equal(list.items[0].item_count, 2);
    assert.ok(!JSON.stringify(list).includes(created.password as string));

    const shown = structured<{ share: { items: Array<{ name: string }>; title: string | null } }>(
      await call(A, "get_share", { share_id: created.share_id }),
    );
    assert.deepEqual(
      shown.share.items.map((item) => item.name),
      ["one.txt", "two.txt"],
    );
    assert.ok(!JSON.stringify(shown).includes(created.password as string));

    const updated = structured<{ share: { title: string; has_password: boolean; url: string } }>(
      await call(A, "update_share", { share_id: created.share_id, title: "Renamed", password: null }),
    );
    assert.deepEqual(
      { title: updated.share.title, has_password: updated.share.has_password },
      { title: "Renamed", has_password: false },
    );
    assert.equal(updated.share.url, `${ORIGIN}/s/${created.share_id}`);
    assert.equal(
      isToolError(await call(A, "update_share", { share_id: created.share_id })),
      true,
      "needs a field to change",
    );

    const revoked = structured<{ share: { state: string } }>(
      await call(A, "revoke_share", { share_id: created.share_id }),
    );
    assert.equal(revoked.share.state, "revoked");
    assert.equal(
      structured<{ share: { state: string } }>(await call(A, "revoke_share", { share_id: created.share_id })).share
        .state,
      "revoked",
    );
    assert.equal(structured<{ items: unknown[] }>(await call(A, "list_shares")).items.length, 0);
    assert.equal(
      structured<{ items: unknown[] }>(await call(A, "list_shares", { include_revoked: true })).items.length,
      1,
    );
  } finally {
    t.close();
  }
});

test("a connection without write access cannot call a write tool, and one with no scope cannot call any", async () => {
  const t = await setupApi();
  try {
    const { file } = structured<{ file: { id: string } }>(await call(A, "put_file", { name: "a.txt", content: "x" }));
    const args: Record<string, Record<string, unknown>> = {
      create_upload: { name: "x", size: 1 },
      complete_upload: { file_id: file.id },
      put_file: { name: "x", content: "x" },
      import_from_url: { url: "https://example.com/x" },
      set_file_expiry: { file_id: file.id, expires_in_days: 1 },
      delete_file: { file_id: file.id },
      create_share: { file_ids: [file.id] },
      update_share: { share_id: "abcdefghijklmnopqrstuvwxyz", title: "x" },
      revoke_share: { share_id: "abcdefghijklmnopqrstuvwxyz" },
    };
    assert.deepEqual(Object.keys(args).sort(), WRITE_TOOLS);
    for (const [name, input] of Object.entries(args)) {
      const reply = (await call(READ_ONLY, name, input)) as {
        status: number;
        error?: unknown;
        error_description?: string;
      };
      // The SDK answers a missing scope with HTTP 403 and a scope challenge, before any tool code runs.
      assert.equal(reply.status, 403, name);
      assert.match(String(reply.error_description ?? ""), /artifacts:write/, name);
    }
    for (const name of READ_TOOLS) {
      const reply = (await call(NO_SCOPE, name, { file_id: file.id })) as {
        status: number;
        error_description?: string;
      };
      assert.equal(reply.status, 403, name);
      assert.match(String(reply.error_description ?? ""), /artifacts:read/, name);
    }
    // The service refuses on its own too, whatever the transport lets through.
    const { callTool } = await import("../src/lib/mcp/tool");
    for (const tool of TOOLS.filter((candidate) => candidate.scope === "artifacts:write")) {
      await assert.rejects(callTool(tool, args[tool.name], READ_ONLY), { code: "INSUFFICIENT_SCOPE" }, tool.name);
    }
    assert.equal(
      (await t.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM artifacts WHERE status = 'ready'"))?.n,
      1,
      "nothing changed",
    );
    assert.equal(t.store.objects.size, 1);
  } finally {
    t.close();
  }
});

test("failures come back as { code, message } with a hint, and details where there are any", async () => {
  const t = await setupApi();
  try {
    const shape = (reply: Awaited<ReturnType<typeof call>>) => {
      assert.equal(isToolError(reply), true);
      return structured<{ code: string; message: string; fields?: Array<{ path: string; message: string }> }>(reply);
    };
    const missing = shape(await call(A, "get_file", { file_id: "abcdefghijklmnopqrstuvwxyz" }));
    assert.equal(missing.code, "NOT_FOUND");
    assert.match(missing.message, /list_files/);

    const invalid = shape(await call(A, "get_file", { file_id: "../../etc/passwd" }));
    assert.equal(invalid.code, "VALIDATION_ERROR");
    assert.deepEqual(
      invalid.fields?.map((field) => field.path),
      ["file_id"],
    );
    assert.match(invalid.fields?.[0].message ?? "", /list_files/);
    const unknownField = shape(await call(A, "get_usage", { tenant_id: "ten_b" }));
    assert.equal(unknownField.code, "VALIDATION_ERROR");
    const outOfRange = shape(await call(A, "list_files", { limit: 500 }));
    assert.equal(outOfRange.fields?.[0].path, "limit");

    const tooBig = shape(await call({ ...A }, "create_upload", { name: "huge.bin", size: 5 * 1024 ** 3 + 1 }));
    assert.equal(tooBig.code, "TOO_LARGE");
    assert.match(tooBig.message, /create_upload|import_from_url/);

    t.deps.settings.maxInlineBytes = 10;
    const inline = shape(await call(A, "put_file", { name: "x.txt", content: "x".repeat(11) }));
    assert.equal(inline.code, "TOO_LARGE");
    assert.match(inline.message, /create_upload/);
    const badBase64 = shape(await call(A, "put_file", { name: "x.bin", content: "not base64!", encoding: "base64" }));
    assert.equal(badBase64.code, "INVALID_INPUT");
    assert.match(badBase64.message, /Correct the arguments/);

    t.deps.settings.enabled = false;
    const off = shape(await call(A, "put_file", { name: "x.txt", content: "x" }));
    assert.equal(off.code, "UPLOADS_DISABLED");
    assert.match(off.message, /do not retry/);
    assert.equal(isToolError(await call(A, "list_files")), false, "reads still work while uploads are off");
    t.deps.settings.enabled = true;

    t.deps.settings.maxInlineBytes = 4 * 1024 * 1024;
    const { file } = structured<{ file: { id: string } }>(await call(A, "put_file", { name: "a.txt", content: "x" }));
    t.store.faults.delete = true;
    const provider = shape(await call(A, "delete_file", { file_id: file.id }));
    assert.equal(provider.code, "PROVIDER_ERROR");
    assert.match(provider.message, /Try again/);
    t.store.faults.delete = false;

    const validation = shape(await call(A, "create_share", { file_ids: [] }));
    assert.equal(validation.code, "VALIDATION_ERROR");
  } finally {
    t.close();
  }
});

test("an unexpected failure is an INTERNAL_ERROR that does not leak its cause", async () => {
  const t = await setupApi();
  try {
    const realDb = t.services.artifacts.db;
    t.services.artifacts.db = {
      ...realDb,
      first: async () => {
        throw new Error("SQLITE_CORRUPT: secret internal detail at /srv/db");
      },
    } as typeof realDb;
    const reply = await call(A, "get_file", { file_id: "abcdefghijklmnopqrstuvwxyz" });
    assert.equal(isToolError(reply), true);
    const body = structured<{ code: string; message: string }>(reply);
    assert.equal(body.code, "INTERNAL_ERROR");
    assert.ok(!JSON.stringify(reply).includes("SQLITE") && !JSON.stringify(reply).includes("/srv/db"));
    t.services.artifacts.db = realDb;
  } finally {
    t.close();
  }
});

test("a 4 MB file fits in one put_file request, and a request over 6 MB is refused", async () => {
  const t = await setupApi();
  try {
    const four = Buffer.alloc(4 * 1024 * 1024, 7);
    const ok = await call(A, "put_file", { name: "four.bin", content: four.toString("base64"), encoding: "base64" });
    assert.equal(isToolError(ok), false, JSON.stringify(ok).slice(0, 200));
    assert.equal(structured<{ file: { size: number } }>(ok).file.size, four.length);
    const huge = Buffer.alloc(5 * 1024 * 1024, 7).toString("base64");
    const refused = await call(A, "put_file", {
      name: "huge.bin",
      content: `${huge}${huge.slice(0, 1024 * 1024)}`,
      encoding: "base64",
    });
    assert.ok(
      refused.status === 413 || refused.error || isToolError(refused),
      "the oversized request did not store anything",
    );
    assert.equal((await t.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM artifacts"))?.n, 1);
  } finally {
    t.close();
  }
});

test("another account sees none of the first account's files through any read tool", async () => {
  const t = await setupApi();
  try {
    const { file } = structured<{ file: { id: string } }>(
      await call(A, "put_file", { name: "mine.txt", content: "private" }),
    );
    assert.deepEqual(structured<{ items: unknown[] }>(await call(B, "list_files")).items, []);
    for (const name of ["get_file", "read_file", "get_download_link", "delete_file", "complete_upload"]) {
      const reply = await call(B, name, { file_id: file.id });
      assert.equal(structured<{ code: string }>(reply).code, "NOT_FOUND", name);
    }
    assert.equal(
      structured<{ file: { status: string } }>(await call(A, "get_file", { file_id: file.id })).file.status,
      "ready",
    );
  } finally {
    t.close();
  }
});
