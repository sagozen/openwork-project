import type { APIRoute } from "astro";
import type { SignedIn } from "@mytutor/plugin-mytutor-lms/model";
import {
  BRIDGE_HEADERS,
  fail,
  LEGACY_COOKIE,
  readBridgeRequest,
  setCookie,
  SIGN_IN_COOKIE,
  STUDENT_COOKIE,
} from "../../../lib/bridge";
import { pluginCall, type AuthAction } from "../../../lib/lms";

const actions: Record<string, AuthAction> = {
  start: "auth/start",
  "verify-code": "auth/verify-code",
  "verify-link": "auth/verify-link",
  upgrade: "auth/upgrade",
  "exchange-invitation": "auth/exchange-invitation",
  logout: "auth/logout",
  "logout-all": "auth/logout-all",
};
const BINDING_TTL = 15 * 60 * 1000;

function randomHex() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export const POST: APIRoute = async ({
  request,
  params,
  url,
  cookies,
  locals,
  clientAddress,
}) => {
  const action = actions[params.action ?? ""];
  if (!action) return fail(404, "NOT_FOUND", "This action does not exist.");
  try {
    const read = await readBridgeRequest(request, url, 4 * 1024);
    if ("response" in read) return read.response;
    // Pre-auth binding: a sign-in link only completes silently in the browser that asked for it.
    let binding = cookies.get(SIGN_IN_COOKIE)?.value ?? "";
    if (!/^[a-f0-9]{64}$/.test(binding)) binding = randomHex();
    if (action === "auth/start" || action === "auth/upgrade")
      setCookie(
        cookies,
        url,
        SIGN_IN_COOKIE,
        binding,
        new Date(Date.now() + BINDING_TTL),
      );
    let ip = request.headers.get("cf-connecting-ip") ?? "";
    if (!ip && import.meta.env.MYTUTOR_TRUST_PROXY === "1")
      ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "";
    if (!ip) {
      try {
        ip = clientAddress ?? "";
      } catch {
        ip = "";
      }
    }
    const headers: Record<string, string> = {
      "x-mytutor-binding": binding,
      "user-agent": request.headers.get("user-agent") ?? "",
      ...(ip ? { "x-mytutor-client": ip } : {}),
    };
    const student = cookies.get(STUDENT_COOKIE)?.value;
    if (student) headers["x-mytutor-student"] = student;
    const legacy = cookies.get(LEGACY_COOKIE)?.value;
    const result = await pluginCall<unknown>(
      locals,
      url,
      action,
      read.input,
      action === "auth/upgrade" ? legacy : undefined,
      headers,
    );
    if (!result.ok)
      return Response.json(result, {
        status:
          result.error.code === "UNAVAILABLE"
            ? 503
            : result.error.code === "RATE_LIMITED"
              ? 429
              : 400,
        headers: BRIDGE_HEADERS,
      });
    const data = result.data as Partial<SignedIn> & { courseId?: string };
    if (typeof data.sessionToken === "string" && data.expiresAt) {
      setCookie(
        cookies,
        url,
        STUDENT_COOKIE,
        data.sessionToken,
        new Date(data.expiresAt),
      );
      cookies.delete(SIGN_IN_COOKIE, { path: "/" });
      // The account replaces the invitation session in this browser.
      cookies.delete(LEGACY_COOKIE, { path: "/" });
      return Response.json(
        {
          ok: true,
          data: {
            signedIn: true,
            student: data.student,
            courseId: data.courseId ?? null,
          },
        },
        { headers: BRIDGE_HEADERS },
      );
    }
    if (action === "auth/logout" || action === "auth/logout-all")
      cookies.delete(STUDENT_COOKIE, { path: "/" });
    return Response.json(result, { headers: BRIDGE_HEADERS });
  } catch {
    return fail(
      503,
      "UNAVAILABLE",
      "Your request could not be completed. Please try again.",
    );
  }
};
export const ALL: APIRoute = () =>
  new Response(null, {
    status: 405,
    headers: { ...BRIDGE_HEADERS, Allow: "POST" },
  });
