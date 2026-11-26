import { HttpError } from "../http";

/**
 * Webhook signature verification. Both providers sign `timestamp + separator + rawBody` with
 * HMAC-SHA256 and a shared secret; only the header format and separator differ.
 * See `plans/261025-1601-checkout-billing-production/reports/provider-facts.md`.
 */

const encoder = new TextEncoder();

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Length-independent comparison for equal-length hex digests. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}

function invalidSignature(reason: string): HttpError {
  return new HttpError("invalid_input", 400, "Invalid webhook signature.", { reason });
}

function parsePairs(header: string): Map<string, string[]> {
  const pairs = new Map<string, string[]>();
  for (const part of header.split(/[;,]/)) {
    const [rawKey, ...rest] = part.split("=");
    const key = rawKey?.trim();
    if (!key || rest.length === 0) continue;
    const value = rest.join("=").trim();
    const bucket = pairs.get(key) ?? [];
    bucket.push(value);
    pairs.set(key, bucket);
  }
  return pairs;
}

function assertFresh(timestamp: string | undefined, nowMs: number, toleranceSec: number): void {
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) throw invalidSignature("missing_timestamp");
  if (Math.abs(nowMs / 1000 - seconds) > toleranceSec) throw invalidSignature("timestamp_out_of_tolerance");
}

async function assertAnyMatch(candidates: string[] | undefined, secret: string, signedPayload: string): Promise<void> {
  if (!candidates || candidates.length === 0) throw invalidSignature("missing_signature");
  const expected = await hmacSha256Hex(secret, signedPayload);
  for (const candidate of candidates) {
    if (timingSafeEqualHex(candidate.toLowerCase(), expected)) return;
  }
  throw invalidSignature("signature_mismatch");
}

/**
 * `Paddle-Signature: ts=1671552777;h1=<hex>` — HMAC over `ts:rawBody`.
 * Paddle's SDKs use a 5 second replay tolerance, so that is the default here.
 */
export async function verifyPaddleSignature(
  rawBody: string,
  header: string | null,
  secret: string,
  nowMs: number = Date.now(),
  toleranceSec = 5,
): Promise<void> {
  if (!header) throw invalidSignature("missing_header");
  const pairs = parsePairs(header);
  const ts = pairs.get("ts")?.[0];
  assertFresh(ts, nowMs, toleranceSec);
  await assertAnyMatch(pairs.get("h1"), secret, `${ts}:${rawBody}`);
}

/**
 * `Stripe-Signature: t=1492774577,v1=<hex>[,v1=<hex>]` — HMAC over `t.rawBody`.
 * Non-`v1` schemes (for example the `v0` test scheme) are ignored to prevent downgrade attacks.
 */
export async function verifyStripeSignature(
  rawBody: string,
  header: string | null,
  secret: string,
  nowMs: number = Date.now(),
  toleranceSec = 300,
): Promise<void> {
  if (!header) throw invalidSignature("missing_header");
  const pairs = parsePairs(header);
  const t = pairs.get("t")?.[0];
  assertFresh(t, nowMs, toleranceSec);
  await assertAnyMatch(pairs.get("v1"), secret, `${t}.${rawBody}`);
}
