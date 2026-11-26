/**
 * Mini apps serve many tenants from one origin, so nothing a tenant uploads or types may run
 * script. Logos are raster-only (see branding/upload), brand strings are escaped by the
 * framework, and these headers close the remaining doors: no framing, no plugins, no foreign
 * form targets, no MIME sniffing.
 *
 * `script-src` keeps `'unsafe-inline'` because Astro and React islands emit inline bootstrap
 * scripts; every other directive is as tight as the pages allow.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/** Policy for user-uploaded files: render nothing active even if opened directly. */
export const UPLOAD_CONTENT_SECURITY_POLICY = "default-src 'none'; sandbox";

export function securityHeaders(): Record<string, string> {
  return {
    "content-security-policy": CONTENT_SECURITY_POLICY,
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "strict-origin-when-cross-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
  };
}

/** Returns a copy of `response` with the security headers set, leaving explicit ones alone. */
export function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(securityHeaders())) {
    if (!headers.has(name)) headers.set(name, value);
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * Session cookie attributes for tenant-facing apps. No `Domain` attribute: the cookie is bound
 * to the exact host, so one app's session never reaches a sibling app on another subdomain.
 */
export function sessionCookieAttributes(secure: boolean): string {
  return `Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}
