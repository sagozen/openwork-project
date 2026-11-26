import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { test } from "node:test";
import {
  ARTIFACT_ID_PATTERN,
  contentDisposition,
  encodeRfc3986,
  FALLBACK_FILENAME,
  MAX_FILENAME_CHARS,
  newArtifactId,
  objectKey,
  sanitizeFilename,
  tenantPrefix,
} from "../src/lib/storage/keys";
import { essence, isInlineSafe, mimeForExtension, resolveMime } from "../src/lib/storage/mime";
import {
  createStorage,
  MAX_PRESIGN_GET_SECONDS,
  MAX_PRESIGN_PUT_BYTES,
  MIN_PRESIGN_GET_SECONDS,
  PRESIGN_PUT_SECONDS,
  StorageError,
  storageFromEnv,
} from "../src/lib/storage/s3";

const ENDPOINT = "https://usc1.contabostorage.com";
const HOST = "usc1.contabostorage.com";
const REGION = "usc1";
const BUCKET = "myartifact";
const ACCESS_KEY = "AKIATESTKEY";
const SECRET_KEY = "test-secret-key-not-real";
const NOW = new Date("2026-11-22T10:30:15.000Z");
const ID = "abcdefghijklmnopqrstuvwxyz".slice(0, 26);

interface Call {
  request: Request;
  body: string;
}

/** A transport that records every request and answers from `reply`. */
function fakeTransport(reply: (call: Call) => Response) {
  const calls: Call[] = [];
  const transport = async (request: Request) => {
    const call = { request, body: request.body ? await request.clone().text() : "" };
    calls.push(call);
    return reply(call);
  };
  return { calls, transport };
}

const storage = (transport?: (request: Request) => Promise<Response>) =>
  createStorage({
    endpoint: ENDPOINT,
    region: REGION,
    bucket: BUCKET,
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
    fetch: transport,
    now: () => NOW,
  });

// --- An independent SigV4 query-signing implementation, so the signature is checked and not merely present. ---

const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data).digest();
const sha256Hex = (data: string) => createHash("sha256").update(data).digest("hex");

function referenceSignature(options: {
  method: string;
  key: string;
  query: Record<string, string>;
  signedHeaders: Record<string, string>;
  datetime: string;
}): string {
  const date = options.datetime.slice(0, 8);
  const scope = `${date}/${REGION}/s3/aws4_request`;
  const headers = { host: HOST, ...options.signedHeaders };
  const names = Object.keys(headers).sort();
  const query: Record<string, string> = {
    ...options.query,
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${ACCESS_KEY}/${scope}`,
    "X-Amz-Date": options.datetime,
    "X-Amz-SignedHeaders": names.join(";"),
  };
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((name) => `${encodeRfc3986(name)}=${encodeRfc3986(query[name])}`)
    .join("&");
  const canonicalUri = `/${BUCKET}/${options.key.split("/").map(encodeRfc3986).join("/")}`;
  const canonicalRequest = [
    options.method,
    canonicalUri,
    canonicalQuery,
    `${names.map((name) => `${name}:${headers[name as keyof typeof headers]}`).join("\n")}\n`,
    names.join(";"),
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", options.datetime, scope, sha256Hex(canonicalRequest)].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${SECRET_KEY}`, date), REGION), "s3"), "aws4_request");
  return createHmac("sha256", signingKey).update(stringToSign).digest("hex");
}

const DATETIME = "20261122T103015Z";

// ----------------------------------------------------------------------------------------- keys

test("artifact ids are 26 base32 characters and do not repeat", () => {
  const ids = new Set(Array.from({ length: 200 }, newArtifactId));
  assert.equal(ids.size, 200);
  for (const id of ids) assert.match(id, ARTIFACT_ID_PATTERN);
  assert.equal(ARTIFACT_ID_PATTERN.test("ABCDEFGHIJKLMNOPQRSTUVWXYZ"), false);
  assert.equal(ARTIFACT_ID_PATTERN.test("abc"), false);
});

