/**
 * fal.ai signs every webhook with Ed25519. The signed message is the request id, user id and
 * timestamp headers plus the SHA-256 of the raw body, joined by newlines. Public keys come from a
 * JWKS document that is cached for up to a day.
 */
export const JWKS_URL = "https://rest.fal.ai/.well-known/jwks.json";
const SKEW_SECONDS = 300;
const CACHE_MS = 24 * 60 * 60 * 1000;

interface Jwk {
  kty: string;
  crv?: string;
  x: string;
}

let cache: { keys: Jwk[]; fetchedAt: number } | null = null;

export function resetJwksCache(): void {
  cache = null;
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

function hexToBytes(hex: string): Uint8Array | null {
  if (!/^([0-9a-f]{2})+$/i.test(hex)) return null;
  return Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
}

async function loadKeys(fetcher: typeof fetch, nowMs: number): Promise<Jwk[]> {
  if (cache && nowMs - cache.fetchedAt < CACHE_MS) return cache.keys;
  const response = await fetcher(JWKS_URL);
  if (!response.ok) throw new Error(`jwks fetch failed (${response.status})`);
  const data = (await response.json()) as { keys?: Jwk[] };
  const keys = (data.keys ?? []).filter((key) => key.kty === "OKP" && typeof key.x === "string");
  // An empty list is a bad answer, not a result worth keeping for a day.
  if (keys.length > 0) cache = { keys, fetchedAt: nowMs };
  return keys;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface VerifyOptions {
  fetch?: typeof fetch;
  nowMs?: number;
}

/** True only when the headers are present, fresh and the signature matches one published key. */
export async function verifyFalWebhook(
  headers: Headers,
  rawBody: Uint8Array,
  options: VerifyOptions = {},
): Promise<boolean> {
  const requestId = headers.get("x-fal-webhook-request-id");
  const userId = headers.get("x-fal-webhook-user-id");
  const timestamp = headers.get("x-fal-webhook-timestamp");
  const signatureHex = headers.get("x-fal-webhook-signature");
  if (!requestId || !userId || !timestamp || !signatureHex) return false;

  const nowMs = options.nowMs ?? Date.now();
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds) || Math.abs(nowMs / 1000 - seconds) > SKEW_SECONDS) return false;

  const signature = hexToBytes(signatureHex);
  if (!signature) return false;
  const message = new TextEncoder().encode([requestId, userId, timestamp, await sha256Hex(rawBody)].join("\n"));

  let keys: Jwk[];
  try {
    keys = await loadKeys(options.fetch ?? fetch, nowMs);
  } catch {
    return false;
  }
  for (const jwk of keys) {
    try {
      const key = await crypto.subtle.importKey(
        "raw",
        base64UrlToBytes(jwk.x) as BufferSource,
        { name: "Ed25519" },
        false,
        ["verify"],
      );
      if (await crypto.subtle.verify({ name: "Ed25519" }, key, signature as BufferSource, message)) return true;
    } catch {
      // Try the next published key.
    }
  }
  return false;
}
