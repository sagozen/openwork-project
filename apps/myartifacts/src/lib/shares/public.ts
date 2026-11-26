import { parseCookies } from "@templatedesign/platform/csrf";
import { HttpError } from "@templatedesign/platform/http";
import { takeRateLimit } from "@templatedesign/platform/rate-limit";
import { ARTIFACT_ID_PATTERN } from "../storage/keys";
import { isInlineSafe } from "../storage/mime";
import { SHARE_COOKIE_SECONDS, shareCookieName, signShareCookie, verifyPassword, verifyShareCookie } from "./crypto";
import {
  type ResolvedShare,
  recordShareDownload,
  recordShareView,
  resolveShare,
  type ShareDeps,
  ShareUnavailableError,
} from "./service";
import { bundlePage, passwordPage, sharePageHeaders, singleFilePage, statusPage, type ViewerFile } from "./view";

/**
 * The request handlers behind `/s/<token>`. The routes are thin wrappers so the whole public
 * surface can be exercised in tests with plain `Request` objects.
 */

/** Presigned URLs a share page hands out live this long, so revoking a share takes effect within it. */
export const SHARE_LINK_SECONDS = 300;
/** Wrong guesses allowed per share and visitor address per minute, and per share per hour. */
export const PASSWORD_ATTEMPTS_PER_MINUTE = 5;
export const PASSWORD_ATTEMPTS_PER_HOUR = 50;
const MAX_FORM_BYTES = 8 * 1024;

const html = (deps: ShareDeps, body: string, status = 200, extra: Record<string, string> = {}) =>
  new Response(body, { status, headers: { ...sharePageHeaders(deps.storageOrigin), ...extra } });

function unavailable(deps: ShareDeps, error: ShareUnavailableError): Response {
  return html(deps, statusPage(error.status), error.status);
}

/** Resolves the token, or the 404/410 page to send instead. */
async function resolveOrPage(deps: ShareDeps, token: string): Promise<ResolvedShare | Response> {
  try {
    return await resolveShare(deps, token);
  } catch (error) {
    if (error instanceof ShareUnavailableError) return unavailable(deps, error);
    throw error;
  }
}

const nowSeconds = (deps: ShareDeps) => Math.floor((deps.now ?? (() => new Date()))().getTime() / 1000);

/** True when the share has no password, or this browser holds a valid cookie for this token. */
async function isUnlocked(deps: ShareDeps, request: Request, { share }: ResolvedShare): Promise<boolean> {
  if (!share.password_hash || !share.password_salt) return true;
  const cookie = parseCookies(request.headers.get("cookie"))[shareCookieName(share.id)];
  return verifyShareCookie(deps.secret, share.id, share.password_salt, cookie, nowSeconds(deps));
}

function viewerFile(file: ResolvedShare["items"][number]): ViewerFile {
  return { id: file.id, name: file.name, mime: file.mime, size: file.size, inlineSafe: isInlineSafe(file.mime) };
}

const isResponse = (value: ResolvedShare | Response): value is Response => value instanceof Response;

/** GET /s/<token>: the password form, or the viewer. */
export async function renderSharePage(deps: ShareDeps, request: Request, token: string): Promise<Response> {
  const resolved = await resolveOrPage(deps, token);
  if (isResponse(resolved)) return resolved;
  if (!(await isUnlocked(deps, request, resolved))) return html(deps, passwordPage({ token: resolved.share.id }));

  await recordShareView(deps, resolved.share);
  const { share, items } = resolved;
  if (items.length === 1) {
    const file = viewerFile(items[0]);
    // A preview URL is minted only for types a browser may show; everything else gets just the download button.
    const preview = file.inlineSafe
      ? await deps.storage.presignGet(items[0].object_key, {
          filename: file.name,
          contentType: file.mime,
          disposition: "inline",
          ttl: SHARE_LINK_SECONDS,
        })
      : null;
    return html(deps, singleFilePage({ token: share.id, title: share.title, file, previewUrl: preview?.url ?? null }));
  }
  return html(deps, bundlePage({ token: share.id, title: share.title, files: items.map(viewerFile) }));
}

