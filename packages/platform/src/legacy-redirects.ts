export type LegacyApp = "web" | "transcript";

export interface LegacyRedirect {
  /** Path plus query, always same-origin and relative. */
  location: string;
  /** Set when the old URL carried a language (`/vi/...`). */
  setLocale?: "vi";
}

const SHARED_DOCS_ANCHORS: Record<string, string> = {
  quickstart: "quickstart",
  api: "endpoints",
  webhooks: "webhooks",
  limits: "limits",
  errors: "errors",
  changelog: "changelog",
  "guides/n8n": "n8n",
  "concepts/credits": "limits",
  "concepts/security": "authentication",
};

/**
 * Old `/docs/<path>` pages and the heading id they now live under on `/docs`. Each app's docs
 * tests assert that every id here exists in its `src/content/docs.md`.
 */
export const DOCS_ANCHORS: Record<LegacyApp, Record<string, string>> = {
  web: {
    ...SHARED_DOCS_ANCHORS,
    "guides/certificates-from-csv": "templates",
    "concepts/templates": "templates",
    "concepts/test-mode": "test-mode",
  },
  transcript: SHARED_DOCS_ANCHORS,
};

/**
 * Only same-origin paths survive: a leading single slash, no scheme, no protocol-relative `//`,
 * no backslash tricks. Anything else falls back to the landing page.
 */
export function safeNext(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/";
  if ([...value].some((char) => char.charCodeAt(0) < 32)) return "/";
  return value;
}

function withQuery(base: string, params: Record<string, string | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined) query.set(key, value);
  const text = query.toString();
  return text ? `${base}?${text}` : base;
}

function stripTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

/**
 * Maps a retired customer URL to its place on the three-page site, or `null` when the URL is not
 * legacy. Pure on purpose so every row of the table is unit tested.
 */
export function legacyRedirect(url: URL, app: LegacyApp): LegacyRedirect | null {
  const search = url.searchParams;
  let path = stripTrailingSlash(url.pathname);
  let setLocale: "vi" | undefined;

  if (app === "web" && (path === "/vi" || path.startsWith("/vi/"))) {
    setLocale = "vi";
    path = path === "/vi" ? "/" : path.slice(3);
    if (path === "/mau") path = "/templates";
    else if (path.startsWith("/mau/")) path = `/templates/${path.slice(5)}`;
  }

  const result = (location: string): LegacyRedirect => (setLocale ? { location, setLocale } : { location });
  const segments = path.split("/").filter(Boolean);
  const [head, second, third] = segments;

  if (path === "/" && setLocale) return result("/");

  if (head === "pricing" && segments.length === 1) return result("/#pricing");

  if (head === "auth" && (second === "sign-in" || second === "check-email") && segments.length === 2) {
    const next = safeNext(search.get("next"));
    return result(withQuery("/", { signin: "1", next: next === "/" ? undefined : next }));
  }

  if (head === "docs" && segments.length > 1) {
    const anchors = DOCS_ANCHORS[app];
    const key = segments.slice(1).join("/");
    const anchor = Object.hasOwn(anchors, key) ? anchors[key] : undefined;
    return result(anchor ? `/docs#${anchor}` : "/docs");
  }

  if (head === "legal" && (second === "terms" || second === "privacy") && segments.length === 2) {
    return result(`/legal#${second}`);
  }

  if (
    app === "web" &&
    head === "share" &&
    second &&
    (segments.length === 2 || (segments.length === 3 && third === "report"))
  ) {
    return result(withQuery("/", { share: second, report: third === "report" ? "1" : undefined }));
  }

  if (app === "web" && head === "templates" && second === "certificates" && segments.length === 2) {
    return result("/templates");
  }

  if (app === "transcript" && head === "transcript" && second && segments.length === 2) {
    return result(withQuery("/", { job: second }));
  }

  if (head === "app") {
    if (segments.length === 1) return result("/");
    if (second === "credits" && !third) {
      return result(
        withQuery("/", { topup: "1", checkout: search.get("checkout") === "cancelled" ? "cancelled" : undefined }),
      );
    }
    if (second === "credits" && third === "return") {
      const payment = search.get("payment");
      return result(payment ? withQuery("/", { payment }) : withQuery("/", { topup: "1" }));
    }
    if (second === "developers" && !third) return result("/?account=api");
    if (second === "settings" && !third) return result("/?account=settings");
    if (second === "jobs" && !third) return result("/");
    if (second === "jobs" && third && segments.length === 3) return result(withQuery("/", { job: third }));
    if (app === "web") {
      if ((second === "templates" || second === "assets") && !third) return result("/");
      if (second === "use" && third && segments.length === 3) return result(withQuery("/", { template: third }));
      if (second === "batch" && third && segments.length === 3) return result(withQuery("/", { batch: third }));
      if (second === "editor" && third && segments.length === 3) return result(withQuery("/", { edit: third }));
    }
    return result("/");
  }

  if (setLocale) return result(path);
  return null;
}
