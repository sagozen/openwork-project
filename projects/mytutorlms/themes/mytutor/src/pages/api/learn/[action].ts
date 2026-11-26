import type { APIRoute } from "astro";
import {
  BRIDGE_HEADERS,
  fail,
  LEGACY_COOKIE,
  readBridgeRequest,
  STUDENT_COOKIE,
} from "../../../lib/bridge";
import { pluginCall, type StudentAction } from "../../../lib/lms";

/** Bridge action → plugin route. */
const actions: Record<string, StudentAction> = {
  library: "library",
  complete: "complete",
  submit: "submit",
  playback: "playback",
  playbackEnd: "playbackEnd",
  logout: "logout",
  dashboard: "dashboard",
  classroom: "classroom",
  me: "me",
  "me-update": "me/update",
  "me-revoke-session": "me/revoke-session",
  join: "join",
};
// Actions that need a student account; an invitation session cannot use them.
const accountOnly = new Set(["join"]);
// Writes that must stay with the enrollment the tab loaded.
const enrollmentBound = new Set([
  "complete",
  "submit",
  "playback",
  "playbackEnd",
  "logout",
]);

export const POST: APIRoute = async ({
  request,
  params,
  url,
  cookies,
  locals,
}) => {
  const action = actions[params.action ?? ""];
  if (!action) return fail(404, "NOT_FOUND", "This action does not exist.");
  try {
    const read = await readBridgeRequest(
      request,
      url,
      action === "submit" ? 32 * 1024 : 8 * 1024,
    );
    if ("response" in read) return read.response;
    const student = cookies.get(STUDENT_COOKIE)?.value;
    const legacy = cookies.get(LEGACY_COOKIE)?.value;
    const expectedEnrollment = request.headers.get("x-mytutor-enrollment");
    const headers: Record<string, string> = {};
    let token: string | undefined;
    if (student) {
      // An account session; the plugin derives the enrollment and checks the tab's precondition.
      headers["x-mytutor-student"] = student;
      if (expectedEnrollment)
        headers["x-mytutor-enrollment"] = expectedEnrollment;
    } else {
      if (!legacy || accountOnly.has(action))
        return fail(401, "AUTH_REQUIRED", "Sign in to open your courses.");
      // The legacy cookie is shared across tabs; bind writes to the enrollment the tab loaded.
      if (
        enrollmentBound.has(action) &&
        (!expectedEnrollment || expectedEnrollment !== legacy.slice(0, 64))
      )
        return fail(
          409,
          "SESSION_CHANGED",
          "Your learning session changed in another tab. Check for feedback to open the current enrollment; your unsent draft has been kept.",
        );
      token = legacy;
    }
    const result = await pluginCall<unknown>(
      locals,
      url,
      action,
      read.input,
      token,
      headers,
    );
    if (!result.ok)
      return Response.json(result, {
        status:
          result.error.code === "UNAVAILABLE"
            ? 503
            : result.error.code === "SESSION_CHANGED"
              ? 409
              : result.error.code === "AUTH_REQUIRED"
                ? 401
                : 400,
        headers: BRIDGE_HEADERS,
      });
    // A signed-out invitation session leaves no cookie behind on shared computers.
    if (action === "logout" && !student)
      cookies.delete(LEGACY_COOKIE, { path: "/" });
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
