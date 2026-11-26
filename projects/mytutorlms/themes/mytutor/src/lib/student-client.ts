import type { Result, ResultError } from "@mytutor/plugin-mytutor-lms/model";
import type { StudentAction } from "./lms";

export class LearningError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: ResultError["details"],
  ) {
    super(message);
  }
}
/**
 * The course an account-session classroom page shows (`/learn/[courseId]`).
 * Unset on the 0.2 invitation classroom, which keeps its original requests.
 */
let courseContext: string | null = null;
export function setCourseContext(courseId: string | null) {
  courseContext = courseId;
}
export function inCourseContext(): boolean {
  return courseContext !== null;
}

async function post<T>(
  path: string,
  input: unknown,
  enrollmentId?: string,
  keepalive = false,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-MyTutor-Request": "1",
        ...(enrollmentId ? { "X-MyTutor-Enrollment": enrollmentId } : {}),
      },
      body: JSON.stringify(input),
      credentials: "same-origin",
      cache: "no-store",
      keepalive,
    });
  } catch {
    throw new LearningError(
      "NETWORK",
      "You appear to be offline. Reconnect and try again; your saved progress is safe.",
    );
  }
  let result: Result<T>;
  try {
    result = await response.json();
  } catch {
    throw new LearningError(
      "UNAVAILABLE",
      "The learning space is temporarily unavailable. Please try again.",
    );
  }
  if (!result.ok)
    throw new LearningError(
      result.error.code,
      result.error.message,
      result.error.details,
    );
  if (!response.ok)
    throw new LearningError(
      "UNAVAILABLE",
      "The request could not be completed. Please try again.",
    );
  return result.data;
}

/** Bridge action names; account routes with a slash use a dash in the URL. */
type BridgeAction = StudentAction | "me-update" | "me-revoke-session";

export async function studentRequest<T>(
  action: BridgeAction,
  input: unknown = {},
  enrollmentId?: string,
): Promise<T> {
  let bridgeAction: string = action;
  let body = input;
  if (courseContext) {
    // Account sessions name the course on every classroom request.
    if (action === "library") {
      bridgeAction = "classroom";
      body = { courseId: courseContext };
    } else if (action === "complete" || action === "submit")
      body = { ...(input as object), courseId: courseContext };
    else if (action === "logout") return authRequest<T>("logout");
  }
  // keepalive lets a final playbackEnd finish while the page is closing.
  return post<T>(
    `/api/learn/${bridgeAction}`,
    body,
    enrollmentId,
    action === "playbackEnd",
  );
}

/**
 * "Start learning" on an open course, then opens its classroom. Without a
 * signed-in account it goes to sign-in and returns to `returnTo` afterwards.
 */
export async function startOpenCourse(
  courseId: string,
  returnTo: string,
): Promise<void> {
  try {
    await post<unknown>("/api/learn/join", { courseId });
  } catch (cause) {
    if (cause instanceof LearningError && cause.code === "AUTH_REQUIRED") {
      window.location.assign(`/sign-in?next=${encodeURIComponent(returnTo)}`);
      return;
    }
    throw cause;
  }
  window.location.assign(`/learn/${encodeURIComponent(courseId)}`);
}

export function authRequest<T>(
  action: string,
  input: unknown = {},
): Promise<T> {
  return post<T>(`/api/auth/${action}`, input);
}
