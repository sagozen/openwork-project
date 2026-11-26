import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { z } from "zod";
import { ArtifactError, type ArtifactErrorCode } from "../src/lib/artifacts/errors";
import {
  type ArtifactDeps,
  completeUpload,
  createUpload,
  deleteArtifact,
  downloadLink,
  getArtifact,
  importFromUrl,
  listArtifacts,
  MAX_READ_IMAGE_BYTES,
  MAX_READ_TEXT_BYTES,
  putInline,
  readContent,
  setExpiry,
  usage,
} from "../src/lib/artifacts/service";
import { loadUploadSettings } from "../src/lib/artifacts/settings";
import { A, B, type FakeStorage, NO_SCOPE, READ_ONLY, setupArtifacts } from "./support/artifacts";

const rejectsWith = (promise: Promise<unknown>, code: ArtifactErrorCode) =>
  assert.rejects(promise, (error) => error instanceof ArtifactError && error.code === code, code);

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const DAY = 24 * 60 * 60 * 1000;

/** Puts the bytes where a presigned PUT would have put them. */
async function upload(deps: ArtifactDeps, store: FakeStorage, size: number, name = "report.pdf") {
  const created = await createUpload(deps, A, { name, size, mime: "application/pdf" });
  const row = await deps.db.first<{ object_key: string }>("SELECT object_key FROM artifacts WHERE id = ?", [
    created.artifact_id,
  ]);
  return {
    created,
    key: row?.object_key as string,
    put: (bytes: Uint8Array) => store.objects.set(row?.object_key as string, { bytes, contentType: "application/pdf" }),
  };
}

// -------------------------------------------------------------------------- presigned uploads

test("createUpload records a pending file with no expiry, and returns a presigned PUT pinned to the declared size", async () => {
  const { deps, db, close } = await setupArtifacts();
  try {
    const created = await createUpload(deps, A, { name: "Báo cáo.pdf", size: 1234, note: "q3" });
    assert.match(created.artifact_id, /^[a-z2-7]{26}$/);
    assert.equal(created.method, "PUT");
    assert.equal(created.content_length, 1234);
    assert.deepEqual(created.headers, { "content-type": "application/pdf" });
    const url = new URL(created.upload_url);
    assert.equal(url.origin, "https://s3.test");
    assert.equal(url.searchParams.get("X-Amz-SignedHeaders"), "content-length;content-type;host");
    assert.equal(created.expires_at, "2026-11-22T10:15:00.000Z");

    const row = await db.first<Record<string, unknown>>("SELECT * FROM artifacts WHERE id = ?", [created.artifact_id]);
    assert.equal(row?.status, "pending");
    assert.equal(row?.source, "presigned");
    assert.equal(row?.expires_at, null, "no default expiry: files are kept until deleted");
    assert.equal(row?.declared_size, 1234);
    assert.equal(row?.size, null);
    assert.equal(row?.tenant_id, "ten_a");
    assert.equal(row?.name, "Báo cáo.pdf");
    assert.match(String(row?.object_key), new RegExp(`^ma/ten_a/${created.artifact_id}/Báo cáo\\.pdf$`));
    assert.deepEqual(Object.keys(created).sort(), [
      "artifact_id",
      "content_length",
      "expires_at",
      "headers",
      "method",
      "upload_url",
    ]);
  } finally {
    close();
  }
});

test("createUpload applies an expiry only when one is given", async () => {
  const { deps, db, close } = await setupArtifacts();
  try {
    const created = await createUpload(deps, A, { name: "a.txt", size: 1, expires_in_days: 7 });
    const row = await db.first<{ expires_at: string }>("SELECT expires_at FROM artifacts WHERE id = ?", [
      created.artifact_id,
    ]);
    assert.equal(row?.expires_at, "2026-11-29T10:00:00.000Z");
  } finally {
    close();
  }
});

test("createUpload refuses more than 5 GB, bad input, and every upload while the kill switch is off", async () => {
  const { deps, close } = await setupArtifacts();
  try {
    await rejectsWith(createUpload(deps, A, { name: "big.bin", size: 5 * 1024 ** 3 + 1 }), "TOO_LARGE");
    await assert.doesNotReject(createUpload(deps, A, { name: "edge.bin", size: 5 * 1024 ** 3 }));
    for (const bad of [
      { name: "", size: 1 },
      { name: "x", size: -1 },
      { name: "x", size: 1.5 },
      { name: "x", size: 1, expires_in_days: 0 },
      { name: "x", size: 1, tenant_id: "ten_b" },
    ]) {
      await assert.rejects(createUpload(deps, A, bad as never), z.ZodError, JSON.stringify(bad));
    }
    await rejectsWith(
      createUpload({ ...deps, settings: { ...deps.settings, enabled: false } }, A, { name: "x", size: 1 }),
      "UPLOADS_DISABLED",
    );
  } finally {
    close();
  }
});

