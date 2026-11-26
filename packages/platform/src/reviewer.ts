/**
 * Optional passcode sign-in for one named reviewer (for example a WarriorPlus offer reviewer who
 * cannot read an inbox). It is off unless `REVIEWER_EMAIL` is set, so every other app and
 * environment keeps magic-link and Google sign-in only.
 */

/** The normalized reviewer email, or null when reviewer sign-in is not configured. */
export function reviewerEmail(env: { REVIEWER_EMAIL?: string }): string | null {
  const value = env.REVIEWER_EMAIL?.trim().toLowerCase();
  return value && value.includes("@") ? value : null;
}

/** True when a password sign-in attempt names the configured reviewer and nobody else. */
export function isReviewerSignIn(attempted: unknown, reviewer: string): boolean {
  return typeof attempted === "string" && attempted.trim().toLowerCase() === reviewer;
}
