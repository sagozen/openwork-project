import type { AstroCookies } from "astro";

export const BRIDGE_HEADERS = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};
export const STUDENT_COOKIE = "mytutor_student";
export const SIGN_IN_COOKIE = "mytutor_signin";
export const LEGACY_COOKIE = "mytutor_session";

export const fail = (status: number, code: string, message: string) =>
  Response.json(
    { ok: false, error: { code, message } },
    { status, headers: BRIDGE_HEADERS },
  );

export const isLocal = (url: URL) =>
  ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);

/**
 * Shared guard for the browser bridges: same-origin POST with the custom
 * header, JSON only, HTTPS outside localhost, and a streamed size cap.
 * Returns the parsed body or a ready error response.
 */
export async function readBridgeRequest(
  request: Request,
  url: URL,
  limit: number,
): Promise<{ input: unknown } | { response: Response }> {
  if (
    request.headers.get("origin") !== url.origin ||
    request.headers.get("x-mytutor-request") !== "1"
  )
    return {
      response: fail(
        403,
        "FORBIDDEN",
        "Open this page on the course website and try again.",
      ),
    };
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim() !==
    "application/json"
  )
    return { response: fail(415, "INVALID_INPUT", "Send a JSON request.") };
  if (url.protocol !== "https:" && !isLocal(url))
    return {
      response: fail(
        403,
        "HTTPS_REQUIRED",
        "Use the secure HTTPS address of this website.",
      ),
    };
  const reader = request.body?.getReader();
  if (!reader)
    return {
      response: fail(400, "INVALID_INPUT", "A request body is required."),
    };
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return { response: fail(413, "TOO_LARGE", "This request is too large.") };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { input: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return {
      response: fail(400, "INVALID_INPUT", "This request is not valid JSON."),
    };
  }
}

/** Host-only HttpOnly cookie (no Domain), Secure except on local HTTP. */
export function setCookie(
  cookies: AstroCookies,
  url: URL,
  name: string,
  value: string,
  expires: Date,
) {
  cookies.set(name, value, {
    httpOnly: true,
    secure: !isLocal(url) || url.protocol === "https:",
    sameSite: "lax",
    path: "/",
    expires,
  });
}