test("completeUpload says so when nothing was uploaded, and leaves the upload pending", async () => {
  const { deps, db, close } = await setupArtifacts();
  try {
    const created = await createUpload(deps, A, { name: "a.pdf", size: 10 });
    await rejectsWith(completeUpload(deps, A, created.artifact_id), "UPLOAD_NOT_FOUND");
    const row = await db.first<{ status: string }>("SELECT status FROM artifacts WHERE id = ?", [created.artifact_id]);
    assert.equal(row?.status, "pending");
  } finally {
    close();
  }
});

test("completeUpload records the object's real size, and is safe to repeat", async () => {
  const { deps, store, close } = await setupArtifacts();
  try {
    const { created, put } = await upload(deps, store, 5);
    put(new Uint8Array([1, 2, 3, 4, 5]));
    const done = await completeUpload(deps, A, created.artifact_id);
    assert.equal(done.status, "ready");
    assert.equal(done.size, 5);
    assert.equal(done.source, "presigned");
    assert.equal(done.expires_at, null);
    assert.deepEqual(await completeUpload(deps, A, created.artifact_id), done, "completing twice changes nothing");
  } finally {
    close();
  }
});

test("completeUpload discards an object whose size differs from the declared one", async () => {
  const { deps, store, db, close } = await setupArtifacts();
  try {
    const { created, key, put } = await upload(deps, store, 5);
    put(new Uint8Array(9));
    await assert.rejects(completeUpload(deps, A, created.artifact_id), (error) => {
      assert.ok(error instanceof ArtifactError);
      assert.equal(error.code, "INVALID_INPUT");
      assert.deepEqual(error.details, { declared_size: 5, uploaded_size: 9 });
      return true;
    });
    assert.equal(store.objects.has(key), false, "the object was deleted");
    const row = await db.first<{ status: string; deleted_at: string | null }>(
      "SELECT status, deleted_at FROM artifacts WHERE id = ?",
      [created.artifact_id],
    );
    assert.equal(row?.status, "deleted");
    assert.ok(row?.deleted_at);
    await rejectsWith(completeUpload(deps, A, created.artifact_id), "NOT_FOUND");
  } finally {
    close();
  }
});

// ----------------------------------------------------------------------------- inline uploads

test("putInline stores text with its sha256, defaulting to text/plain and no expiry", async () => {
  const { deps, store, close } = await setupArtifacts();
  try {
    const out = await putInline(deps, A, { name: "notes", content: "xin chào" });
    assert.equal(out.status, "ready");
    assert.equal(out.mime, "text/plain");
    assert.equal(out.size, Buffer.byteLength("xin chào"));
    assert.equal(out.sha256, sha256("xin chào"));
    assert.equal(out.source, "inline");
    assert.equal(out.expires_at, null);
    const stored = [...store.objects.values()][0];
    assert.equal(new TextDecoder().decode(stored.bytes), "xin chào");
    assert.equal(stored.contentType, "text/plain");
  } finally {
    close();
  }
});

test("putInline decodes base64 and takes the type from the extension when none is given", async () => {
  const { deps, store, close } = await setupArtifacts();
  try {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
    const out = await putInline(deps, A, {
      name: "pic.png",
      content: `${png.toString("base64")}\n`,
      encoding: "base64",
    });
    assert.equal(out.mime, "image/png");
    assert.equal(out.size, 8);
    assert.equal(out.sha256, sha256(png));
    assert.deepEqual([...[...store.objects.values()][0].bytes], [...png]);
    const unknown = await putInline(deps, A, {
      name: "blob",
      content: Buffer.from("x").toString("base64"),
      encoding: "base64",
    });
    assert.equal(unknown.mime, "application/octet-stream");
    const declared = await putInline(deps, A, {
      name: "data",
      content: "a,b",
      mime: "text/csv; charset=utf-8",
      expires_in_days: 30,
    });
    assert.equal(declared.mime, "text/csv");
    assert.equal(declared.expires_at, "2026-12-22T10:00:00.000Z");
  } finally {
    close();
  }
});

test("putInline rejects base64 that is not base64 and does not store anything", async () => {
  const { deps, store, close } = await setupArtifacts();
  try {
    for (const bad of ["not base64!", "abc$", "a", "ab=c", "====", "YQ=a"]) {
      await rejectsWith(putInline(deps, A, { name: "x", content: bad, encoding: "base64" }), "INVALID_INPUT");
    }
    assert.equal(store.objects.size, 0);
  } finally {
    close();
  }
});

