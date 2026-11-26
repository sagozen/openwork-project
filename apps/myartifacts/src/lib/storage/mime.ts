/** Content types: what a file is, and whether a browser may render it instead of downloading it. */

export const DEFAULT_MIME = "application/octet-stream";

const MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
  avif: "image/avif",
  heic: "image/heic",
  ico: "image/x-icon",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "text/javascript",
  json: "application/json",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
  zip: "application/zip",
  gz: "application/gzip",
  tar: "application/x-tar",
  "7z": "application/x-7z-compressed",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  epub: "application/epub+zip",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  flac: "audio/flac",
};

/** Matches `type/subtype`, the only shape a Content-Type value is allowed to start with here. */
const MIME_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

/** The media type without parameters, lower-cased. Returns null when it is not a valid `type/subtype`. */
export function essence(value: string | null | undefined): string | null {
  const type = (value ?? "").split(";")[0].trim().toLowerCase();
  return MIME_PATTERN.test(type) ? type : null;
}

export function mimeForExtension(filename: string): string | null {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0 || dot === filename.length - 1) return null;
  return MIME_BY_EXTENSION[filename.slice(dot + 1).toLowerCase()] ?? null;
}

/**
 * The type to store and serve a file with. A valid declared type wins unless it is the generic
 * `application/octet-stream`, in which case the extension decides; with neither, the generic type.
 * The result is always a bare `type/subtype`, so it is safe to put in a header.
 */
export function resolveMime(declared: string | null | undefined, filename: string): string {
  const type = essence(declared);
  if (type && type !== DEFAULT_MIME) return type;
  return mimeForExtension(filename) ?? type ?? DEFAULT_MIME;
}

const INLINE_SAFE = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf", "text/plain"]);

/**
 * True when a browser may render the file in place. Everything else (HTML, SVG, XML, scripts,
 * executables, archives) is served as an attachment so an uploaded file can never run script.
 */
export function isInlineSafe(mime: string | null | undefined): boolean {
  const type = essence(mime);
  if (!type) return false;
  return INLINE_SAFE.has(type) || type.startsWith("video/") || type.startsWith("audio/");
}
