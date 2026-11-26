import { classifyHost } from "./sources";

/**
 * `/{https://…}` lands on the form with the link filled in. Only paths that look like a link
 * qualify: an http(s) scheme, a `www.` host, or a host the product knows. Everything else is a
 * plain 404 so typos do not turn into odd prefilled links.
 */
export function linkFromPath(pathname: string, search = ""): string | null {
  let raw = pathname.replace(/^\/+/, "");
  try {
    raw = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (!raw) return null;
  // Some proxies collapse `https://` to `https:/` inside a path.
  const scheme = /^https?:\/{1,2}/i.exec(raw);
  if (scheme) {
    const rest = raw.slice(scheme[0].length);
    return rest ? `https://${rest}${search}` : null;
  }
  const host = raw.split(/[/?#]/, 1)[0].toLowerCase();
  if (!host.includes(".")) return null;
  if (host.startsWith("www.") || classifyHost(host)) return `https://${raw}${search}`;
  return null;
}
