/**
 * HTML for the public share pages. Plain strings, no script anywhere: the pages work under a
 * policy that allows no script at all, and every value that came from a user is escaped.
 */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`;
}

/**
 * Nothing runs script, and media or frames may load from the object store only. Navigation to the
 * object store (the download redirect) is not restricted by this policy.
 */
export function sharePageCsp(storageOrigin: string): string {
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `img-src ${storageOrigin}`,
    `media-src ${storageOrigin}`,
    `frame-src ${storageOrigin}`,
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** Headers every share page and redirect carries: never cached, never indexed, no referrer. */
export function sharePageHeaders(storageOrigin: string): Record<string, string> {
  return {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": sharePageCsp(storageOrigin),
    "referrer-policy": "no-referrer",
    "x-robots-tag": "noindex, nofollow, noarchive",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  };
}

const STYLE = `
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; padding: 24px; background: Canvas; color: CanvasText; }
  main { max-width: 760px; margin: 0 auto; }
  h1 { font-size: 1.4rem; margin: 0 0 8px; word-break: break-word; }
  p { margin: 8px 0; }
  .muted { opacity: .7; font-size: .9rem; }
  .card { border: 1px solid color-mix(in srgb, CanvasText 20%, transparent); border-radius: 10px; padding: 20px; margin-top: 16px; }
  .btn, button { display: inline-block; font: inherit; padding: 8px 16px; border-radius: 8px; border: 1px solid color-mix(in srgb, CanvasText 35%, transparent); background: Canvas; color: CanvasText; text-decoration: none; cursor: pointer; }
  .primary { background: #2563eb; border-color: #2563eb; color: #fff; }
  input[type=password] { font: inherit; padding: 8px 10px; width: 100%; box-sizing: border-box; margin: 8px 0 12px; }
  .error { color: #b91c1c; }
  .preview { margin-top: 16px; }
  .preview img, .preview video { max-width: 100%; height: auto; border-radius: 8px; }
  .preview audio { width: 100%; }
  .preview iframe { width: 100%; height: 70vh; border: 1px solid color-mix(in srgb, CanvasText 20%, transparent); border-radius: 8px; }
  ul.files { list-style: none; padding: 0; margin: 16px 0 0; }
  ul.files li { display: flex; gap: 12px; align-items: center; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid color-mix(in srgb, CanvasText 15%, transparent); }
  ul.files .name { word-break: break-word; }
  .actions { display: flex; gap: 8px; flex-shrink: 0; }
`;

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow, noarchive">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

/** 404 and 410 pages. They say nothing about the file, only that the link does not work. */
export function statusPage(status: 404 | 410): string {
  return status === 404
    ? layout("Link not found", `<h1>This link does not exist</h1><p class="muted">Check the address and try again.</p>`)
    : layout(
        "Link unavailable",
        `<h1>This link is no longer available</h1><p class="muted">It was switched off, has expired, or the files are gone.</p>`,
      );
}

/** The only thing shown before the password is right: no title, no file name, no size, no type. */
export function passwordPage(options: { token: string; error?: string }): string {
  return layout(
    "Password required",
    `<h1>This link is password-protected</h1>
<form class="card" method="post" action="/s/${escapeHtml(options.token)}">
  <label for="password">Password</label>
  <input id="password" name="password" type="password" autocomplete="off" autofocus required maxlength="200">
  ${options.error ? `<p class="error" role="alert">${escapeHtml(options.error)}</p>` : ""}
  <button class="primary" type="submit">Continue</button>
</form>`,
  );
}

export interface ViewerFile {
  id: string;
  name: string;
  mime: string;
  size: number | null;
  /** Whether a browser may show the file in place. */
  inlineSafe: boolean;
}

export type PreviewKind = "image" | "video" | "audio" | "pdf" | "text" | null;

export function previewKind(mime: string): PreviewKind {
  const type = mime.split(";")[0].trim().toLowerCase();
  if (["image/png", "image/jpeg", "image/webp", "image/gif"].includes(type)) return "image";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  if (type === "application/pdf") return "pdf";
  if (type === "text/plain") return "text";
  return null;
}

function previewHtml(kind: PreviewKind, url: string, name: string): string {
  const src = escapeHtml(url);
  const label = escapeHtml(name);
  switch (kind) {
    case "image":
      return `<img src="${src}" alt="${label}">`;
    case "video":
      return `<video src="${src}" controls preload="metadata"></video>`;
    case "audio":
      return `<audio src="${src}" controls preload="metadata"></audio>`;
    case "pdf":
      return `<iframe src="${src}" title="${label}"></iframe>`;
    case "text":
      return `<iframe src="${src}" title="${label}" sandbox></iframe>`;
    default:
      return "";
  }
}

/** One file: a preview when the browser can show it, and a download button. */
export function singleFilePage(options: {
  token: string;
  title: string | null;
  file: ViewerFile;
  previewUrl: string | null;
}): string {
  const { file } = options;
  const kind = options.previewUrl && file.inlineSafe ? previewKind(file.mime) : null;
  const heading = options.title ?? file.name;
  return layout(
    heading,
    `<h1>${escapeHtml(heading)}</h1>
<p class="muted">${escapeHtml(file.name)}${file.size === null ? "" : ` · ${escapeHtml(formatBytes(file.size))}`}</p>
<p><a class="btn primary" href="/s/${escapeHtml(options.token)}/d/${escapeHtml(file.id)}">Download</a></p>
${kind ? `<div class="preview">${previewHtml(kind, options.previewUrl as string, file.name)}</div>` : ""}`,
  );
}

/** Several files: a list with view (when safe) and download for each. */
export function bundlePage(options: { token: string; title: string | null; files: ViewerFile[] }): string {
  const heading = options.title ?? "Shared files";
  const rows = options.files
    .map(
      (file) => `<li>
  <div><div class="name">${escapeHtml(file.name)}</div><div class="muted">${escapeHtml(formatBytes(file.size))}</div></div>
  <div class="actions">${
    file.inlineSafe ? `<a class="btn" href="/s/${escapeHtml(options.token)}/v/${escapeHtml(file.id)}">View</a>` : ""
  }<a class="btn primary" href="/s/${escapeHtml(options.token)}/d/${escapeHtml(file.id)}">Download</a></div>
</li>`,
    )
    .join("\n");
  return layout(heading, `<h1>${escapeHtml(heading)}</h1><ul class="files">${rows}</ul>`);
}
