#!/usr/bin/env node
/**
 * Live check of the object store MyArtifacts keeps its files in (Contabo S3, bucket `myartifact`).
 * Manual: it writes, reads and deletes a few tiny objects under `ma/smoke-check/` and leaves
 * nothing behind. It exercises the same storage module the app uses, so a pass here means the
 * app's signing, presigned URLs and header overrides work against the real provider.
 *
 *   S3_ENDPOINT=https://usc1.contabostorage.com S3_REGION=usc1 S3_BUCKET=myartifact \
 *   S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=... npx tsx scripts/contabo-s3-smoke.mjs
 *
 * `tsx` is needed because the storage module is TypeScript. S3_REGION is optional: the script
 * tries it first, then `usc1` and `default`, prints which one the provider accepts, and that is the
 * value for `S3_REGION` in apps/myartifacts/wrangler.jsonc. The key is never printed.
 */
const REQUIRED = ["S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"];
const missing = REQUIRED.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(
    `Set ${missing.join(", ")} first (the same values the Worker uses; S3_REGION is optional).\n` +
      "Run: S3_ENDPOINT=... S3_BUCKET=... S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=... npx tsx scripts/contabo-s3-smoke.mjs",
  );
  process.exit(2);
}

let storageModule;
let keysModule;
try {
  storageModule = await import("../apps/myartifacts/src/lib/storage/s3.ts");
  keysModule = await import("../apps/myartifacts/src/lib/storage/keys.ts");
} catch (error) {
  console.error(`Could not load the storage module (${error instanceof Error ? error.message : error}).`);
  console.error("Run this script with tsx: npx tsx scripts/contabo-s3-smoke.mjs");
  process.exit(2);
}
const { createStorage, StorageError } = storageModule;
const { newArtifactId, objectKey } = keysModule;

const config = {
  endpoint: process.env.S3_ENDPOINT,
  bucket: process.env.S3_BUCKET,
  accessKeyId: process.env.S3_ACCESS_KEY_ID,
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
};
const regions = [...new Set([process.env.S3_REGION, "usc1", "default"].filter(Boolean))];

let failures = 0;
const created = [];

function report(ok, step, detail = "") {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${step}${detail ? `: ${detail}` : ""}`);
  return ok;
}

/** Runs one step; a thrown error fails the step instead of the script. */
async function step(name, run) {
  try {
    const detail = await run();
    return report(true, name, typeof detail === "string" ? detail : "");
  } catch (error) {
    const reason =
      error instanceof StorageError
        ? `${error.code}${error.status ? ` HTTP ${error.status}` : ""} ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error);
    return report(false, name, reason);
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

console.log(`Endpoint ${config.endpoint}, bucket ${config.bucket}`);

// 1. Find the signing region the provider accepts. A correct signature is the only way a PUT succeeds.
const stamp = new Date().toISOString();
const body = `myartifacts smoke check ${stamp}`;
const bytes = new TextEncoder().encode(body);
const idA = newArtifactId();
const keyA = objectKey("smoke-check", idA, "Báo cáo (smoke) #1 & 100%.txt");

let storage;
let region;
for (const candidate of regions) {
  const attempt = createStorage({ ...config, region: candidate });
  try {
    await attempt.putObject(keyA, bytes, { contentType: "text/plain" });
    storage = attempt;
    region = candidate;
    created.push(keyA);
    report(true, `signing region "${candidate}" is accepted`);
    break;
  } catch (error) {
    // A refused candidate is only a problem when no region works at all.
    const status = error instanceof StorageError && error.status ? ` (HTTP ${error.status})` : "";
    console.log(`  --   signing region "${candidate}" refused: PUT answered${status || " with an error"}`);
  }
}
if (!storage) {
  console.log("\nNo region signed correctly. Check the endpoint, bucket, key id and secret, and that the key may write to the bucket.");
  process.exit(1);
}

await step("HEAD reports the real size and type", async () => {
  const head = await storage.headObject(keyA);
  expect(head.size === bytes.length, `size ${head.size}, expected ${bytes.length}`);
  expect((head.contentType ?? "").startsWith("text/plain"), `content type ${head.contentType}`);
  return `${head.size} bytes, ${head.contentType}`;
});

await step("GET returns the stored bytes", async () => {
  const object = await storage.getObject(keyA);
  const text = await new Response(object.body).text();
  expect(text === body, "body differs from what was stored");
  return `${object.contentLength} bytes`;
});

