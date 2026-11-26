/** Small formatting helpers for the account and admin pages. */

export { formatBytes } from "./shares/view";

/** `2026-11-22 10:00`, or the fallback for a missing time. */
export function when(iso: string | null | undefined, fallback = "never"): string {
  return iso ? iso.slice(0, 16).replace("T", " ") : fallback;
}

/** The message of a REST error body (`{ error: { message } }`), or a fallback. */
export async function errorMessage(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as { error?: { message?: string }; detail?: string };
  return body.error?.message ?? body.detail ?? fallback;
}
