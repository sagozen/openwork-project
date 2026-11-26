import type { Env } from "./types";

/**
 * S3 presigned URLs for R2, signed with WebCrypto only (no SDK on Workers).
 *
 * Bytes never pass through the Worker: the browser PUTs straight to R2, the transcriber
 * PUTs its result the same way, and the Worker mints short-lived GETs for playback and
 * download. Only `X-Amz-SignedHeaders=host` is signed, which is the S3 presigned-URL
 * default and keeps the body unsigned (`UNSIGNED-PAYLOAD`).
 */
export type BucketName = "media" | "outputs";

const ALGORITHM = "AWS4-HMAC-SHA256";
const REGION = "auto";
const SERVICE = "s3";

function bucketName(env: Env, bucket: BucketName): string {
  if (bucket === "media") return env.MEDIA_BUCKET_NAME ?? "transcript-media";
  return env.OUTPUTS_BUCKET_NAME ?? "transcript-outputs";
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function hmac(key: ArrayBuffer | Uint8Array, value: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(value));
}

function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function encodeKey(key: string): string {
  return key.split("/").map(rfc3986).join("/");
}

export interface PresignOptions {
  bucket: BucketName;
  key: string;
  method: "PUT" | "GET";
  expiresIn?: number;
  /** Bound into the signature so a PUT to a different content type is rejected by R2. */
  contentType?: string;
}

export function presignConfigured(env: Env): boolean {
  return Boolean(env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY);
}

export async function presignR2(env: Env, options: PresignOptions): Promise<string> {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    throw new Error("R2 presigning is not configured");
  }
  const host = `${bucketName(env, options.bucket)}.${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const now = new Date();
  const amzDate = `${now.toISOString().replace(/[:-]|\.\d{3}/g, "")}`;
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const expires = Math.min(Math.max(options.expiresIn ?? 900, 1), 604800);

  const query = new URLSearchParams({
    "X-Amz-Algorithm": ALGORITHM,
    "X-Amz-Credential": `${R2_ACCESS_KEY_ID}/${credentialScope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expires),
    "X-Amz-SignedHeaders": "host",
  });
  const sortedQuery = [...query.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${rfc3986(key)}=${rfc3986(value)}`)
    .join("&");

  const canonicalRequest = [
    options.method,
    `/${encodeKey(options.key)}`,
    sortedQuery,
    `host:${host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = [ALGORITHM, amzDate, credentialScope, await sha256Hex(canonicalRequest)].join("\n");

  const dateKey = await hmac(new TextEncoder().encode(`AWS4${R2_SECRET_ACCESS_KEY}`), dateStamp);
  const regionKey = await hmac(dateKey, REGION);
  const serviceKey = await hmac(regionKey, SERVICE);
  const signingKey = await hmac(serviceKey, "aws4_request");
  const signature = hex(await hmac(signingKey, stringToSign));

  return `https://${host}/${encodeKey(options.key)}?${sortedQuery}&X-Amz-Signature=${signature}`;
}

/* ------------------------------------------------------------- objects */

export function mediaKey(jobId: string, filename: string): string {
  const safe = filename.replace(/[^A-Za-z0-9._-]+/g, "-").slice(-120) || "media";
  return `media/${jobId}/${safe}`;
}

export function resultKey(jobId: string, name: string): string {
  return `results/${jobId}/${name}`;
}

export function bucketFor(env: Env, bucket: BucketName): R2Bucket {
  return bucket === "media" ? env.MEDIA : env.OUTPUTS;
}

export async function putJson(env: Env, key: string, value: unknown): Promise<void> {
  await env.OUTPUTS.put(key, JSON.stringify(value), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
}

export async function getJson<T>(env: Env, key: string): Promise<T | null> {
  const object = await env.OUTPUTS.get(key);
  if (!object) return null;
  try {
    return (await object.json()) as T;
  } catch {
    return null;
  }
}

export async function getText(env: Env, key: string): Promise<string | null> {
  const object = await env.OUTPUTS.get(key);
  return object ? object.text() : null;
}

export async function deletePrefix(env: Env, bucket: BucketName, prefix: string): Promise<number> {
  const store = bucketFor(env, bucket);
  let deleted = 0;
  let cursor: string | undefined;
  do {
    const listed = await store.list({ prefix, cursor });
    if (listed.objects.length > 0) {
      await store.delete(listed.objects.map((object) => object.key));
      deleted += listed.objects.length;
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return deleted;
}