test("sanitizeFilename keeps the base name, drops control and direction characters and never returns empty", () => {
  assert.equal(sanitizeFilename("report.pdf"), "report.pdf");
  assert.equal(sanitizeFilename("../../etc/passwd"), "passwd");
  assert.equal(sanitizeFilename("C:\\Users\\me\\budget.xlsx"), "budget.xlsx");
  assert.equal(sanitizeFilename("a\u0000b\u0007c\u007fd.txt"), "abcd.txt");
  assert.equal(sanitizeFilename("invoice\u202Efdp.exe"), "invoicefdp.exe");
  assert.equal(sanitizeFilename("  spaced   out  .txt  "), "spaced out .txt");
  assert.equal(sanitizeFilename("trailing dots..."), "trailing dots");
  assert.equal(sanitizeFilename(".htaccess"), "htaccess");
  for (const empty of ["", "   ", ".", "..", "/", "\\\\", "\u0000\u0001", "...."]) {
    assert.equal(sanitizeFilename(empty), FALLBACK_FILENAME, JSON.stringify(empty));
  }
  // Vietnamese: composed (NFC) whatever the input form.
  const decomposed = "Ba\u0301o ca\u0301o thu\u0301 nghiê\u0323m.docx";
  assert.equal(sanitizeFilename(decomposed), "Báo cáo thú nghiệm.docx");
  assert.equal(sanitizeFilename(decomposed), sanitizeFilename("Báo cáo thú nghiệm.docx"));
});

test("sanitizeFilename caps the length at 200 characters and keeps the extension", () => {
  const long = `${"a".repeat(300)}.pdf`;
  const cut = sanitizeFilename(long);
  assert.equal(Array.from(cut).length, MAX_FILENAME_CHARS);
  assert.ok(cut.endsWith(".pdf"));
  const wide = `${"ệ".repeat(250)}.txt`;
  assert.equal(Array.from(sanitizeFilename(wide)).length, MAX_FILENAME_CHARS);
  assert.ok(sanitizeFilename(wide).endsWith(".txt"));
  // A huge "extension" is not preserved: it is just more name.
  const noExtension = sanitizeFilename(`name.${"x".repeat(300)}`);
  assert.equal(Array.from(noExtension).length, MAX_FILENAME_CHARS);
  // Astral characters are not split in half.
  const emoji = sanitizeFilename("😀".repeat(250));
  assert.equal(Array.from(emoji).length, MAX_FILENAME_CHARS);
  assert.doesNotMatch(emoji, /[\ud800-\udbff](?![\udc00-\udfff])/);
});

test("objectKey builds ma/<tenant>/<id>/<name> and rejects a tenant or id that could change the path", () => {
  assert.equal(objectKey("ten_1", ID, "a/b.txt"), `ma/ten_1/${ID}/b.txt`);
  assert.equal(tenantPrefix("ten_1"), "ma/ten_1/");
  assert.throws(() => objectKey("ten/1", ID, "x"), /tenant/);
  assert.throws(() => objectKey("", ID, "x"), /tenant/);
  assert.throws(() => objectKey("ten_1", "../../x", "x"), /artifact id/);
  assert.throws(() => objectKey("ten_1", ID.toUpperCase(), "x"), /artifact id/);
});

test("contentDisposition carries an ASCII fallback and the real UTF-8 name", () => {
  assert.equal(
    contentDisposition("attachment", "report.pdf"),
    `attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`,
  );
  const vi = contentDisposition("inline", "Báo cáo (final).pdf");
  assert.equal(vi, `inline; filename="B_o c_o (final).pdf"; filename*=UTF-8''B%C3%A1o%20c%C3%A1o%20%28final%29.pdf`);
  const hostile = contentDisposition("attachment", `a"b;c%d'e*f.txt`);
  assert.equal(hostile, `attachment; filename="a_b;c_d'e*f.txt"; filename*=UTF-8''a%22b%3Bc%25d%27e%2Af.txt`);
  // A path in the name is reduced to its last part before it reaches a header.
  assert.equal(
    contentDisposition("attachment", `x\\y"z.txt`),
    `attachment; filename="y_z.txt"; filename*=UTF-8''y%22z.txt`,
  );
  assert.ok(!/[\r\n]/.test(contentDisposition("attachment", "x\r\nSet-Cookie: a=b")));
});

// ----------------------------------------------------------------------------------------- mime

