import type {
  DrmPlaybackGrant,
  DrmType,
} from "@mytutor/plugin-mytutor-lms/model";
import { SHAKA_KEY_SYSTEM } from "./drm-support";

export interface PlayerEngine {
  destroy(): Promise<void>;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function bytesOf(data: ArrayBuffer | ArrayBufferView): Uint8Array {
  return data instanceof ArrayBuffer
    ? new Uint8Array(data)
    : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}
function fromBase64(value: string): Uint8Array {
  const binary = atob(value.trim());
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

type LicenseRequest = {
  headers: Record<string, string>;
  body: ArrayBuffer | ArrayBufferView;
};
type LicenseResponse = { data: ArrayBuffer | ArrayBufferView };
/** The part of the Shaka Player namespace this file uses. */
interface ShakaNamespace {
  polyfill: { installAll(): void };
  Player: {
    new (): ShakaPlayer;
    isBrowserSupported(): boolean;
  };
  net: { NetworkingEngine: { RequestType: { LICENSE: number } } };
  util: { Error: { Severity: { CRITICAL: number } } };
}
interface ShakaPlayer {
  attach(video: HTMLVideoElement): Promise<void>;
  configure(config: unknown): void;
  getNetworkingEngine(): {
    registerRequestFilter(
      filter: (type: number, request: LicenseRequest) => void,
    ): void;
    registerResponseFilter(
      filter: (type: number, response: LicenseResponse) => void,
    ): void;
  };
  addEventListener(
    type: "error",
    listener: (event: { detail?: { severity?: number } }) => void,
  ): void;
  load(url: string): Promise<void>;
  destroy(): Promise<void>;
}

/**
 * DoveRunner Multi-DRM through Shaka Player. Loaded on demand so lessons
 * without secure video never download the player.
 */
export async function startDrmPlayback(
  video: HTMLVideoElement,
  grant: DrmPlaybackGrant,
  drm: DrmType,
  /** Called once when playback stops for good (a fatal Shaka error). */
  onStopped: () => void,
): Promise<PlayerEngine> {
  const module = await import("shaka-player");
  // The compiled Shaka build is a UMD namespace; only the calls below are used.
  const shaka = ((module as { default?: unknown }).default ??
    module) as unknown as ShakaNamespace;
  shaka.polyfill.installAll();
  if (!shaka.Player.isBrowserSupported()) throw new Error("UNSUPPORTED_DEVICE");
  const license = grant.drm[drm];
  if (!license) throw new Error("UNSUPPORTED_DEVICE");
  const keySystem = SHAKA_KEY_SYSTEM[drm];
  const player = new shaka.Player();
  try {
    await player.attach(video);
    player.configure({
      drm: {
        servers: { [keySystem]: license.licenseUrl },
        ...(license.certificateUrl
          ? {
              advanced: {
                [keySystem]: { serverCertificateUri: license.certificateUrl },
              },
            }
          : {}),
      },
    });
    const LICENSE = shaka.net.NetworkingEngine.RequestType.LICENSE;
    const networking = player.getNetworkingEngine();
    networking.registerRequestFilter((type, request) => {
      if (type !== LICENSE) return;
      request.headers[grant.licenseHeader] = license.token;
      if (drm === "fairplay") {
        const spc = toBase64(bytesOf(request.body));
        request.headers["Content-Type"] = "application/x-www-form-urlencoded";
        request.body = new TextEncoder().encode(
          `spc=${encodeURIComponent(spc)}`,
        );
      }
    });
    networking.registerResponseFilter((type, response) => {
      if (type !== LICENSE) return;
      const bytes = bytesOf(response.data);
      // DoveRunner reports license errors as HTTP 200 with a JSON body.
      if (bytes[0] === 0x7b) {
        let failure: { errorCode?: unknown } | null = null;
        try {
          failure = JSON.parse(new TextDecoder().decode(bytes));
        } catch {
          failure = null;
        }
        if (failure?.errorCode !== undefined)
          throw new Error(`License refused (${String(failure.errorCode)})`);
      }
      if (drm === "fairplay")
        response.data = fromBase64(new TextDecoder().decode(bytes));
    });
    // Shaka retries recoverable network errors itself; only fatal ones stop the lesson.
    player.addEventListener("error", (event) => {
      if (event.detail?.severity === shaka.util.Error.Severity.CRITICAL)
        onStopped();
    });
    await player.load(grant.manifestUrl);
  } catch (error) {
    await player.destroy();
    throw error;
  }
  return { destroy: () => player.destroy() };
}

const scripts = new Map<string, Promise<void>>();
function loadScript(src: string, module: boolean): Promise<void> {
  const loaded = scripts.get(src);
  if (loaded) return loaded;
  const loading = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    if (module) script.type = "module";
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      scripts.delete(src);
      script.remove();
      reject(new Error("Wistia did not load."));
    };
    document.head.appendChild(script);
  });
  scripts.set(src, loading);
  return loading;
}

/** Wistia web-component player. Access-controlled by enrollment, not DRM. */
export async function loadWistia(mediaHashedId: string): Promise<void> {
  await Promise.all([
    loadScript("https://fast.wistia.com/player.js", false),
    loadScript(
      `https://fast.wistia.com/embed/${encodeURIComponent(mediaHashedId)}.js`,
      true,
    ),
  ]);
}