await step("an unsigned request for the object is refused (bucket is private)", async () => {
  const publicUrl = `${config.endpoint.replace(/\/$/, "")}/${config.bucket}/${keyA.split("/").map(encodeURIComponent).join("/")}`;
  const response = await fetch(publicUrl);
  await response.body?.cancel();
  expect(response.status === 403 || response.status === 401, `anonymous GET answered HTTP ${response.status}`);
  return `HTTP ${response.status}`;
});

await step("presigned GET works and applies the content-type and content-disposition overrides", async () => {
  const link = await storage.presignGet(keyA, {
    filename: "Báo cáo (smoke) #1.csv",
    contentType: "text/csv",
    disposition: "attachment",
    ttl: 120,
  });
  const response = await fetch(link.url);
  const text = await response.text();
  expect(response.status === 200, `HTTP ${response.status}`);
  expect(text === body, "body differs");
  expect((response.headers.get("content-type") ?? "").startsWith("text/csv"), `content-type ${response.headers.get("content-type")}`);
  const disposition = response.headers.get("content-disposition") ?? "";
  expect(disposition.startsWith("attachment;"), `content-disposition ${disposition}`);
  expect(disposition.includes("filename*=UTF-8''B%C3%A1o%20c%C3%A1o"), `no UTF-8 filename in ${disposition}`);
  return disposition;
});

await step("presigned GET for an inline-safe type is served inline", async () => {
  const link = await storage.presignGet(keyA, { filename: "note.txt", contentType: "text/plain", disposition: "inline", ttl: 120 });
  const response = await fetch(link.url);
  await response.body?.cancel();
  expect(response.status === 200, `HTTP ${response.status}`);
  expect((response.headers.get("content-disposition") ?? "").startsWith("inline;"), `content-disposition ${response.headers.get("content-disposition")}`);
});

const idB = newArtifactId();
const keyB = objectKey("smoke-check", idB, "Tệp tải lên (presigned).txt");
const upload = new TextEncoder().encode(`presigned upload ${stamp}`);

await step("presigned PUT stores an object of the declared size and type", async () => {
  const link = await storage.presignPut(keyB, { contentType: "text/plain", contentLength: upload.length });
  const response = await fetch(link.url, { method: "PUT", headers: link.headers, body: upload });
  await response.body?.cancel();
  expect(response.status === 200 || response.status === 204, `HTTP ${response.status}`);
  created.push(keyB);
  const head = await storage.headObject(keyB);
  expect(head.size === upload.length, `size ${head.size}, expected ${upload.length}`);
  return `${head.size} bytes recorded by the store`;
});

const idC = newArtifactId();
const keyC = objectKey("smoke-check", idC, "pinned.txt");

await step("a presigned PUT refuses a body of a different size than it was signed for", async () => {
  const link = await storage.presignPut(keyC, { contentType: "text/plain", contentLength: upload.length });
  const response = await fetch(link.url, { method: "PUT", headers: link.headers, body: new Uint8Array(upload.length + 7) });
  await response.body?.cancel();
  if (response.ok) created.push(keyC);
  expect(!response.ok, "the store accepted a body of a different size: the size is not pinned");
  return `HTTP ${response.status}`;
});

await step("a presigned PUT refuses a different content type than it was signed for", async () => {
  const link = await storage.presignPut(keyC, { contentType: "text/plain", contentLength: upload.length });
  const response = await fetch(link.url, { method: "PUT", headers: { "content-type": "text/html" }, body: upload });
  await response.body?.cancel();
  if (response.ok) created.push(keyC);
  expect(!response.ok, "the store accepted another content type: the type is not pinned");
  return `HTTP ${response.status}`;
});

// Cleanup always runs, even after failures above.
for (const key of [...new Set(created)]) {
  await step(`DELETE ${key.split("/").slice(-2).join("/")}`, async () => {
    await storage.deleteObject(key);
    await storage.deleteObject(key); // idempotent: a second delete of a missing object is not an error
    try {
      await storage.headObject(key);
      throw new Error("the object is still there after DELETE");
    } catch (error) {
      if (!(error instanceof StorageError) || error.code !== "NOT_FOUND") throw error;
    }
  });
}

console.log(`\nRegion that signs correctly: ${region}`);
console.log(`Set S3_REGION to "${region}" in apps/myartifacts/wrangler.jsonc if it differs.`);
console.log(failures === 0 ? "All checks passed." : `${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
