import { HttpError } from "@templatedesign/platform/http";

export type SourceKind =
  | "upload"
  | "gdrive"
  | "onedrive"
  | "dropbox"
  | "direct"
  | "youtube"
  | "tiktok"
  | "facebook"
  | "instagram"
  | "x"
  | "vimeo"
  | "loom"
  | "soundcloud"
  | "rss";

export interface ClassifiedSource {
  kind: SourceKind;
  /** Canonical reference: file id, share token or absolute URL, depending on the kind. */
  ref: string;
  url: string;
  host: string;
  /** A playlist, folder or multi-item page that expands into a checklist. */
  multi: "playlist" | "folder" | null;
  /** The worker needs yt-dlp for this source. */
  ytdlp: boolean;
  /** `drive.google.com` style host used for the UI icon and the per-source kill switch. */
  label: string;
}

const HOSTS: Record<string, SourceKind> = {
  "youtube.com": "youtube",
  "m.youtube.com": "youtube",
  "music.youtube.com": "youtube",
  "youtu.be": "youtube",
  "tiktok.com": "tiktok",
  "vm.tiktok.com": "tiktok",
  "facebook.com": "facebook",
  "www.facebook.com": "facebook",
  "web.facebook.com": "facebook",
  "fb.watch": "facebook",
  "m.facebook.com": "facebook",
  "instagram.com": "instagram",
  "x.com": "x",
  "twitter.com": "x",
  "vimeo.com": "vimeo",
  "loom.com": "loom",
  "soundcloud.com": "soundcloud",
  "drive.google.com": "gdrive",
  "docs.google.com": "gdrive",
  "dropbox.com": "dropbox",
  "dl.dropboxusercontent.com": "dropbox",
  "1drv.ms": "onedrive",
  "onedrive.live.com": "onedrive",
};

const DRM_HOSTS = ["spotify.com", "open.spotify.com", "netflix.com", "music.apple.com", "podcasts.apple.com"];

/** Host suffixes that belong to a source but are not in the exact map. */
const SUFFIXES: Array<{ suffix: string; kind: SourceKind }> = [
  { suffix: ".sharepoint.com", kind: "onedrive" },
  { suffix: ".youtube.com", kind: "youtube" },
  { suffix: ".tiktok.com", kind: "tiktok" },
  { suffix: ".vimeo.com", kind: "vimeo" },
  { suffix: ".loom.com", kind: "loom" },
  { suffix: ".soundcloud.com", kind: "soundcloud" },
  { suffix: ".dropbox.com", kind: "dropbox" },
  { suffix: ".facebook.com", kind: "facebook" },
  { suffix: ".instagram.com", kind: "instagram" },
  { suffix: ".twitter.com", kind: "x" },
];

export function classifyHost(hostname: string): SourceKind | null {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  const exact = HOSTS[host];
  if (exact) return exact;
  for (const entry of SUFFIXES) if (host.endsWith(entry.suffix)) return entry.kind;
  return null;
}

function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");
}

/** Blocks loopback, link-local, private ranges, CGNAT and the cloud metadata address. */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\[|\]/g, "");
  if (["localhost", "localhost.localdomain", "metadata", "metadata.google.internal"].includes(host)) return true;
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".localhost")) return true;
  if (!isIpLiteral(host)) return false;
  if (host.includes(":")) {
    return (
      host === "::1" ||
      host === "::" ||
      host.startsWith("fe80") ||
      host.startsWith("fc") ||
      host.startsWith("fd") ||
      host.startsWith("::ffff:127") ||
      host.startsWith("::ffff:10") ||
      host.startsWith("::ffff:192.168")
    );
  }
  const [a, b] = host.split(".").map(Number);
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  return a >= 224;
}

export function normaliseUrl(raw: string): URL {
  const trimmed = raw.trim();
  if (!trimmed) throw new HttpError("invalid_input", 400, "Paste a link first.");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new HttpError("invalid_input", 400, "That does not look like a link.", { reason: "malformed_url" });
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new HttpError("invalid_input", 400, "Only http and https links are supported.", { reason: "unsupported" });
  }
  if (isPrivateHost(url.hostname)) {
    throw new HttpError("invalid_input", 400, "Private and local addresses are not allowed.", {
      reason: "private_address",
    });
  }
  if (url.protocol !== "https:") {
    throw new HttpError("invalid_input", 400, "Links must use https.", { reason: "insecure_url" });
  }
  return url;
}