function clientAddress(request: Request): string {
  return request.headers.get("cf-connecting-ip")?.trim() || "unknown";
}

async function readPassword(request: Request): Promise<string> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_FORM_BYTES) return "";
  const text = (await request.text()).slice(0, MAX_FORM_BYTES);
  return new URLSearchParams(text).get("password") ?? "";
}

function cookieHeader(deps: ShareDeps, token: string, value: string): string {
  const secure = new URL(deps.origin).protocol === "https:";
  return `${shareCookieName(token)}=${value}; Path=/s/${token}; Max-Age=${SHARE_COOKIE_SECONDS}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

/**
 * POST /s/<token>: checks the password. Every attempt counts against a per-visitor and a per-share
 * limit, the comparison is constant-time, and a correct password sets a cookie that works for this
 * one token for 12 hours.
 */
export async function submitSharePassword(deps: ShareDeps, request: Request, token: string): Promise<Response> {
  const resolved = await resolveOrPage(deps, token);
  if (isResponse(resolved)) return resolved;
  const { share } = resolved;
  const home = `/s/${share.id}`;
  if (!share.password_hash || !share.password_salt) {
    return new Response(null, { status: 303, headers: { location: home, "cache-control": "no-store" } });
  }

  try {
    await takeRateLimit(deps.db, `share-pw:${share.id}:${clientAddress(request)}`, PASSWORD_ATTEMPTS_PER_MINUTE, 60);
    await takeRateLimit(deps.db, `share-pw:${share.id}`, PASSWORD_ATTEMPTS_PER_HOUR, 3600);
  } catch (error) {
    if (error instanceof HttpError && error.status === 429) {
      return html(
        deps,
        passwordPage({ token: share.id, error: "Too many attempts. Wait a moment and try again." }),
        429,
        {
          "retry-after": new Headers(error.headers).get("retry-after") ?? "60",
        },
      );
    }
    throw error;
  }

  const password = await readPassword(request);
  if (!password || !(await verifyPassword(password, share.password_hash, share.password_salt))) {
    return html(deps, passwordPage({ token: share.id, error: "That password is not right." }), 401);
  }
  const cookie = await signShareCookie(deps.secret, share.id, share.password_salt, nowSeconds(deps));
  return new Response(null, {
    status: 303,
    headers: { location: home, "cache-control": "no-store", "set-cookie": cookieHeader(deps, share.id, cookie) },
  });
}

/**
 * GET /s/<token>/v/<id> and /s/<token>/d/<id>: re-checks the share and the password cookie, counts
 * the visit, and redirects to a 5-minute presigned URL on the object store. A file a browser could
 * run is always an attachment, whichever route asked for it.
 */
export async function redirectToFile(
  deps: ShareDeps,
  request: Request,
  token: string,
  artifactId: string,
  kind: "view" | "download",
): Promise<Response> {
  const resolved = await resolveOrPage(deps, token);
  if (isResponse(resolved)) return resolved;
  if (!(await isUnlocked(deps, request, resolved))) {
    return new Response(null, {
      status: 302,
      headers: { location: `/s/${resolved.share.id}`, "cache-control": "no-store" },
    });
  }
  const file = ARTIFACT_ID_PATTERN.test(artifactId) ? resolved.items.find((item) => item.id === artifactId) : undefined;
  if (!file) return html(deps, statusPage(404), 404);

  if (kind === "download") await recordShareDownload(deps, resolved.share);
  else await recordShareView(deps, resolved.share);
  const link = await deps.storage.presignGet(file.object_key, {
    filename: file.name,
    contentType: file.mime,
    disposition: kind === "view" ? "inline" : "attachment",
    ttl: SHARE_LINK_SECONDS,
  });
  return new Response(null, {
    status: 302,
    headers: {
      location: link.url,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-robots-tag": "noindex, nofollow, noarchive",
    },
  });
}
