/** Share passwords and the cookie that remembers a correct one. WebCrypto only, so it runs in Workers and Node. */

export const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const HASH_BYTES = 32;
export const SHARE_COOKIE_SECONDS = 12 * 60 * 60;

const encoder = new TextEncoder();

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

/** Compares in time that depends only on the length, not on where the bytes first differ. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

/** Passwords are compared as typed, minus surrounding spaces a copy-paste adds. */
const normalize = (password: string) => password.trim();

async function derive(password: string, salt: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(normalize(password)), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS },
    key,
    HASH_BYTES * 8,
  );
  return new Uint8Array(bits);
}

/** PBKDF2-SHA256, 100k iterations, a fresh 16-byte salt per password. */
export async function hashPassword(password: string): Promise<{ hash: string; salt: string }> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  return { hash: toBase64Url(await derive(password, salt)), salt: toBase64Url(salt) };
}

export async function verifyPassword(password: string, hash: string, salt: string): Promise<boolean> {
  const saltBytes = fromBase64Url(salt);
  const expected = fromBase64Url(hash);
  if (!saltBytes || !expected) return false;
  return timingSafeEqual(await derive(password, saltBytes), expected);
}

/** No look-alike characters (I, O, 0, 1); 32 symbols, so a random byte maps to one without bias. */
const PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** 16 random characters, 80 bits. */
export function generatePassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => PASSWORD_ALPHABET[byte & 31]).join("");
}

async function mac(secret: string, message: string): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

export const shareCookieName = (token: string) => `ms_${token}`;

/**
 * The cookie value that says "this browser gave the right password for this share": an expiry and an
 * HMAC over the token, the expiry and the share's password salt. It works for one token only, and
 * changing or clearing the password (a new salt) invalidates every cookie issued before.
 */
export async function signShareCookie(
  secret: string,
  token: string,
  salt: string,
  nowSeconds: number,
): Promise<string> {
  const expires = nowSeconds + SHARE_COOKIE_SECONDS;
  return `${expires}.${toBase64Url(await mac(secret, `share|${token}|${expires}|${salt}`))}`;
}

export async function verifyShareCookie(
  secret: string,
  token: string,
  salt: string,
  value: string | undefined,
  nowSeconds: number,
): Promise<boolean> {
  const match = value?.match(/^(\d{1,12})\.([A-Za-z0-9_-]{20,64})$/);
  if (!match) return false;
  const expires = Number(match[1]);
  if (expires <= nowSeconds || expires > nowSeconds + SHARE_COOKIE_SECONDS + 60) return false;
  const given = fromBase64Url(match[2]);
  if (!given) return false;
  return timingSafeEqual(given, await mac(secret, `share|${token}|${expires}|${salt}`));
}