test("putInline enforces the inline cap on text and on the decoded size of base64, before any storage call", async () => {
  const { deps, store, close } = await setupArtifacts({ settings: { maxInlineBytes: 100 } });
  try {
    await assert.doesNotReject(putInline(deps, A, { name: "ok.txt", content: "a".repeat(100) }));
    await rejectsWith(putInline(deps, A, { name: "x.txt", content: "a".repeat(101) }), "TOO_LARGE");
    // 34 characters are 102 bytes in UTF-8 (3 bytes each): fewer characters than the cap, more bytes.
    await rejectsWith(putInline(deps, A, { name: "x.txt", content: "€".repeat(34) }), "TOO_LARGE");
    await assert.doesNotReject(
      putInline(deps, A, { name: "ok.bin", content: Buffer.alloc(100).toString("base64"), encoding: "base64" }),
    );
    await rejectsWith(
      putInline(deps, A, { name: "x.bin", content: Buffer.alloc(101).toString("base64"), encoding: "base64" }),
      "TOO_LARGE",
    );
    assert.equal(store.objects.size, 2);
    await assert.rejects(putInline(deps, A, { name: "x", content: "x", encoding: "hex" as never }), z.ZodError);
    await rejectsWith(
      putInline({ ...deps, settings: { ...deps.settings, enabled: false } }, A, { name: "x", content: "x" }),
      "UPLOADS_DISABLED",
    );
  } finally {
    close();
  }
});

test("putInline removes the object again when its row cannot be written, and reports a storage failure", async () => {
  const { deps, store, db, close } = await setupArtifacts();
  try {
    store.faults.put = true;
    await rejectsWith(putInline(deps, A, { name: "x.txt", content: "x" }), "PROVIDER_ERROR");
    store.faults.put = false;
    // A tenant that does not exist breaks the foreign key after the object was stored.
    await assert.rejects(putInline(deps, { ...A, tenantId: "ten_missing" }, { name: "x.txt", content: "x" }));
    assert.equal(store.objects.size, 0, "no orphan object is left behind");
    assert.equal((await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM artifacts"))?.n, 0);
  } finally {
    close();
  }
});

// ------------------------------------------------------------------------------------- import

function source(body: string | Uint8Array, headers: Record<string, string> = {}, status = 200) {
  const calls: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response(body as BodyInit, { status, headers });
  }) as typeof fetch;
  return { calls, fetcher };
}

test("importFromUrl stores a public file: name from the URL, type from the response, counted length", async () => {
  const { deps, store, close } = await setupArtifacts();
  try {
    const body = "col1,col2\n1,2\n";
    const { fetcher, calls } = source(body, {
      "content-type": "text/csv; charset=utf-8",
      "content-length": String(body.length),
    });
    const out = await importFromUrl({ ...deps, fetch: fetcher }, A, {
      url: "https://example.com/files/D%E1%BB%AF%20li%E1%BB%87u.csv?token=abc",
    });
    assert.equal(calls.length, 1);
    assert.equal(out.name, "Dữ liệu.csv");
    assert.equal(out.mime, "text/csv");
    assert.equal(out.size, body.length);
    assert.equal(out.source, "url");
    assert.equal(out.status, "ready");
    assert.equal(out.expires_at, null);
    assert.equal(new TextDecoder().decode([...store.objects.values()][0].bytes), body);
  } finally {
    close();
  }
});

test("importFromUrl buffers a source that does not report its size, up to the cap", async () => {
  const { deps, store, close } = await setupArtifacts({ settings: { maxImportBytes: 50 } });
  try {
    const streamed = (text: string) =>
      (async () =>
        new Response(new Blob([text]).stream(), { headers: { "content-type": "text/plain" } })) as typeof fetch;
    const out = await importFromUrl({ ...deps, fetch: streamed("hello world") }, A, {
      url: "https://example.com/a.txt",
      name: "greeting.txt",
    });
    assert.equal(out.size, 11);
    assert.equal(out.name, "greeting.txt");
    await rejectsWith(
      importFromUrl({ ...deps, fetch: streamed("x".repeat(51)) }, A, { url: "https://example.com/big.txt" }),
      "TOO_LARGE",
    );
    assert.equal(store.objects.size, 1, "the oversized import left nothing behind");
  } finally {
    close();
  }
});

test("importFromUrl refuses a declared length over the cap without reading the body", async () => {
  const { deps, store, close } = await setupArtifacts({ settings: { maxImportBytes: 1000 } });
  try {
    let cancelled = false;
    const huge = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const fetcher = (async () => new Response(huge, { headers: { "content-length": "1001" } })) as typeof fetch;
    await rejectsWith(
      importFromUrl({ ...deps, fetch: fetcher }, A, { url: "https://example.com/big.bin" }),
      "TOO_LARGE",
    );
    assert.equal(cancelled, true, "the body was dropped unread");
    assert.equal(store.objects.size, 0);
  } finally {
    close();
  }
});

