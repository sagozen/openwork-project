import type { DrmType } from "@mytutor/plugin-mytutor-lms/model";

const VIDEO = 'video/mp4; codecs="avc1.42E01E"';
// DoveRunner's documented probe order: FairPlay first, then PlayReady, then Widevine.
const KEY_SYSTEMS: [string, DrmType][] = [
  ["com.apple.fps", "fairplay"],
  ["com.microsoft.playready.recommendation.3000", "playready"],
  ["com.microsoft.playready", "playready"],
  ["com.widevine.alpha", "widevine"],
];
export const SHAKA_KEY_SYSTEM: Record<DrmType, string> = {
  fairplay: "com.apple.fps",
  // `…recommendation.3000` in Shaka's server map triggers error 6012.
  playready: "com.microsoft.playready",
  widevine: "com.widevine.alpha",
};

/** The browser's DRM, detected before asking the server for a license token. */
export async function detectDrm(): Promise<DrmType | null> {
  if (typeof navigator.requestMediaKeySystemAccess !== "function") return null;
  for (const [keySystem, drm] of KEY_SYSTEMS) {
    try {
      await navigator.requestMediaKeySystemAccess(keySystem, [
        {
          initDataTypes: ["cenc", "sinf", "skd"],
          videoCapabilities: [{ contentType: VIDEO }],
        },
      ]);
      return drm;
    } catch {
      // Try the next key system.
    }
  }
  return null;
}

/** Coarse, user-recognisable label for the screen-limit dialog; not a fingerprint. */
export function deviceLabel(): string {
  const agent = navigator.userAgent;
  const browser = /Edg\//.test(agent)
    ? "Edge"
    : /Firefox\//.test(agent)
      ? "Firefox"
      : /Chrome\//.test(agent)
        ? "Chrome"
        : /Safari\//.test(agent)
          ? "Safari"
          : "Browser";
  const device = /iPhone/.test(agent)
    ? "iPhone"
    : /iPad/.test(agent)
      ? "iPad"
      : /Android/.test(agent)
        ? "Android"
        : /Mac OS X/.test(agent)
          ? "Mac"
          : /Windows/.test(agent)
            ? "Windows"
            : /Linux/.test(agent)
              ? "Linux"
              : "device";
  return `${browser} on ${device}`;
}
