import type { Result } from "@mytutor/plugin-mytutor-lms/model";

export type StudentAction =
  | "exchange"
  | "library"
  | "complete"
  | "submit"
  | "playback"
  | "playbackEnd"
  | "logout"
  | "dashboard"
  | "classroom"
  | "me"
  | "me/update"
  | "me/revoke-session"
  | "join";
export type AuthAction =
  | "auth/start"
  | "auth/verify-code"
  | "auth/verify-link"
  | "auth/upgrade"
  | "auth/exchange-invitation"
  | "auth/logout"
  | "auth/logout-all";
export const SESSION_COOKIE = "mytutor_session";

export async function pluginCall<T>(
  locals: App.Locals,
  url: URL,
  action: StudentAction | AuthAction | "catalog" | "site",
  input: unknown = {},
  token?: string,
  extraHeaders: Record<string, string> = {},
): Promise<Result<T>> {
  const method = action === "catalog" || action === "site" ? "GET" : "POST";
  const headers = new Headers({
    "content-type": "application/json",
    ...extraHeaders,
  });
  if (token) headers.set("x-mytutor-session", token);
  const request = new Request(
    new URL(`/_emdash/api/plugins/mytutor-lms/${action}`, url),
    {
      method,
      headers,
      ...(method === "POST" ? { body: JSON.stringify(input) } : {}),
    },
  );
  const result = await locals.emdash.handlePublicPluginApiRoute(
    "mytutor-lms",
    method,
    `/${action}`,
    request,
  );
  if (!result.success)
    return {
      ok: false,
      error: {
        code: "UNAVAILABLE",
        message:
          "The learning workspace is unavailable. Please try again or contact your instructor.",
      },
    };
  return result.data as Result<T>;
}