test("importFromUrl aborts a stream that outgrows what the source declared, and one that falls short", async () => {
  const { deps, store, close } = await setupArtifacts({ settings: { maxImportBytes: 1000 } });
  try {
    const lying = (declared: number, actual: number) =>
      (async () =>
        new Response(new Blob(["x".repeat(actual)]).stream(), {
          headers: { "content-length": String(declared) },
        })) as typeof fetch;
    await rejectsWith(
      importFromUrl({ ...deps, fetch: lying(10, 400) }, A, { url: "https://example.com/a.bin" }),
      "INVALID_INPUT",
    );
    await rejectsWith(
      importFromUrl({ ...deps, fetch: lying(400, 10) }, A, { url: "https://example.com/a.bin" }),
      "INVALID_INPUT",
    );
    assert.equal(store.objects.size, 0);
  } finally {
    close();
  }
});

test("importFromUrl aborts a streamed body past the cap even when the declared length was within it", async () => {
  const { deps, store, close } = await setupArtifacts({ settings: { maxImportBytes: 100 } });
  try {
    const fetcher = (async () =>
      new Response(new Blob(["x".repeat(500)]).stream(), { headers: { "content-length": "100" } })) as typeof fetch;
    await assert.rejects(
      importFromUrl({ ...deps, fetch: fetcher }, A, { url: "https://example.com/a.bin" }),
      (error) => {
        assert.ok(error instanceof ArtifactError);
        assert.ok(["TOO_LARGE", "INVALID_INPUT"].includes(error.code), error.code);
        return true;
      },
    );
    assert.equal(store.objects.size, 0);
  } finally {
    close();
  }
});

test("importFromUrl does not trust the length of a compressed response", async () => {
  const { deps, store, close } = await setupArtifacts();
  try {
    const fetcher = (async () =>
      new Response(new Blob(["hello"]).stream(), {
        headers: { "content-length": "3", "content-encoding": "gzip" },
      })) as typeof fetch;
    const out = await importFromUrl({ ...deps, fetch: fetcher }, A, { url: "https://example.com/a.txt" });
    assert.equal(out.size, 5);
    assert.equal(store.objects.size, 1);
  } finally {
    close();
  }
});

test("importFromUrl never fetches a private, loopback, metadata or non-https address", async () => {
  const { deps, store, close } = await setupArtifacts();
  try {
    const { fetcher, calls } = source("secret");
    const run = (url: string, over: Partial<ArtifactDeps> = {}) =>
      importFromUrl({ ...deps, fetch: fetcher, ...over }, A, { url });
    for (const url of [
      "https://127.0.0.1/x",
      "https://169.254.169.254/latest/meta-data/",
      "https://[::1]/x",
      "https://[::ffff:127.0.0.1]/x",
      "https://[fd00::1]/x",
      "https://10.1.2.3/x",
      "https://192.168.0.1/x",
      "https://2130706433/x",
      "https://0x7f.0.0.1/x",
      "https://localhost/x",
      "https://db.internal/x",
      "https://singlelabel/x",
      "http://example.com/x",
      "ftp://example.com/x",
      "file:///etc/passwd",
      "https://user:pass@example.com/x",
      "https://example.com:8443/x",
      "not a url",
    ]) {
      await rejectsWith(run(url), "INVALID_INPUT");
    }
    // A public-looking name that resolves to a private address is refused too, and so is a failed lookup.
    await rejectsWith(run("https://rebind.example.com/x", { resolveHost: async () => ["10.0.0.5"] }), "INVALID_INPUT");
    await rejectsWith(
      run("https://dual.example.com/x", { resolveHost: async () => ["93.184.216.34", "127.0.0.1"] }),
      "INVALID_INPUT",
    );
    await rejectsWith(
      run("https://gone.example.com/x", { resolveHost: async () => Promise.reject(new Error("nxdomain")) }),
      "INVALID_INPUT",
    );
    assert.equal(calls.length, 0, "nothing was fetched");
    assert.equal(store.objects.size, 0);
  } finally {
    close();
  }
});

