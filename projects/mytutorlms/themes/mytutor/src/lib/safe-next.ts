// Where to go after signing in. Only same-origin paths to the learning
// space or a course page are accepted, so a crafted link cannot send a
// student to another site.

const COURSE_ID = "[A-Za-z0-9][A-Za-z0-9_-]{0,79}";
const ALLOWED = new RegExp(
  `^(?:/learn(?:/${COURSE_ID})?(?:\\?lesson=${COURSE_ID})?|/courses/${COURSE_ID})$`,
);
export const NEXT_STORAGE_KEY = "mytutor.signInNext";
/** As long as a sign-in code or link stays valid, with a margin. */
export const NEXT_TTL_MS = 30 * 60 * 1000;

export function safeNext(value: string | null | undefined): string {
  return value && ALLOWED.test(value) ? value : "/learn";
}

type KeyValueStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const browserStorage = (): KeyValueStorage | null => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

/**
 * Remembers where to return after sign-in. Local storage, not session
 * storage, because the emailed link often opens in a new tab.
 */
export function rememberNext(
  next: string,
  storage: KeyValueStorage | null = browserStorage(),
  now = Date.now(),
): void {
  try {
    storage?.setItem(
      NEXT_STORAGE_KEY,
      JSON.stringify({ next: safeNext(next), expiresAt: now + NEXT_TTL_MS }),
    );
  } catch {
    // Storage can be full or blocked; the link then opens My learning.
  }
}

/** The remembered return path, once: validated again, "/learn" when missing or expired. */
export function takeNext(
  storage: KeyValueStorage | null = browserStorage(),
  now = Date.now(),
): string {
  try {
    const raw = storage?.getItem(NEXT_STORAGE_KEY) ?? null;
    storage?.removeItem(NEXT_STORAGE_KEY);
    const value: unknown = raw ? JSON.parse(raw) : null;
    if (
      value &&
      typeof value === "object" &&
      typeof (value as { next?: unknown }).next === "string" &&
      typeof (value as { expiresAt?: unknown }).expiresAt === "number" &&
      (value as { expiresAt: number }).expiresAt > now
    )
      return safeNext((value as { next: string }).next);
  } catch {
    // Unreadable or blocked storage falls back to My learning.
  }
  return "/learn";
}
