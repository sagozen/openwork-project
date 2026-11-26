/**
 * Optional owner-only mode. An app that sets `OWNER_EMAILS` (comma separated) accepts sign-in from
 * those addresses and nobody else; an app that leaves it unset is unaffected.
 */

/** The normalized owner list, or null when the app is not in owner-only mode. */
export function ownerEmails(env: { OWNER_EMAILS?: string }): string[] | null {
  if (env.OWNER_EMAILS === undefined) return null;
  return env.OWNER_EMAILS.split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.includes("@"));
}

/** True when the address is on the owner list. An empty list in owner-only mode admits nobody. */
export function isOwnerEmail(email: unknown, owners: string[]): boolean {
  return typeof email === "string" && owners.includes(email.trim().toLowerCase());
}