test("importFromUrl checks every redirect hop again", async () => {
  const { deps, store, close } = await setupArtifacts();
  try {
    const hops: string[] = [];
    const redirecting = (map: Record<string, { status: number; location?: string; body?: string }>) =>
      (async (input: RequestInfo | URL) => {
        const url = String(input);
        hops.push(url);
        const step = map[url];
        if (!step) return new Response("missing", { status: 404 });
        return new Response(step.body ?? null, {
          status: step.status,
          headers: step.location ? { location: step.location } : {},
        });
      }) as typeof fetch;
    const run = (map: Parameters<typeof redirecting>[0], url = "https://a.example.com/start") =>
      importFromUrl({ ...deps, fetch: redirecting(map) }, A, { url });

    const ok = await run({
      "https://a.example.com/start": { status: 302, location: "/next" },
      "https://a.example.com/next": { status: 301, location: "https://b.example.com/final.txt" },
      "https://b.example.com/final.txt": { status: 200, body: "done" },
    });
    assert.equal(ok.name, "final.txt");
    assert.equal(ok.size, 4);

    hops.length = 0;
    await rejectsWith(
      run({ "https://a.example.com/start": { status: 302, location: "https://169.254.169.254/latest/meta-data/" } }),
      "INVALID_INPUT",
    );
    await rejectsWith(
      run({ "https://a.example.com/start": { status: 302, location: "http://b.example.com/x" } }),
      "INVALID_INPUT",
    );
    await rejectsWith(
      run({ "https://a.example.com/start": { status: 307, location: "https://[::1]/x" } }),
      "INVALID_INPUT",
    );
    await rejectsWith(
      run({ "https://a.example.com/start": { status: 302, location: "https://localhost/x" } }),
      "INVALID_INPUT",
    );
    await rejectsWith(run({ "https://a.example.com/start": { status: 302 } }), "INVALID_INPUT");
    assert.deepEqual([...new Set(hops)], ["https://a.example.com/start"], "no redirect target was ever fetched");

    const loop = { "https://a.example.com/start": { status: 302, location: "https://a.example.com/start" } };
    await rejectsWith(run(loop), "INVALID_INPUT");
    assert.equal(store.objects.size, 1);
  } finally {
    close();
  }
});

test("importFromUrl reports a source that answers with an error and imports nothing", async () => {
  const { deps, store, close } = await setupArtifacts();
  try {
    const { fetcher } = source("nope", {}, 404);
    await assert.rejects(
      importFromUrl({ ...deps, fetch: fetcher }, A, { url: "https://example.com/missing" }),
      (error) => {
        assert.ok(error instanceof ArtifactError);
        assert.equal(error.code, "INVALID_INPUT");
        assert.match(error.message, /HTTP 404/);
        return true;
      },
    );
    const unreachable = (async () => {
      throw new TypeError("connect ECONNREFUSED");
    }) as typeof fetch;
    await rejectsWith(
      importFromUrl({ ...deps, fetch: unreachable }, A, { url: "https://example.com/x" }),
      "INVALID_INPUT",
    );
    await rejectsWith(
      importFromUrl({ ...deps, settings: { ...deps.settings, enabled: false } }, A, { url: "https://example.com/x" }),
      "UPLOADS_DISABLED",
    );
    assert.equal(store.objects.size, 0);
  } finally {
    close();
  }
});

// -------------------------------------------------------------------------- list, get, usage

test("listArtifacts pages newest first, filters by status and name, and skips expired files", async () => {
  const { deps, time, close } = await setupArtifacts();
  try {
    const names = ["alpha.txt", "beta.txt", "100%_done.txt", "delta.txt", "epsilon.txt"];
    for (const name of names) {
      await putInline(deps, A, { name, content: name });
      time.advance(1000);
    }
    const first = await listArtifacts(deps, A, { limit: 2 });
    assert.deepEqual(
      first.items.map((item) => item.name),
      ["epsilon.txt", "delta.txt"],
    );
    assert.ok(first.next_cursor);
    const second = await listArtifacts(deps, A, { limit: 2, cursor: first.next_cursor as string });
    assert.deepEqual(
      second.items.map((item) => item.name),
      ["100%_done.txt", "beta.txt"],
    );
    const third = await listArtifacts(deps, A, { limit: 2, cursor: second.next_cursor as string });
    assert.deepEqual(
      third.items.map((item) => item.name),
      ["alpha.txt"],
    );
    assert.equal(third.next_cursor, null);

    assert.deepEqual(
      (await listArtifacts(deps, A, { query: "ta" })).items.map((item) => item.name),
      ["delta.txt", "beta.txt"],
    );
    assert.deepEqual(
      (await listArtifacts(deps, A, { query: "%" })).items.map((item) => item.name),
      ["100%_done.txt"],
      "% is not a wildcard",
    );
    assert.deepEqual(
      (await listArtifacts(deps, A, { query: "_" })).items.map((item) => item.name),
      ["100%_done.txt"],
      "_ is not a wildcard",
    );
    await rejectsWith(listArtifacts(deps, A, { cursor: "garbage" }), "INVALID_INPUT");
    await assert.rejects(listArtifacts(deps, A, { limit: 500 }), z.ZodError);

    await createUpload(deps, A, { name: "pending.pdf", size: 1 });
    assert.equal((await listArtifacts(deps, A, { status: "pending" })).items.length, 1);
    assert.equal((await listArtifacts(deps, A)).items.length, 5, "pending files are not in the default list");

    await putInline(deps, A, { name: "short-lived.txt", content: "x", expires_in_days: 1 });
    assert.equal((await listArtifacts(deps, A, { query: "short" })).items.length, 1);
    time.advance(2 * DAY);
    assert.equal((await listArtifacts(deps, A, { query: "short" })).items.length, 0, "an expired file is not listed");
  } finally {
    close();
  }
});

