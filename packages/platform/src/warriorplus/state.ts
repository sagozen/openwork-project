import type { PurchaseState, StateChange, StateEvent } from "./types";

export const GRACE_DAYS = 3;

/**
 * Convert WarriorPlus's `YYYY-MM-DD HH:MM:SS` America/Chicago time to a UTC instant.
 * WarriorPlus sends no offset, and the conversion must be right across both DST changes.
 */
export function chicagoToUtc(value: string): string | null {
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second = "00"] = match;
  const localAsUtc = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  let guess = localAsUtc;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  for (let index = 0; index < 4; index += 1) {
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(guess)).map((part) => [part.type, part.value]),
    ) as Record<string, string>;
    const actual = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour) % 24,
      Number(parts.minute),
      Number(parts.second),
    );
    const delta = localAsUtc - actual;
    guess += delta;
    if (delta === 0) break;
  }
  return new Date(guess).toISOString();
}

/** Access runs to the next payment date plus the grace period. */
export function periodEndWithGrace(nextPaymentDate: string | null | undefined): string | null {
  if (!nextPaymentDate) return null;
  const utc = chicagoToUtc(nextPaymentDate);
  if (!utc) return null;
  return new Date(Date.parse(utc) + GRACE_DAYS * 86_400_000).toISOString();
}

function latest(left: string | null, right: string | null): string | null {
  if (!left) return right;
  if (!right) return left;
  return Date.parse(right) > Date.parse(left) ? right : left;
}

/**
 * Pure lifecycle transition. `state` is the stored row; the returned state is what to write.
 * The caller handles persistence, claims, entitlement materialisation and emails.
 */
export function nextState(state: PurchaseState, event: StateEvent): StateChange {
  const unchanged = (ignoredReason: string): StateChange => ({
    state,
    effects: [],
    changed: false,
    ignoredReason,
  });
  const copy: PurchaseState = { ...state };

  if (event.kind === "comp") {
    return { state: copy, effects: [], changed: false, ignoredReason: "comps are not IPN events" };
  }

  const paymentNum = event.paymentNum ?? null;
  const stale =
    event.kind === "recurring" &&
    paymentNum !== null &&
    state.lastPaymentNum !== null &&
    paymentNum < state.lastPaymentNum;
  if (stale) {
    return unchanged(`stale payment ${paymentNum}; the last payment is ${state.lastPaymentNum}`);
  }

  if (event.kind === "one_time") {
    switch (event.action) {
      case "sale":
        if (state.status === "refunded" || state.status === "disputed" || state.status === "revoked") {
          return unchanged("an earlier refund acts as a tombstone");
        }
        copy.status = "active";
        copy.revokedAt = null;
        copy.reviewReason = null;
        return { state: copy, effects: [], changed: true };
      case "refund":
        copy.status = "refunded";
        copy.revokedAt = event.now;
        return { state: copy, effects: [], changed: true };
      case "refund_reversal":
        copy.status = "active";
        copy.revokedAt = null;
        return { state: copy, effects: [], changed: true };
      case "dispute":
        copy.status = "disputed";
        return { state: copy, effects: ["alert_dispute"], changed: true };
      default:
        return unchanged(`unhandled one-time action ${event.action}`);
    }
  }

  // Recurring subscription events.
  const reopened = paymentNum !== null && (state.lastPaymentNum === null || paymentNum > state.lastPaymentNum);
  const mayLeaveEnded = state.status !== "ended" || reopened;

  switch (event.action) {
    case "sale":
      if (state.status === "ended") return unchanged("an ended subscription is terminal");
      copy.status = "active";
      return { state: copy, effects: [], changed: true };
    case "subscr_created":
    case "subscr_completed": {
      if (!mayLeaveEnded) return unchanged("an ended subscription is terminal");
      copy.status = "active";
      const isNewPayment = paymentNum !== null && (state.lastPaymentNum === null || paymentNum > state.lastPaymentNum);
      copy.lastPaymentNum =
        paymentNum !== null ? Math.max(paymentNum, state.lastPaymentNum ?? 0) : state.lastPaymentNum;
      copy.currentPeriodEnd = latest(state.currentPeriodEnd, periodEndWithGrace(event.nextPaymentDate));
      // A duplicate `sale` plus `subscr_created` for the same payment must not suggest a second
      // grant. The caller still waits for REST verification before any credit is issued.
      const effect: StateChange["effects"] = isNewPayment ? ["grant_credits"] : [];
      return { state: copy, effects: effect, changed: true };
    }
    case "subscr_failed_declined":
    case "subscr_failed_invalid":
    case "subscr_failed_merchant_unavailable":
      return { state: copy, effects: ["payment_failed_email"], changed: false };
    case "subscr_suspended":
    case "subscr_paused":
      copy.status = "suspended";
      return { state: copy, effects: [], changed: true };
    case "subscr_reactivated":
    case "subscr_resumed":
      if (!mayLeaveEnded) return unchanged("an ended subscription is terminal");
      copy.status = "active";
      return { state: copy, effects: [], changed: true };
    case "subscr_cancelled":
      copy.status = "cancelled";
      return { state: copy, effects: [], changed: true };
    case "subscr_refunded":
      copy.status = "refunded";
      copy.revokedAt = event.now;
      if ((event.paymentStatus ?? "").toUpperCase() === "REVERSED") {
        copy.reviewReason = "chargeback";
      }
      return { state: copy, effects: ["revoke_credits"], changed: true };
    case "subscr_ended":
      copy.status = "ended";
      return { state: copy, effects: [], changed: true };
    default:
      return unchanged(`unhandled subscription action ${event.action}`);
  }
}

/** A status that still grants features right now. */
export function isEligible(status: string, currentPeriodEnd: string | null, now: string): boolean {
  if (status === "active") return true;
  if (status === "cancelled") return Boolean(currentPeriodEnd && Date.parse(currentPeriodEnd) > Date.parse(now));
  return false;
}
