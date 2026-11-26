import { HttpError } from "@templatedesign/platform/http";
import { deleteObject, putObject } from "../storage/r2";

/**
 * Logo upload. Tenants share one origin, so an uploaded file must never be able to carry script:
 * only PNG, JPEG and WebP are accepted (SVG and anything else is refused), the type comes from the
 * file's magic bytes rather than the browser's claim, and the file is stored under a content-hash
 * key so a response can be cached forever.
 */

export const MAX_LOGO_BYTES = 512 * 1024;

export type LogoType = "image/png" | "image/jpeg" | "image/webp";

const EXTENSIONS: Record<LogoType, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
export const CONTENT_TYPE_BY_EXTENSION: Record<string, LogoType> = {
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
};

/** Sniffs the real type from the leading bytes. Returns null for anything that is not a raster logo. */
export function sniffLogoType(bytes: Uint8Array): LogoType | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

export interface CheckedLogo {
  type: LogoType;
  extension: string;
}

/** Validates size and content. `declaredType` is the browser's claim and must agree with the bytes. */
export function checkLogo(bytes: Uint8Array, declaredType?: string): CheckedLogo {
  if (bytes.length === 0) throw new HttpError("invalid_input", 400, "The file is empty.", { field: "logo" });
  if (bytes.length > MAX_LOGO_BYTES) {
    throw new HttpError("payload_too_large", 413, "Logos can be up to 512 KB.", { field: "logo", max: MAX_LOGO_BYTES });
  }
  const type = sniffLogoType(bytes);
  if (!type) {
    throw new HttpError("invalid_input", 400, "Use a PNG, JPEG or WebP image. SVG is not supported.", {
      field: "logo",
    });
  }
  if (declaredType && declaredType !== type) {
    throw new HttpError("invalid_input", 400, "The file does not match its type.", { field: "logo" });
  }
  return { type, extension: EXTENSIONS[type] };
}

async function shortHash(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)]
    .slice(0, 8)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** `brand/<workspaceId>/<16 hex>.<ext>`, the only shape the serve route will answer to. */
export const BRAND_KEY_PATTERN = /^brand\/ws_[a-f0-9]{32}\/[a-f0-9]{16}\.(png|jpg|webp)$/;

export async function storeLogo(
  bucket: R2Bucket,
  workspaceId: string,
  bytes: Uint8Array,
  declaredType?: string,
): Promise<string> {
  const checked = checkLogo(bytes, declaredType);
  const key = `brand/${workspaceId}/${await shortHash(bytes)}.${checked.extension}`;
  if (!BRAND_KEY_PATTERN.test(key)) throw new Error("Unexpected workspace id shape for a brand key");
  await putObject(bucket, key, bytes, checked.type);
  return key;
}

/** Removes a previous logo, but only if it really belongs to this workspace. */
export async function removeLogo(bucket: R2Bucket, workspaceId: string, key: string | null): Promise<void> {
  if (!key || !key.startsWith(`brand/${workspaceId}/`)) return;
  await deleteObject(bucket, key);
}
