import { isOwnerEmail, ownerEmails } from "@templatedesign/platform/owner";

/**
 * True when `email` is on the `OWNER_EMAILS` list. The platform refuses sign-in for everyone else
 * when the list is set; this check is the app's own gate and fails closed, so an unset or empty list
 * admits nobody instead of leaving the app open.
 */
export function isOwner(email: unknown, env: { OWNER_EMAILS?: string }): boolean {
  return isOwnerEmail(email, ownerEmails(env) ?? []);
}