test("resolveMime prefers a real declared type, then the extension, then the generic type", () => {
  assert.equal(resolveMime("image/PNG; charset=binary", "x.bin"), "image/png");
  assert.equal(resolveMime("application/octet-stream", "photo.JPG"), "image/jpeg");
  assert.equal(resolveMime(undefined, "notes.md"), "text/markdown");
  assert.equal(resolveMime("", "archive"), "application/octet-stream");
  assert.equal(resolveMime("application/octet-stream", "mystery.zzz"), "application/octet-stream");
  assert.equal(resolveMime("not a mime\r\nX: y", "clip.mp4"), "video/mp4");
  assert.equal(essence("text/plain; charset=utf-8"), "text/plain");
  assert.equal(essence("text"), null);
  assert.equal(mimeForExtension("noextension"), null);
  assert.equal(mimeForExtension(".hidden"), null);
  assert.equal(mimeForExtension("trailing."), null);
});

test("only the safe types may be shown inline; HTML, SVG, XML, scripts and archives never are", () => {
  for (const safe of [
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
    "application/pdf",
    "text/plain",
    "text/plain; charset=utf-8",
    "video/mp4",
    "audio/mpeg",
    "VIDEO/webm",
  ]) {
    assert.equal(isInlineSafe(safe), true, safe);
  }
  for (const unsafe of [
    "text/html",
    "application/xhtml+xml",
    "image/svg+xml",
    "application/xml",
    "text/xml",
    "text/javascript",
    "application/javascript",
    "application/x-msdownload",
    "application/zip",
    "text/markdown",
    "application/octet-stream",
    "video/",
    "videos/mp4",
    "",
    null,
    undefined,
  ]) {
    assert.equal(isInlineSafe(unsafe), false, String(unsafe));
  }
});

// ----------------------------------------------------------------------------------- presigning

const NASTY_KEY = objectKey("ten_1", ID, "Báo cáo (final) #1 & 100%!'*+~ [v2].pdf");

test("path-style URLs encode spaces, Vietnamese and reserved characters in the key", async () => {
  assert.equal(NASTY_KEY.startsWith(`ma/ten_1/${ID}/Báo cáo (final)`), true);
  const { url } = await storage().presignGet(NASTY_KEY, { filename: "x.pdf", contentType: "application/pdf" });
  const parsed = new URL(url);
  assert.equal(parsed.origin, ENDPOINT);
  assert.equal(
    parsed.pathname,
    `/${BUCKET}/ma/ten_1/${ID}/B%C3%A1o%20c%C3%A1o%20%28final%29%20%231%20%26%20100%25%21%27%2A%2B~%20%5Bv2%5D.pdf`,
  );
  assert.equal(decodeURIComponent(parsed.pathname), `/${BUCKET}/${NASTY_KEY}`);
});

test("presignGet signs the expected query and its signature matches an independent SigV4 computation", async () => {
  const result = await storage().presignGet(NASTY_KEY, {
    filename: "Báo cáo.pdf",
    contentType: "application/pdf",
    disposition: "inline",
    ttl: 3600,
  });
  const url = new URL(result.url);
  assert.equal(result.method, "GET");
  assert.deepEqual(result.headers, {});
  assert.equal(result.disposition, "inline");
  assert.equal(result.expiresAt, "2026-11-22T11:30:15.000Z");
  assert.equal(url.searchParams.get("X-Amz-Algorithm"), "AWS4-HMAC-SHA256");
  assert.equal(url.searchParams.get("X-Amz-Credential"), `${ACCESS_KEY}/20261122/${REGION}/s3/aws4_request`);
  assert.equal(url.searchParams.get("X-Amz-Date"), DATETIME);
  assert.equal(url.searchParams.get("X-Amz-Expires"), "3600");
  assert.equal(url.searchParams.get("X-Amz-SignedHeaders"), "host");
  assert.equal(url.searchParams.get("response-content-type"), "application/pdf");
  assert.equal(
    url.searchParams.get("response-content-disposition"),
    `inline; filename="B_o c_o.pdf"; filename*=UTF-8''B%C3%A1o%20c%C3%A1o.pdf`,
  );
  const expected = referenceSignature({
    method: "GET",
    key: NASTY_KEY,
    query: {
      "X-Amz-Expires": "3600",
      "response-content-type": "application/pdf",
      "response-content-disposition": `inline; filename="B_o c_o.pdf"; filename*=UTF-8''B%C3%A1o%20c%C3%A1o.pdf`,
    },
    signedHeaders: {},
    datetime: DATETIME,
  });
  assert.equal(url.searchParams.get("X-Amz-Signature"), expected);
  // Nothing secret travels in the URL.
  assert.ok(!result.url.includes(SECRET_KEY));
});

