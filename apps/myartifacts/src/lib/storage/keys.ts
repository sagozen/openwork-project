/** Artifact ids, object keys, file names and download headers. Pure helpers, no bindings. */

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** 128 random bits as 26 lowercase base32 characters: unguessable, URL-safe, case-insensitive. */
export function newArtifactId(): string {
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

export const ARTIFACT_ID_PATTERN = /^[a-z2-7]{26}$/;

export const FALLBACK_FILENAME = "file";
export const MAX_FILENAME_CHARS = 200;
const MAX_EXTENSION_CHARS = 20;

/**
 * C0 and C1 control characters, plus the invisible direction and format characters that can make
 * `invoice\u202Efdp.exe` read as `invoiceexe.pdf`.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what is being removed
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/gu;

/**
 * A display and download name that is safe to embed in a key and a header: NFC, no path (only the
 * part after the last `/` or `\` is kept), no control or direction characters, no leading or
 * trailing spaces or dots, at most 200 characters with the extension preserved. Falls back to
 * `file` when nothing is left.
 */
export function sanitizeFilename(name: string): string {
  const base = (name ?? "").normalize("NFC").split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .replace(UNSAFE_CHARS, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s.]+|[\s.]+$/g, "");
  if (cleaned === "") return FALLBACK_FILENAME;

  const chars = Array.from(cleaned);
  if (chars.length <= MAX_FILENAME_CHARS) return cleaned;

  const dot = cleaned.lastIndexOf(".");
  const extension = dot > 0 ? Array.from(cleaned.slice(dot)) : [];
  const keep = extension.length > 0 && extension.length <= MAX_EXTENSION_CHARS ? extension : [];
  const stem = chars
    .slice(0, MAX_FILENAME_CHARS - keep.length)
    .join("")
    .replace(/[\s.]+$/, "");
  return `${stem}${keep.join("")}` || FALLBACK_FILENAME;
}

/** Every artifact object lives under this prefix, then its tenant, then its own id. */
export const KEY_PREFIX = "ma";

/** The object key for one artifact: `ma/<tenant_id>/<artifact_id>/<sanitized-name>`. */
export function objectKey(tenantId: string, artifactId: string, name: string): string {
  if (!tenantId || /[/\\\s]/.test(tenantId)) throw new Error("Invalid tenant id for an object key.");
  if (!ARTIFACT_ID_PATTERN.test(artifactId)) throw new Error("Invalid artifact id for an object key.");
  return `${KEY_PREFIX}/${tenantId}/${artifactId}/${sanitizeFilename(name)}`;
}

/** Everything one tenant owns, for prefix listings and purges. */
export function tenantPrefix(tenantId: string): string {
  return `${KEY_PREFIX}/${tenantId}/`;
}

export type DispositionKind = "inline" | "attachment";

/** RFC 3986 percent-encoding of one value: like `encodeURIComponent` but also `! ' ( ) *`. */
export function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * RFC 6266 `Content-Disposition` for a download. `filename` is a printable-ASCII fallback for old
 * clients and `filename*` carries the real name as UTF-8 (RFC 5987), so Vietnamese and other
 * non-ASCII names survive.
 */
export function contentDisposition(kind: DispositionKind, filename: string): string {
  const name = sanitizeFilename(filename);
  const fallback = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\%]/g, "_");
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encodeRfc3986(name)}`;
}