test("usage totals the ready, unexpired files", async () => {
  const { deps, time, close } = await setupArtifacts();
  try {
    assert.deepEqual(await usage(deps, A), { files: 0, bytes: 0 });
    await putInline(deps, A, { name: "a.txt", content: "12345" });
    await putInline(deps, A, { name: "b.txt", content: "123", expires_in_days: 1 });
    await createUpload(deps, A, { name: "pending.bin", size: 999 });
    await putInline(deps, B, { name: "other.txt", content: "xxxxxxxxxx" });
    assert.deepEqual(await usage(deps, A), { files: 2, bytes: 8 });
    time.advance(2 * DAY);
    assert.deepEqual(await usage(deps, A), { files: 1, bytes: 5 });
    assert.deepEqual(await usage(deps, B), { files: 1, bytes: 10 });
  } finally {
    close();
  }
});

// ------------------------------------------------------------------------- expiry and delete

test("setExpiry sets and clears the expiry, and an expired file counts as gone before cleanup runs", async () => {
  const { deps, time, close } = await setupArtifacts();
  try {
    const file = await putInline(deps, A, { name: "a.txt", content: "x" });
    assert.equal(file.expires_at, null);
    const set = await setExpiry(deps, A, file.id, { expires_in_days: 2 });
    assert.equal(set.expires_at, "2026-11-24T10:00:00.000Z");
    const cleared = await setExpiry(deps, A, file.id, { expires_in_days: null });
    assert.equal(cleared.expires_at, null);
    await assert.rejects(setExpiry(deps, A, file.id, { expires_in_days: 0 }), z.ZodError);
    await assert.rejects(setExpiry(deps, A, file.id, {} as never), z.ZodError);

    await setExpiry(deps, A, file.id, { expires_in_days: 1 });
    await assert.doesNotReject(getArtifact(deps, A, file.id));
    time.advance(2 * DAY);
    await rejectsWith(getArtifact(deps, A, file.id), "NOT_FOUND");
    await rejectsWith(downloadLink(deps, A, file.id), "NOT_FOUND");
    await rejectsWith(readContent(deps, A, file.id), "NOT_FOUND");
  } finally {
    close();
  }
});

test("deleteArtifact removes the object and the row, and can be repeated", async () => {
  const { deps, store, db, close } = await setupArtifacts();
  try {
    const file = await putInline(deps, A, { name: "a.txt", content: "x" });
    assert.equal(store.objects.size, 1);
    assert.deepEqual(await deleteArtifact(deps, A, file.id), { id: file.id, deleted: true });
    assert.equal(store.objects.size, 0);
    assert.deepEqual(await deleteArtifact(deps, A, file.id), { id: file.id, deleted: true }, "idempotent");
    assert.equal(store.log.deletes.length, 1, "the second call does not touch storage again");
    await rejectsWith(getArtifact(deps, A, file.id), "NOT_FOUND");
    const row = await db.first<{ status: string; deleted_at: string }>(
      "SELECT status, deleted_at FROM artifacts WHERE id = ?",
      [file.id],
    );
    assert.equal(row?.status, "deleted");
    assert.equal((await listArtifacts(deps, A, { status: "deleted" })).items.length, 1);
    await rejectsWith(deleteArtifact(deps, A, "abcdefghijklmnopqrstuvwxyz"), "NOT_FOUND");
    await rejectsWith(deleteArtifact(deps, A, "../../etc/passwd"), "NOT_FOUND");
  } finally {
    close();
  }
});

test("deleteArtifact leaves the file in place when storage fails, so it can be retried", async () => {
  const { deps, store, close } = await setupArtifacts();
  try {
    const file = await putInline(deps, A, { name: "a.txt", content: "x" });
    store.faults.delete = true;
    await rejectsWith(deleteArtifact(deps, A, file.id), "PROVIDER_ERROR");
    assert.equal((await getArtifact(deps, A, file.id)).status, "ready");
    store.faults.delete = false;
    await deleteArtifact(deps, A, file.id);
    assert.equal(store.objects.size, 0);
  } finally {
    close();
  }
});

test("deleteArtifact drops the file from every share it was in", async () => {
  const { deps, db, close } = await setupArtifacts();
  try {
    const keep = await putInline(deps, A, { name: "keep.txt", content: "k" });
    const drop = await putInline(deps, A, { name: "drop.txt", content: "d" });
    await db.run("INSERT INTO shares (id, tenant_id, created_at) VALUES ('s1', 'ten_a', '2026-11-22T10:00:00.000Z')");
    await db.run(
      "INSERT INTO share_items (share_id, tenant_id, artifact_id, position) VALUES ('s1', 'ten_a', ?, 0), ('s1', 'ten_a', ?, 1)",
      [keep.id, drop.id],
    );
    await deleteArtifact(deps, A, drop.id);
    const left = await db.all<{ artifact_id: string }>("SELECT artifact_id FROM share_items WHERE share_id = 's1'");
    assert.deepEqual(
      left.map((row) => row.artifact_id),
      [keep.id],
    );
  } finally {
    close();
  }
});

