// DoveRunner (formerly PallyCon) Multi-DRM license token v2.
// Spec: https://docs.doverunner.com/content-security/multi-drm/license/license-token/
// Minting is local WebCrypto work; no network call and no secret leaves the server.
import type { DrmType } from "../model.js";

export const LICENSE_URL =
  "https://drm-license.doverunner.com/ri/licenseManager.do";
export const LICENSE_TOKEN_HEADER = "pallycon-customdata-v2";
/** DoveRunner's default token lifetime after its timestamp (adjustable in Console). */
export const TOKEN_VALIDITY_SECONDS = 600;
const POLICY_IV = new TextEncoder().encode("0123456789abcdef");
const TOKEN_DRM: Record<DrmType, string> = {
  widevine: "Widevine",
  playready: "PlayReady",
  fairplay: "FairPlay",
};

export interface DoveRunnerCredentials {
  siteId: string;
  siteKey: string;
  accessKey: string;
}

export function fairPlayCertificateUrl(siteId: string): string {
  return `https://drm-license.doverunner.com/ri/fpsKeyManager.do?siteId=${encodeURIComponent(siteId)}`;
}

function base64(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** `yyyy-mm-ddThh:mm:ssZ` in GMT; DoveRunner rejects milliseconds. */
export function tokenTimestamp(now: number): string {
  return new Date(now).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** AES-256-CBC (PKCS7) with the site key's ASCII bytes and the fixed spec IV. */
export async function encryptPolicy(
  policy: string,
  siteKey: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(siteKey),
    { name: "AES-CBC" },
    false,
    ["encrypt"],
  );
  return base64(
    await crypto.subtle.encrypt(
      { name: "AES-CBC", iv: POLICY_IV },
      key,
      new TextEncoder().encode(policy),
    ),
  );
}

export async function mintLicenseToken(args: {
  credentials: DoveRunnerCredentials;
  drm: DrmType;
  userId: string;
  contentId: string;
  policy: object;
  now: number;
}): Promise<string> {
  const { credentials, drm, userId, contentId, now } = args;
  const drmType = TOKEN_DRM[drm];
  const policy = await encryptPolicy(
    JSON.stringify(args.policy),
    credentials.siteKey,
  );
  const timestamp = tokenTimestamp(now);
  const hash = base64(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        credentials.accessKey +
          drmType +
          credentials.siteId +
          userId +
          contentId +
          policy +
          timestamp,
      ),
    ),
  );
  return btoa(
    JSON.stringify({
      drm_type: drmType,
      site_id: credentials.siteId,
      user_id: userId,
      cid: contentId,
      policy,
      timestamp,
      hash,
    }),
  );
}

/**
 * Streaming (not offline) license. `license_duration` overrides `expire_date`
 * and bounds how long an issued license keeps playing. `max_stream_per_user`
 * makes DoveRunner enforce concurrent streams; it fails with error 7023 unless
 * Concurrent Stream Limiting is enabled in DoveRunner Console.
 */
export function streamingPolicy(
  licenseSeconds: number,
  maxStreams: number | null = null,
): object {
  return {
    policy_version: 2,
    playback_policy: {
      persistent: false,
      license_duration: Math.max(1, Math.floor(licenseSeconds)),
      ...(maxStreams === null ? {} : { max_stream_per_user: maxStreams }),
    },
  };
}
