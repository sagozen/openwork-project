/** Object keys, image ids and signed reference links. Pure helpers, no bindings. */

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** 128 random bits as 26 lowercase base32 characters: unguessable, URL-safe, case-insensitive. */
export function newImageId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export const IMAGE_ID_PATTERN = /^[a-z2-7]{26}$/;

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

const MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

export function extensionFor(mime: string): string {
  return EXTENSIONS[mime.toLowerCase().split(";")[0].trim()] ?? "png";
}

export function mimeForExtension(extension: string): string | undefined {
  return MIME_BY_EXTENSION[extension.toLowerCase()];
}

/** Generated images. The public route serves only keys that start with `images/`. */
export function imageKey(tenantId: string, imageId: string, extension: string): string {
  return `images/${tenantId}/${imageId}.${extension}`;
}

/** Brand reference assets live under their own prefix and are never served from the public route. */
export function brandAssetKey(tenantId: string, assetId: string, extension: string): string {
  return `brand/${tenantId}/${assetId}.${extension}`;
}

export function tenantPrefixes(tenantId: string): string[] {
  return [`images/${tenantId}/`, `brand/${tenantId}/`];
}

export function publicImageUrl(publicBase: string, imageId: string, extension: string): string {
  return `${publicBase.replace(/\/$/, "")}/${imageId}.${extension}`;
}

/** Magic-byte sniffing: the extension and the declared content type are never trusted. */
export function sniffImageMime(bytes: Uint8Array): "image/png" | "image/jpeg" | "image/webp" | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

const encoder = new TextEncoder();

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
}

export const REFERENCE_TTL_SECONDS = 600;

/**
 * A short-lived link the image provider can fetch for a private brand reference. The Worker
 * verifies the signature itself, so no R2 S3 credentials are needed.
 */
export async function signedReferenceUrl(
  origin: string,
  secret: string,
  assetId: string,
  nowMs = Date.now(),
  ttlSeconds = REFERENCE_TTL_SECONDS,
): Promise<string> {
  const expires = Math.floor(nowMs / 1000) + ttlSeconds;
  const signature = await hmacHex(secret, `ref:${assetId}:${expires}`);
  return `${origin.replace(/\/$/, "")}/i/ref/${assetId}?exp=${expires}&sig=${signature}`;
}

export async function verifyReferenceSignature(
  secret: string,
  assetId: string,
  expires: string | null,
  signature: string | null,
  nowMs = Date.now(),
): Promise<boolean> {
  if (!expires || !signature || !/^\d+$/.test(expires)) return false;
  if (Number(expires) < Math.floor(nowMs / 1000)) return false;
  return constantTimeEqual(await hmacHex(secret, `ref:${assetId}:${expires}`), signature);
}