// --------------------------------------------------------------------- links and reading

test("downloadLink mints a presigned GET with the requested lifetime and never inline for unsafe types", async () => {
  const { deps, close } = await setupArtifacts();
  try {
    const pdf = await putInline(deps, A, { name: "Báo cáo.pdf", content: "%PDF", mime: "application/pdf" });
    const inline = await downloadLink(deps, A, pdf.id, { disposition: "inline", ttl_seconds: 120 });
    const url = new URL(inline.url);
    assert.equal(inline.disposition, "inline");
    assert.equal(inline.name, "Báo cáo.pdf");
    assert.equal(url.searchParams.get("X-Amz-Expires"), "120");
    assert.equal(inline.expires_at, "2026-11-22T10:02:00.000Z");
    assert.match(
      url.searchParams.get("response-content-disposition") ?? "",
      /^inline; filename=".*"; filename\*=UTF-8''B%C3%A1o%20c%C3%A1o\.pdf$/,
    );

    const defaults = await downloadLink(deps, A, pdf.id);
    assert.equal(defaults.disposition, "attachment");
    assert.equal(new URL(defaults.url).searchParams.get("X-Amz-Expires"), "3600");

    const html = await putInline(deps, A, { name: "page.html", content: "<script>alert(1)</script>" });
    const forced = await downloadLink(deps, A, html.id, { disposition: "inline" });
    assert.equal(forced.disposition, "attachment");
    assert.match(new URL(forced.url).searchParams.get("response-content-disposition") ?? "", /^attachment;/);

    for (const bad of [
      { ttl_seconds: 59 },
      { ttl_seconds: 604_801 },
      { ttl_seconds: 1.5 },
      { disposition: "preview" },
    ]) {
      await assert.rejects(downloadLink(deps, A, pdf.id, bad as never), z.ZodError, JSON.stringify(bad));
    }
    const pending = await createUpload(deps, A, { name: "p.pdf", size: 1 });
    await rejectsWith(downloadLink(deps, A, pending.artifact_id), "NOT_FOUND");
  } finally {
    close();
  }
});

test("readContent returns small text and images, and refuses everything else with a pointer to a link", async () => {
  const { deps, store, close } = await setupArtifacts();
  try {
    const text = await putInline(deps, A, { name: "notes.md", content: "# Xin chào" });
    assert.deepEqual(await readContent(deps, A, text.id), {
      kind: "text",
      text: "# Xin chào",
      name: "notes.md",
      mime: "text/markdown",
      size: Buffer.byteLength("# Xin chào"),
    });

    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const image = await putInline(deps, A, { name: "pic.png", content: bytes.toString("base64"), encoding: "base64" });
    const read = await readContent(deps, A, image.id);
    assert.equal(read.kind, "image");
    assert.equal(read.kind === "image" && read.data, bytes.toString("base64"));

    const json = await putInline(deps, A, { name: "data.json", content: '{"a":1}' });
    assert.equal((await readContent(deps, A, json.id)).kind, "text");

    const zip = await putInline(deps, A, { name: "a.zip", content: "PK", encoding: "text" });
    await assert.rejects(readContent(deps, A, zip.id), (error) => {
      assert.ok(error instanceof ArtifactError);
      assert.equal(error.code, "INVALID_INPUT");
      assert.match(error.message, /get_download_link/);
      return true;
    });

    // Over the limits: the recorded size decides before anything is read.
    const bigText = await putInline(deps, A, { name: "big.txt", content: "x" });
    await deps.db.run("UPDATE artifacts SET size = ? WHERE id = ?", [MAX_READ_TEXT_BYTES + 1, bigText.id]);
    await rejectsWith(readContent(deps, A, bigText.id), "TOO_LARGE");
    const bigImage = await putInline(deps, A, { name: "big.png", content: "x" });
    await deps.db.run("UPDATE artifacts SET size = ? WHERE id = ?", [MAX_READ_IMAGE_BYTES + 1, bigImage.id]);
    await rejectsWith(readContent(deps, A, bigImage.id), "TOO_LARGE");

    // An object bigger than its recorded size is still never read past the limit.
    const lying = await putInline(deps, A, { name: "lying.txt", content: "x" });
    const key = (
      await deps.db.first<{ object_key: string }>("SELECT object_key FROM artifacts WHERE id = ?", [lying.id])
    )?.object_key as string;
    store.objects.set(key, { bytes: new Uint8Array(MAX_READ_TEXT_BYTES + 10), contentType: "text/plain" });
    await rejectsWith(readContent(deps, A, lying.id), "TOO_LARGE");
  } finally {
    close();
  }
});

