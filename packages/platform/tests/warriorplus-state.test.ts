import assert from "node:assert/strict";
import test from "node:test";
import { chicagoToUtc, isEligible, nextState, periodEndWithGrace } from "../src/warriorplus/state";
import type { PurchaseState } from "../src/warriorplus/types";

const base: PurchaseState = {
  status: "active",
  lastPaymentNum: null,
  lastGrantedPaymentNum: null,
  currentPeriodEnd: null,
  revokedAt: null,
  reviewReason: null,
};

function event(action: string, kind: "one_time" | "recurring", extra: Partial<Parameters<typeof nextState>[1]> = {}) {
  return { action, kind, now: "2026-11-03T00:00:00.000Z", ...extra };
}

test("Chicago local time converts across both DST transitions", () => {
  assert.equal(chicagoToUtc("2026-03-08 01:30:00"), "2026-03-08T07:30:00.000Z");
  assert.equal(chicagoToUtc("2026-03-08 03:30:00"), "2026-03-08T08:30:00.000Z");
  assert.equal(chicagoToUtc("2026-11-01 01:30:00"), "2026-11-01T06:30:00.000Z");
  assert.equal(chicagoToUtc(""), null);
  assert.equal(periodEndWithGrace("2026-12-01 00:00:00"), "2026-12-04T06:00:00.000Z");
  assert.equal(periodEndWithGrace(""), null);
});

test("a refund before sale acts as a tombstone", () => {
  const refunded = nextState(base, event("refund", "one_time"));
  assert.equal(refunded.state.status, "refunded");
  const sale = nextState(refunded.state, event("sale", "one_time"));
  assert.equal(sale.changed, false);
  assert.match(sale.ignoredReason ?? "", /tombstone/);
});

test("refund_reversal reactivates and dispute alerts", () => {
  const refunded = nextState(base, event("refund", "one_time")).state;
  const reversed = nextState(refunded, event("refund_reversal", "one_time"));
  assert.equal(reversed.state.status, "active");
  assert.equal(reversed.state.revokedAt, null);
  const disputed = nextState(base, event("dispute", "one_time"));
  assert.equal(disputed.state.status, "disputed");
  assert.deepEqual(disputed.effects, ["alert_dispute"]);
});

test("a completed subscription before created still lands on one period", () => {
  const completed = nextState(
    base,
    event("subscr_completed", "recurring", { paymentNum: 1, nextPaymentDate: "2026-12-01 00:00:00" }),
  );
  assert.equal(completed.state.status, "active");
  assert.equal(completed.state.lastPaymentNum, 1);
  assert.equal(completed.state.currentPeriodEnd, "2026-12-04T06:00:00.000Z");
  assert.deepEqual(completed.effects, ["grant_credits"]);
  const created = nextState(completed.state, event("subscr_created", "recurring", { paymentNum: 1 }));
  assert.equal(created.state.currentPeriodEnd, "2026-12-04T06:00:00.000Z");
  assert.deepEqual(created.effects, []);
});

test("cancelled keeps access until the period ends and a late payment cannot reopen it", () => {
  const active = nextState(
    base,
    event("subscr_created", "recurring", { paymentNum: 2, nextPaymentDate: "2026-12-01 00:00:00" }),
  ).state;
  const cancelled = nextState(active, event("subscr_cancelled", "recurring", { paymentNum: 2 }));
  assert.equal(cancelled.state.status, "cancelled");
  assert.equal(cancelled.state.currentPeriodEnd, active.currentPeriodEnd);
  const late = nextState(cancelled.state, event("subscr_completed", "recurring", { paymentNum: 1 }));
  assert.equal(late.changed, false);
  assert.match(late.ignoredReason ?? "", /stale/);
});

test("ended is terminal until a higher payment number arrives", () => {
  const active = nextState(
    base,
    event("subscr_completed", "recurring", { paymentNum: 4, nextPaymentDate: "2026-12-01 00:00:00" }),
  ).state;
  const ended = nextState(active, event("subscr_ended", "recurring", { paymentNum: 4 }));
  assert.equal(ended.state.status, "ended");
  const resend = nextState(ended.state, event("subscr_completed", "recurring", { paymentNum: 4 }));
  assert.equal(resend.changed, false);
  const higher = nextState(ended.state, event("subscr_completed", "recurring", { paymentNum: 5 }));
  assert.equal(higher.state.status, "active");
});

test("an empty next-payment date never overwrites the stored period end", () => {
  const active = nextState(
    base,
    event("subscr_created", "recurring", { paymentNum: 1, nextPaymentDate: "2026-12-01 00:00:00" }),
  ).state;
  const empty = nextState(active, event("subscr_completed", "recurring", { paymentNum: 2, nextPaymentDate: "" }));
  assert.equal(empty.state.currentPeriodEnd, active.currentPeriodEnd);
});

test("failed payments email without losing access; suspension does", () => {
  const active = nextState(
    base,
    event("subscr_created", "recurring", { paymentNum: 1, nextPaymentDate: "2026-12-01 00:00:00" }),
  ).state;
  const failed = nextState(active, event("subscr_failed_declined", "recurring", { paymentNum: 2 }));
  assert.equal(failed.state.status, "active");
  assert.deepEqual(failed.effects, ["payment_failed_email"]);
  const suspended = nextState(active, event("subscr_suspended", "recurring"));
  assert.equal(suspended.state.status, "suspended");
  const reactivated = nextState(suspended.state, event("subscr_reactivated", "recurring"));
  assert.equal(reactivated.state.status, "active");
});

test("a reversed recurring refund is flagged as a chargeback", () => {
  const refunded = nextState(base, event("subscr_refunded", "recurring", { paymentNum: 2, paymentStatus: "REVERSED" }));
  assert.equal(refunded.state.status, "refunded");
  assert.equal(refunded.state.reviewReason, "chargeback");
  assert.deepEqual(refunded.effects, ["revoke_credits"]);
});

test("eligibility follows the paid period", () => {
  const now = "2026-11-15T00:00:00.000Z";
  assert.equal(isEligible("active", null, now), true);
  assert.equal(isEligible("cancelled", "2026-11-20T00:00:00.000Z", now), true);
  assert.equal(isEligible("cancelled", "2026-11-01T00:00:00.000Z", now), false);
  assert.equal(isEligible("refunded", null, now), false);
  assert.equal(isEligible("suspended", null, now), false);
});