test("presignGet clamps the lifetime to 60 seconds through 7 days and defaults to one hour", async () => {
  const ttl = async (value: number | undefined) =>
    new URL(
      (await storage().presignGet("ma/t/k/f.txt", { filename: "f.txt", contentType: "text/plain", ttl: value })).url,
    ).searchParams.get("X-Amz-Expires");
  assert.equal(await ttl(1), String(MIN_PRESIGN_GET_SECONDS));
  assert.equal(await ttl(-50), String(MIN_PRESIGN_GET_SECONDS));
  assert.equal(await ttl(60), "60");
  assert.equal(await ttl(86_400.9), "86400");
  assert.equal(await ttl(MAX_PRESIGN_GET_SECONDS), String(MAX_PRESIGN_GET_SECONDS));
  assert.equal(await ttl(10 * 24 * 3600), String(MAX_PRESIGN_GET_SECONDS));
  assert.equal(await ttl(undefined), "3600");
  assert.equal(await ttl(Number.NaN), "3600");
  assert.equal(await ttl(Number.POSITIVE_INFINITY), "3600");
  const capped = await storage().presignGet("ma/t/k/f.txt", {
    filename: "f.txt",
    contentType: "text/plain",
    ttl: 99 * 86_400,
  });
  assert.equal(capped.expiresAt, new Date(NOW.getTime() + MAX_PRESIGN_GET_SECONDS * 1000).toISOString());
});

test("presignGet forces an attachment for any type a browser could run, even when inline is asked for", async () => {
  const get = (contentType: string, disposition?: "inline" | "attachment") =>
    storage().presignGet("ma/t/k/f", { filename: "page.html", contentType, disposition });
  for (const unsafe of ["text/html", "image/svg+xml", "application/xml", "application/zip"]) {
    const result = await get(unsafe, "inline");
    assert.equal(result.disposition, "attachment", unsafe);
    assert.match(new URL(result.url).searchParams.get("response-content-disposition") ?? "", /^attachment;/);
    assert.equal(new URL(result.url).searchParams.get("response-content-type"), unsafe);
  }
  assert.equal((await get("image/png", "inline")).disposition, "inline");
  assert.equal((await get("image/png")).disposition, "attachment", "attachment is the default");
  assert.equal((await get("garbage value")).disposition, "attachment");
  assert.equal(
    new URL((await get("garbage value")).url).searchParams.get("response-content-type"),
    "application/octet-stream",
  );
});

test("presignPut is valid for 15 minutes and signs content-type and content-length", async () => {
  const result = await storage().presignPut(NASTY_KEY, {
    contentType: "Application/PDF; charset=x",
    contentLength: 1_234_567,
  });
  const url = new URL(result.url);
  assert.equal(result.method, "PUT");
  assert.equal(PRESIGN_PUT_SECONDS, 900);
  assert.equal(url.searchParams.get("X-Amz-Expires"), "900");
  assert.equal(result.expiresAt, "2026-11-22T10:45:15.000Z");
  assert.equal(url.searchParams.get("X-Amz-SignedHeaders"), "content-length;content-type;host");
  assert.deepEqual(result.headers, { "content-type": "application/pdf" }, "the client sets content-length itself");
  assert.equal(
    url.searchParams.get("X-Amz-Signature"),
    referenceSignature({
      method: "PUT",
      key: NASTY_KEY,
      query: { "X-Amz-Expires": "900" },
      signedHeaders: { "content-type": "application/pdf", "content-length": "1234567" },
      datetime: DATETIME,
    }),
  );
  // A different declared size or type gives a different signature, so the client cannot swap them.
  const other = await storage().presignPut(NASTY_KEY, { contentType: "application/pdf", contentLength: 1_234_568 });
  assert.notEqual(new URL(other.url).searchParams.get("X-Amz-Signature"), url.searchParams.get("X-Amz-Signature"));
});