// ------------------------------------------------------------------------- scopes, isolation

test("a connection needs the scope for what it does; write implies read", async () => {
  const { deps, close } = await setupArtifacts();
  try {
    const file = await putInline(deps, A, { name: "a.txt", content: "x" });
    await assert.doesNotReject(listArtifacts(deps, READ_ONLY));
    await assert.doesNotReject(getArtifact(deps, READ_ONLY, file.id));
    await assert.doesNotReject(downloadLink(deps, READ_ONLY, file.id));
    await assert.doesNotReject(readContent(deps, READ_ONLY, file.id));
    await assert.doesNotReject(usage(deps, READ_ONLY));
    await rejectsWith(putInline(deps, READ_ONLY, { name: "x", content: "x" }), "INSUFFICIENT_SCOPE");
    await rejectsWith(createUpload(deps, READ_ONLY, { name: "x", size: 1 }), "INSUFFICIENT_SCOPE");
    await rejectsWith(importFromUrl(deps, READ_ONLY, { url: "https://example.com/x" }), "INSUFFICIENT_SCOPE");
    await rejectsWith(completeUpload(deps, READ_ONLY, file.id), "INSUFFICIENT_SCOPE");
    await rejectsWith(setExpiry(deps, READ_ONLY, file.id, { expires_in_days: 1 }), "INSUFFICIENT_SCOPE");
    await rejectsWith(deleteArtifact(deps, READ_ONLY, file.id), "INSUFFICIENT_SCOPE");
    await rejectsWith(listArtifacts(deps, NO_SCOPE), "INSUFFICIENT_SCOPE");
    await rejectsWith(putInline(deps, NO_SCOPE, { name: "x", content: "x" }), "INSUFFICIENT_SCOPE");
  } finally {
    close();
  }
});

test("another account cannot see, change, read, link or delete a file, whatever it passes as the id", async () => {
  const { deps, store, close } = await setupArtifacts();
  try {
    const mine = await putInline(deps, A, { name: "mine.txt", content: "secret" });
    const pending = await createUpload(deps, A, { name: "pending.bin", size: 3 });
    await rejectsWith(getArtifact(deps, B, mine.id), "NOT_FOUND");
    await rejectsWith(downloadLink(deps, B, mine.id), "NOT_FOUND");
    await rejectsWith(readContent(deps, B, mine.id), "NOT_FOUND");
    await rejectsWith(setExpiry(deps, B, mine.id, { expires_in_days: 1 }), "NOT_FOUND");
    await rejectsWith(deleteArtifact(deps, B, mine.id), "NOT_FOUND");
    await rejectsWith(completeUpload(deps, B, pending.artifact_id), "NOT_FOUND");
    assert.equal((await listArtifacts(deps, B)).items.length, 0);
    assert.deepEqual(await usage(deps, B), { files: 0, bytes: 0 });
    assert.equal(store.objects.size, 1, "nothing was deleted");
    assert.equal((await getArtifact(deps, A, mine.id)).status, "ready");
    const theirs = await putInline(deps, B, { name: "mine.txt", content: "b" });
    assert.notEqual(theirs.id, mine.id);
    assert.equal((await listArtifacts(deps, A)).items.length, 1);
  } finally {
    close();
  }
});

// ------------------------------------------------------------------------------------ settings

test("upload settings come from the admin table, fall back to the defaults, and are clamped", async () => {
  const { db, close } = await setupArtifacts();
  try {
    assert.deepEqual(await loadUploadSettings(db), {
      enabled: true,
      maxInlineBytes: 4 * 1024 * 1024,
      maxImportBytes: 100 * 1024 * 1024,
    });
    const set = (key: string, value: unknown) =>
      db.run(
        "INSERT OR REPLACE INTO admin_settings (key, value_json, updated_at) VALUES (?, ?, '2026-11-22T00:00:00Z')",
        [key, JSON.stringify(value)],
      );
    await set("uploads.enabled", false);
    await set("uploads.max_inline_bytes", 1000);
    await set("uploads.max_import_bytes", 10 * 1024 ** 3);
    assert.deepEqual(await loadUploadSettings(db), {
      enabled: false,
      maxInlineBytes: 1000,
      maxImportBytes: 500 * 1024 * 1024,
    });
    await set("uploads.max_inline_bytes", 50 * 1024 * 1024);
    assert.equal(
      (await loadUploadSettings(db)).maxInlineBytes,
      4 * 1024 * 1024,
      "inline never promises more than one MCP request carries",
    );
    await set("uploads.max_inline_bytes", -5);
    await set("uploads.max_import_bytes", "lots");
    const bad = await loadUploadSettings(db);
    assert.equal(bad.maxInlineBytes, 4 * 1024 * 1024);
    assert.equal(bad.maxImportBytes, 100 * 1024 * 1024);
  } finally {
    close();
  }
});
