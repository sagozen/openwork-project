/**
 * SSRF guard for `import_from_url`. The Worker only ever fetches a public https URL: no embedded
 * credentials, no port other than 443, no private, loopback, link-local or otherwise reserved
 * address (checked on literals and on every address the host resolves to), and every redirect is
 * validated again before it is followed.
 */

export class FetchGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FetchGuardError";
  }
}

/** Resolves a host name to its IPv4 and IPv6 addresses. Rejects when the host does not resolve. */
export type HostResolver = (hostname: string) => Promise<string[]>;

const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";
const DNS_TYPES = { A: 1, AAAA: 28 } as const;

/**
 * Resolves through DNS-over-HTTPS, because a Worker has no resolver of its own. A failed lookup, a
 * missing host and an answer with no address all reject, so the guard fails closed.
 */
export function dohResolver(transport: typeof fetch = fetch): HostResolver {
  const lookup = async (hostname: string, type: "A" | "AAAA") => {
    const response = await transport(`${DOH_ENDPOINT}?name=${encodeURIComponent(hostname)}&type=${type}`, {
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new FetchGuardError("The host could not be looked up.");
    const body = (await response.json()) as { Status?: number; Answer?: Array<{ type: number; data: string }> };
    if (body.Status !== 0) return [];
    return (body.Answer ?? []).filter((answer) => answer.type === DNS_TYPES[type]).map((answer) => answer.data);
  };
  return async (hostname) => {
    let addresses: string[];
    try {
      addresses = (await Promise.all([lookup(hostname, "A"), lookup(hostname, "AAAA")])).flat();
    } catch (error) {
      if (error instanceof FetchGuardError) throw error;
      throw new FetchGuardError("The host could not be looked up.");
    }
    if (addresses.length === 0) throw new FetchGuardError("The host does not resolve to an address.");
    return addresses;
  };
}

/* ------------------------------------------------------------------ addresses */

function parseIPv4(text: string): number[] | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : null;
}

function blockedIPv4([a, b, c]: number[]): boolean {
  return (
    a === 0 || // "this" network
    a === 10 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    a === 127 ||
    (a === 169 && b === 254) || // link-local, including cloud metadata services
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) || // IETF protocol assignments
    (a === 192 && b === 0 && c === 2) || // documentation
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224 // multicast, reserved and broadcast
  );
}

function parseIPv6(text: string): number[] | null {
  if (text.includes("%")) return null;
  let value = text;
  const lastColon = value.lastIndexOf(":");
  if (value.includes(".")) {
    const octets = parseIPv4(value.slice(lastColon + 1));
    if (!octets) return null;
    value = `${value.slice(0, lastColon + 1)}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const read = (part: string) => (part === "" ? [] : part.split(":"));
  const head = read(halves[0]);
  const tail = halves.length === 2 ? read(halves[1]) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (groups.length !== 8 || !groups.every((group) => /^[0-9a-f]{1,4}$/i.test(group))) return null;
  return groups.map((group) => Number.parseInt(group, 16));
}

function blockedIPv6(groups: number[]): boolean {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
  const embedded = [g6 >> 8, g6 & 255, g7 >> 8, g7 & 255];
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0) {
    // ::, ::1 and the deprecated IPv4-compatible range are blocked; IPv4-mapped follows IPv4 rules.
    return g5 === 0xffff ? blockedIPv4(embedded) : true;
  }
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return blockedIPv4(embedded); // NAT64
  if (g0 === 0x2002) return blockedIPv4([g1 >> 8, g1 & 255, g2 >> 8, g2 & 255]); // 6to4
  if (g0 === 0x2001 && (g1 === 0 || g1 === 0x0db8)) return true; // Teredo, documentation
  // Only global unicast (2000::/3) is allowed; unique-local, link-local, multicast and the rest are not.
  return (g0 & 0xe000) !== 0x2000;
}

/** True for any address a public fetch must never reach. Text that is not an IP address is blocked too. */
export function isBlockedAddress(address: string): boolean {
  const text = address.trim().replace(/^\[|\]$/g, "");
  const v4 = parseIPv4(text);
  if (v4) return blockedIPv4(v4);
  const v6 = parseIPv6(text);
  return v6 ? blockedIPv6(v6) : true;
}

/* ------------------------------------------------------------------------ URLs */

const INTERNAL_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain", ".home.arpa", ".lan", ".intranet"];

/** A fetchable URL: https, no credentials, port 443, and a public host. Throws a `FetchGuardError` otherwise. */
export function assertPublicHttpsUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FetchGuardError("The URL is not valid.");
  }
  if (url.protocol !== "https:") throw new FetchGuardError("Only https URLs can be imported.");
  if (url.username || url.password) throw new FetchGuardError("A URL with a user name or password is not allowed.");
  if (url.port && url.port !== "443") throw new FetchGuardError("Only the standard https port can be imported from.");
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const isLiteral = host.startsWith("[") || /^\d+\.\d+\.\d+\.\d+$/.test(host);
  if (isLiteral) {
    if (isBlockedAddress(host)) throw new FetchGuardError("The URL points to a private or reserved address.");
  } else if (!host.includes(".") || INTERNAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw new FetchGuardError("The URL points to an internal host name.");
  }
  return url;
}

async function assertHostIsPublic(url: URL, resolve: HostResolver): Promise<void> {
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[") || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return;
  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch (error) {
    throw error instanceof FetchGuardError ? error : new FetchGuardError("The host could not be looked up.");
  }
  if (addresses.length === 0 || addresses.some(isBlockedAddress)) {
    throw new FetchGuardError("The URL points to a private or reserved address.");
  }
}

/* ----------------------------------------------------------------------- fetch */

export const MAX_REDIRECTS = 3;
const HEADERS_TIMEOUT_MS = 20_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface GuardedFetchOptions {
  fetch?: typeof fetch;
  resolve?: HostResolver;
  maxRedirects?: number;
  /** Time allowed for the response headers of each hop. */
  timeoutMs?: number;
}

/**
 * GET a public https URL. Redirects are followed by hand, at most `maxRedirects` times, and each
 * target goes through the same checks as the first URL. The body is returned unread.
 */
export async function guardedFetch(
  rawUrl: string,
  options: GuardedFetchOptions = {},
): Promise<{ response: Response; url: URL }> {
  const transport = options.fetch ?? fetch;
  const resolve = options.resolve ?? dohResolver(transport);
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  let current = rawUrl;
  for (let hop = 0; ; hop += 1) {
    const url = assertPublicHttpsUrl(current);
    await assertHostIsPublic(url, resolve);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? HEADERS_TIMEOUT_MS);
    let response: Response;
    try {
      response = await transport(url.toString(), {
        method: "GET",
        redirect: "manual",
        headers: { accept: "*/*", "accept-encoding": "identity", "user-agent": "MyArtifacts-Import/1.0" },
        signal: controller.signal,
      });
    } catch {
      throw new FetchGuardError("The URL could not be fetched.");
    } finally {
      clearTimeout(timer);
    }

    if (!REDIRECT_STATUSES.has(response.status)) return { response, url };
    await response.body?.cancel().catch(() => undefined);
    const location = response.headers.get("location");
    if (!location) throw new FetchGuardError("The URL redirected without saying where.");
    if (hop >= maxRedirects) throw new FetchGuardError("The URL redirected too many times.");
    try {
      current = new URL(location, url).toString();
    } catch {
      throw new FetchGuardError("The URL redirected to an invalid address.");
    }
  }
}