test("presignPut refuses a size outside 0 bytes to 5 GB and a content type that is not a media type", async () => {
  const put = (contentLength: number, contentType = "text/plain") =>
    storage().presignPut("ma/t/k/f", { contentType, contentLength });
  await assert.doesNotReject(put(0));
  await assert.doesNotReject(put(MAX_PRESIGN_PUT_BYTES));
  for (const size of [-1, MAX_PRESIGN_PUT_BYTES + 1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(put(size), StorageError, String(size));
  }
  await assert.rejects(put(10, "text/plain\r\nX-Evil: 1"), /content type/i);
  await assert.rejects(put(10, ""), /content type/i);
});

test("keys that could escape the prefix or break a URL are refused before anything is signed", async () => {
  for (const key of ["", "/leading", "a//b", "a/../b", "a/./b", "a/b/", "bad\u0000key", `ma/${"é".repeat(600)}`]) {
    await assert.rejects(
      storage().presignGet(key, { filename: "f", contentType: "text/plain" }),
      /Invalid object key/,
      JSON.stringify(key).slice(0, 30),
    );
  }
});

// ------------------------------------------------------------------------------------ operations

test("headObject reads the real size and type from the store and signs the request", async () => {
  const { calls, transport } = fakeTransport(
    () =>
      new Response(null, {
        status: 200,
        headers: {
          "content-length": "4096",
          "content-type": "image/png",
          etag: '"abc"',
          "last-modified": "Sun, 22 Nov 2026 10:00:00 GMT",
        },
      }),
  );
  const head = await storage(transport).headObject(NASTY_KEY);
  assert.deepEqual(head, {
    size: 4096,
    contentType: "image/png",
    etag: '"abc"',
    lastModified: "Sun, 22 Nov 2026 10:00:00 GMT",
  });
  const { request } = calls[0];
  assert.equal(request.method, "HEAD");
  assert.equal(new URL(request.url).host, HOST);
  const authorization = request.headers.get("authorization") ?? "";
  assert.match(
    authorization,
    new RegExp(
      `^AWS4-HMAC-SHA256 Credential=${ACCESS_KEY}/20261122/${REGION}/s3/aws4_request, SignedHeaders=.*host.*, Signature=[0-9a-f]{64}$`,
    ),
  );
  assert.equal(request.headers.get("x-amz-date"), DATETIME);
  assert.ok(!authorization.includes(SECRET_KEY));
});

test("headObject maps 404 to NOT_FOUND, other failures to PROVIDER_ERROR, and never leaks the response body", async () => {
  const failing = (status: number) =>
    storage(
      fakeTransport(
        () => new Response(`<Error><Code>Secret</Code><Message>${SECRET_KEY}</Message></Error>`, { status }),
      ).transport,
    );
  await assert.rejects(
    failing(404).headObject("ma/t/k/f"),
    (error) => error instanceof StorageError && error.code === "NOT_FOUND" && error.status === 404,
  );
  for (const status of [400, 403, 500, 503]) {
    await assert.rejects(failing(status).headObject("ma/t/k/f"), (error) => {
      assert.ok(error instanceof StorageError);
      assert.equal(error.code, "PROVIDER_ERROR");
      assert.equal(error.status, status);
      assert.ok(
        !error.message.includes("Secret") && !error.message.includes(SECRET_KEY),
        "no provider body in the message",
      );
      return true;
    });
  }
  const noSize = storage(fakeTransport(() => new Response(null, { status: 200 })).transport);
  await assert.rejects(noSize.headObject("ma/t/k/f"), /usable size/);
});

test("a network failure or timeout is a PROVIDER_ERROR, not a raw exception", async () => {
  const broken = storage(async () => {
    throw new TypeError("fetch failed: ECONNRESET 10.0.0.5");
  });
  await assert.rejects(broken.headObject("ma/t/k/f"), (error) => {
    assert.ok(error instanceof StorageError);
    assert.equal(error.code, "PROVIDER_ERROR");
    assert.doesNotMatch(error.message, /ECONNRESET|10\.0\.0\.5/);
    return true;
  });
  const slow = storage(async () => {
    throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  });
  await assert.rejects(slow.deleteObject("ma/t/k/f"), /timed out/);
});

test("putObject sends the bytes with the content type and length and an unsigned payload hash", async () => {
  const { calls, transport } = fakeTransport(() => new Response(null, { status: 200 }));
  await storage(transport).putObject("ma/t/k/héllo.txt", "xin chào", { contentType: "Text/Plain; charset=utf-8" });
  const { request, body } = calls[0];
  assert.equal(request.method, "PUT");
  assert.equal(body, "xin chào");
  assert.equal(request.headers.get("content-type"), "text/plain");
  assert.equal(request.headers.get("content-length"), String(new TextEncoder().encode("xin chào").length));
  assert.equal(request.headers.get("x-amz-content-sha256"), "UNSIGNED-PAYLOAD");
  assert.ok(new URL(request.url).pathname.endsWith("/h%C3%A9llo.txt"));

  await storage(transport).putObject("ma/t/k/b.bin", new Uint8Array([1, 2, 3]), {
    contentType: "application/octet-stream",
  });
  assert.equal(calls[1].request.headers.get("content-length"), "3");
});

test("putObject needs a declared length for a stream and refuses a bad content type", async () => {
  const { calls, transport } = fakeTransport(() => new Response(null, { status: 200 }));
  const stream = () => new Blob(["hello"]).stream() as ReadableStream<Uint8Array>;
  await assert.rejects(
    storage(transport).putObject("ma/t/k/f", stream(), { contentType: "text/plain" }),
    /content length/,
  );
  await storage(transport).putObject("ma/t/k/f", stream(), { contentType: "text/plain", contentLength: 5 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].request.headers.get("content-length"), "5");
  assert.equal(calls[0].body, "hello");
  await assert.rejects(storage(transport).putObject("ma/t/k/f", "x", { contentType: "bad" }), /content type/i);
  await assert.rejects(
    storage(transport).putObject("ma/t/k/f", "x", { contentType: "text/plain", contentLength: -1 }),
    StorageError,
  );
  assert.equal(calls.length, 1, "nothing was sent for the refused uploads");
});

test("putObject surfaces a provider failure without the response body", async () => {
  const failing = storage(fakeTransport(() => new Response("AccessDenied: secret details", { status: 403 })).transport);
  await assert.rejects(failing.putObject("ma/t/k/f", "x", { contentType: "text/plain" }), (error) => {
    assert.ok(error instanceof StorageError);
    assert.equal(error.code, "PROVIDER_ERROR");
    assert.doesNotMatch(error.message, /AccessDenied|secret details/);
    return true;
  });
});

test("getObject returns the stream with its type and length, and can ask for a byte range", async () => {
  const { calls, transport } = fakeTransport(
    () => new Response("hello", { status: 206, headers: { "content-type": "text/plain", "content-length": "5" } }),
  );
  const result = await storage(transport).getObject("ma/t/k/f.txt", { range: { start: 0, end: 4 } });
  assert.equal(await new Response(result.body).text(), "hello");
  assert.equal(result.contentType, "text/plain");
  assert.equal(result.contentLength, 5);
  assert.equal(calls[0].request.headers.get("range"), "bytes=0-4");
  const missing = storage(fakeTransport(() => new Response("", { status: 404 })).transport);
  await assert.rejects(
    missing.getObject("ma/t/k/f"),
    (error) => error instanceof StorageError && error.code === "NOT_FOUND",
  );
});

test("deleteObject treats a missing object as done so cleanup can be rerun, and still fails on a real error", async () => {
  const gone = fakeTransport(() => new Response("", { status: 404 }));
  await assert.doesNotReject(storage(gone.transport).deleteObject("ma/t/k/f"));
  const deleted = fakeTransport(() => new Response(null, { status: 204 }));
  await storage(deleted.transport).deleteObject("ma/t/k/f");
  assert.equal(deleted.calls[0].request.method, "DELETE");
  const denied = storage(fakeTransport(() => new Response("", { status: 403 })).transport);
  await assert.rejects(
    denied.deleteObject("ma/t/k/f"),
    (error) => error instanceof StorageError && error.code === "PROVIDER_ERROR",
  );
});

// -------------------------------------------------------------------------------------- config

test("storageFromEnv names every missing setting but never a value, and an endpoint must be an http(s) URL", () => {
  const complete = {
    S3_ENDPOINT: ENDPOINT,
    S3_REGION: REGION,
    S3_BUCKET: BUCKET,
    S3_ACCESS_KEY_ID: ACCESS_KEY,
    S3_SECRET_ACCESS_KEY: SECRET_KEY,
  };
  assert.doesNotThrow(() => storageFromEnv(complete));
  assert.throws(
    () => storageFromEnv({ ...complete, S3_ACCESS_KEY_ID: "", S3_SECRET_ACCESS_KEY: undefined as unknown as string }),
    (error) => {
      assert.ok(error instanceof StorageError);
      assert.match(error.message, /S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY missing/);
      assert.ok(!error.message.includes(SECRET_KEY));
      return true;
    },
  );
  assert.throws(() => storageFromEnv({ ...complete, S3_ENDPOINT: "not a url" }), /valid URL/);
  assert.throws(() => storageFromEnv({ ...complete, S3_ENDPOINT: "ftp://example.com" }), /http\(s\)/);
});

// ------------------------------------------------------------------ fixed-length streaming

/** Stands in for the Workers `FixedLengthStream`: passes bytes through and fails on any other total. */
class FakeFixedLengthStream {
  static lengths: number[] = [];
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  constructor(length: number) {
    FakeFixedLengthStream.lengths.push(length);
    let seen = 0;
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > length) controller.error(new TypeError("more bytes than the fixed length"));
        else controller.enqueue(chunk);
      },
      flush(controller) {
        if (seen !== length) controller.error(new TypeError("fewer bytes than the fixed length"));
      },
    });
    this.readable = readable;
    this.writable = writable;
  }
}