function googleDriveId(url: URL): { id: string; folder: boolean } | null {
  const folder = /\/drive\/(?:u\/\d+\/)?folders\/([A-Za-z0-9_-]{10,})/.exec(url.pathname);
  if (folder) return { id: folder[1], folder: true };
  const file = /\/file\/d\/([A-Za-z0-9_-]{10,})/.exec(url.pathname);
  if (file) return { id: file[1], folder: false };
  const id = url.searchParams.get("id");
  if (id) return { id, folder: false };
  return null;
}

function oneDriveRef(url: URL): string {
  return url.toString();
}

/**
 * Classifies a pasted link. Throws `HttpError` with `details.reason` for anything the product
 * refuses, so the UI can map it through `link-errors.ts` (`unsupported`, `drm`, `unsafe`).
 */
export function classifyUrl(raw: string): ClassifiedSource {
  const url = normaliseUrl(raw);
  const host = url.hostname.toLowerCase();
  const kind = classifyHost(host);

  if (!kind) {
    if (DRM_HOSTS.some((drm) => host === drm || host.endsWith(`.${drm}`))) {
      throw new HttpError("invalid_input", 400, "Streaming services with DRM are not supported.", { reason: "drm" });
    }
    // A plain https URL is a direct media link. The probe validates content type and size.
    return {
      kind: "direct",
      ref: url.toString(),
      url: url.toString(),
      host,
      multi: null,
      ytdlp: false,
      label: host,
    };
  }

  if (kind === "gdrive") {
    const drive = googleDriveId(url);
    if (!drive) {
      throw new HttpError("invalid_input", 400, "Open the file in Drive and copy the sharing link.", {
        reason: "unsupported",
      });
    }
    return {
      kind,
      ref: drive.id,
      url: url.toString(),
      host,
      multi: drive.folder ? "folder" : null,
      ytdlp: false,
      label: "drive.google.com",
    };
  }

  if (kind === "onedrive") {
    return {
      kind,
      ref: oneDriveRef(url),
      url: url.toString(),
      host,
      multi: null,
      ytdlp: false,
      label: "onedrive",
    };
  }

  if (kind === "dropbox") {
    const canonical = new URL(url.toString());
    canonical.searchParams.set("dl", "1");
    return {
      kind,
      ref: canonical.toString(),
      url: canonical.toString(),
      host,
      multi: null,
      ytdlp: false,
      label: "dropbox",
    };
  }

  const listId = url.searchParams.get("list");
  const isPlaylistPath = url.pathname === "/playlist" || url.pathname.startsWith("/playlist/");
  const multi = kind === "youtube" && (listId || isPlaylistPath) ? "playlist" : null;
  return {
    kind,
    ref: url.toString(),
    url: url.toString(),
    host,
    multi,
    ytdlp: true,
    label: kind,
  };
}

/** oEmbed hosts whose title/thumbnail the Worker can fetch without a probe job. */
export function oembedEndpoint(source: ClassifiedSource): string | null {
  switch (source.kind) {
    case "youtube":
      return `https://www.youtube.com/oembed?url=${encodeURIComponent(source.url)}&format=json`;
    case "vimeo":
      return `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(source.url)}`;
    case "soundcloud":
      return `https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(source.url)}`;
    case "tiktok":
      return `https://www.tiktok.com/oembed?url=${encodeURIComponent(source.url)}`;
    case "x":
      return `https://publish.twitter.com/oembed?url=${encodeURIComponent(source.url)}`;
    case "loom":
      return `https://www.loom.com/v1/oembed?url=${encodeURIComponent(source.url)}`;
    default:
      return null;
  }
}

/** Admin kill switch names, matching `platform.ts` extra settings. */
export function killSwitchKey(kind: SourceKind): string {
  switch (kind) {
    case "youtube":
      return "source.youtube.enabled";
    case "tiktok":
      return "source.tiktok.enabled";
    case "gdrive":
      return "source.gdrive.enabled";
    case "onedrive":
      return "source.onedrive.enabled";
    case "dropbox":
      return "source.dropbox.enabled";
    default:
      return "source.direct.enabled";
  }
}