const streamOf = (text: string) => new Blob([text]).stream() as ReadableStream<Uint8Array>;

test("a stream upload goes through a fixed-length stream when the runtime has one, so its length is honoured", async () => {
  FakeFixedLengthStream.lengths = [];
  const { calls, transport } = fakeTransport(() => new Response(null, { status: 200 }));
  const store = createStorage({
    endpoint: ENDPOINT,
    region: REGION,
    bucket: BUCKET,
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
    fetch: transport,
    now: () => NOW,
    fixedLengthStream: FakeFixedLengthStream,
  });
  await store.putObject("ma/t/k/f.txt", streamOf("hello"), { contentType: "text/plain", contentLength: 5 });
  assert.deepEqual(FakeFixedLengthStream.lengths, [5]);
  assert.equal(calls[0].body, "hello");
  assert.equal(calls[0].request.headers.get("content-length"), "5");

  // Bytes that are not the declared length fail the upload instead of reaching the store as a short or long object.
  await assert.rejects(
    store.putObject("ma/t/k/f.txt", streamOf("hello!"), { contentType: "text/plain", contentLength: 5 }),
    (error) => error instanceof StorageError && error.code === "PROVIDER_ERROR",
  );
  await assert.rejects(
    store.putObject("ma/t/k/f.txt", streamOf("hi"), { contentType: "text/plain", contentLength: 5 }),
    (error) => error instanceof StorageError && error.code === "PROVIDER_ERROR",
  );

  // Bodies that carry their own length are sent as they are.
  FakeFixedLengthStream.lengths = [];
  await store.putObject("ma/t/k/f.txt", "plain", { contentType: "text/plain" });
  await store.putObject("ma/t/k/f.bin", new Uint8Array([1, 2, 3]), { contentType: "application/octet-stream" });
  assert.deepEqual(FakeFixedLengthStream.lengths, []);
});

test("without a fixed-length stream (Node) a stream is sent as is, with its explicit Content-Length", async () => {
  const { calls, transport } = fakeTransport(() => new Response(null, { status: 200 }));
  await storage(transport).putObject("ma/t/k/f.txt", streamOf("hello"), {
    contentType: "text/plain",
    contentLength: 5,
  });
  assert.equal(calls[0].body, "hello");
  assert.equal(calls[0].request.headers.get("content-length"), "5");
});
