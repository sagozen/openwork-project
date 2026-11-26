import { getAdminSettings, resolveAdmin } from "./admin";
import { alertOperators } from "./alerts";
import {
  type CheckoutProvider,
  checkoutUnavailable,
  configuredProvider,
  type NormalizedEvent,
  providerById,
} from "./billing";
import { emitCommerceEvent } from "./commerce-events";
import { type CreditPack, packById, platformConfig } from "./config";
import type { Db } from "./db";
import { HttpError } from "./http";
import {
  attachCheckout,
  createPaymentRow,
  debitPayment,
  findPaymentByCheckoutId,
  findPaymentByProviderPaymentId,
  getPayment,
  getProviderCustomer,
  grantPurchase,
  markPaymentStatus,
  type PaymentRow,
  type ProviderId,
  recordEvent,
  refundCredits,
  saveProviderCustomer,
} from "./payments";
import { takeRateLimit } from "./rate-limit";
import type { AuthUser, PlatformEnv } from "./types";

/**
 * Checkout and webhook orchestration, kept free of Astro so it can be tested directly.
 *
 * Invariants enforced here:
 * - the browser never grants: only a verified webhook (or reconciliation) calls `grantPurchase`;
 * - status reads and the return page never grant;
 * - the amount on a paid event must match the pack price in the platform config.
 */

export interface CheckoutPrincipal {
  tenantId: string;
  userId: string;
  source: "web" | "api";
}

export interface CheckoutBody {
  pack_id?: unknown;
}

const CHECKOUTS_PER_HOUR = 3;
const PAID_ORDERS_PER_DAY = 5;
const REFUND_ATTEMPTS = 3;

function findPack(packId: string): CreditPack {
  const pack = packById(packId);
  if (!pack) throw new HttpError("invalid_input", 400, "Unknown credit pack.", { field: "pack_id" });
  return pack;
}

export async function createCheckoutSession(
  env: PlatformEnv,
  db: Db,
  principal: CheckoutPrincipal,
  user: Pick<AuthUser, "id" | "email" | "emailVerified">,
  body: CheckoutBody,
  idempotencyKey: string | null,
  providerOverride?: CheckoutProvider | null,
): Promise<{ payment_id: string; url: string }> {
  if (principal.source !== "web") {
    throw new HttpError("forbidden", 403, "Checkout requires a signed-in browser session.", {
      reason: "api_key_not_allowed",
    });
  }
  if (!user.emailVerified) {
    throw new HttpError("forbidden", 403, "Verify your email before buying credits.", { reason: "email_unverified" });
  }

  const tenant = await db.first<{ suspended_at: string | null }>("SELECT suspended_at FROM tenants WHERE id = ?", [
    principal.tenantId,
  ]);
  if (tenant?.suspended_at) {
    throw new HttpError("forbidden", 403, "This account is suspended.", { reason: "account_suspended" });
  }

  const settings = await getAdminSettings(db);
  if (settings.pauseCheckout) {
    const actor = await resolveAdmin(db, user, env);
    if (!actor) {
      throw new HttpError("dependency_unavailable", 503, "Checkout is paused.", { reason: "checkout_paused" });
    }
  }

  const provider = providerOverride === undefined ? configuredProvider(env) : providerOverride;
  if (!provider) checkoutUnavailable();

  const packId = typeof body.pack_id === "string" ? body.pack_id : "";
  const pack = findPack(packId);

  if (!idempotencyKey) {
    throw new HttpError("invalid_input", 400, "An Idempotency-Key header is required.", {
      reason: "idempotency_key_required",
    });
  }

  // The idempotent replay is answered before the rate limit so retries of the same intent
  // never burn the hourly budget.
  const payment = await createPaymentRow(db, {
    tenantId: principal.tenantId,
    userId: principal.userId,
    provider: provider.id,
    packId: pack.id,
    credits: pack.credits,
    amountCents: pack.priceCents,
    currency: "USD",
    idempotencyKey,
  });
  if (payment.provider !== provider.id) {
    throw new HttpError("idempotency_conflict", 409, "This idempotency key belongs to another provider.");
  }
  if (payment.provider_checkout_id && payment.checkout_url && ["created", "pending"].includes(payment.status)) {
    return { payment_id: payment.id, url: payment.checkout_url };
  }

  await takeRateLimit(db, `checkout:${principal.tenantId}`, CHECKOUTS_PER_HOUR, 3600);
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  // Refunded orders still consumed the daily allowance, so count anything that was ever paid.
  const paidRecently = await db.first<{ count: number }>(
    "SELECT COUNT(*) AS count FROM payments WHERE tenant_id = ? AND paid_at IS NOT NULL AND paid_at >= ?",
    [principal.tenantId, since],
  );
  if ((paidRecently?.count ?? 0) >= PAID_ORDERS_PER_DAY) {
    throw new HttpError("quota_exceeded", 429, "Too many purchases in the last 24 hours.", {
      limit: "paid_orders_per_day",
    });
  }

  const brand = platformConfig().brand;
  const customerId = await getProviderCustomer(db, principal.tenantId, provider.id);
  const session = await provider.createCheckout({
    paymentId: payment.id,
    tenantId: principal.tenantId,
    email: user.email,
    pack,
    successUrl: `${env.APP_ORIGIN}${(brand.checkoutReturnPath ?? "/app/credits/return?payment={payment}").replace("{payment}", encodeURIComponent(payment.id))}`,
    cancelUrl: `${env.APP_ORIGIN}${brand.checkoutCancelPath ?? "/app/credits?checkout=cancelled"}`,
    customerId,
  });
  await attachCheckout(db, payment.id, session);
  if (session.customerId) await saveProviderCustomer(db, principal.tenantId, provider.id, session.customerId);
  await emitCommerceEvent(env, db, "checkoutStarted", payment.id);
  return { payment_id: payment.id, url: session.url };
}

export async function getCheckoutStatus(
  db: Db,
  tenantId: string,
  paymentId: string,
): Promise<{ payment_id: string; status: string; credits: number; pack_id: string; paid_at: string | null }> {
  const payment = await getPayment(db, paymentId);
  if (!payment || payment.tenant_id !== tenantId) {
    throw new HttpError("not_found", 404, "Payment not found.");
  }
  return {
    payment_id: payment.id,
    status: payment.status,
    credits: payment.credits,
    pack_id: payment.pack_id,
    paid_at: payment.paid_at,
  };
}

export interface WebhookResult {
  outcome: "granted" | "debited" | "ignored" | "duplicate" | "review";
}

async function resolvePayment(db: Db, provider: ProviderId, event: NormalizedEvent): Promise<PaymentRow | null> {
  const paymentId = "paymentId" in event ? event.paymentId : null;
  if (paymentId) {
    const byId = await getPayment(db, paymentId);
    if (byId && byId.provider === provider) return byId;
  }
  const checkoutId = "providerCheckoutId" in event ? event.providerCheckoutId : undefined;
  if (checkoutId) {
    const byCheckout = await findPaymentByCheckoutId(db, provider, checkoutId);
    if (byCheckout) return byCheckout;
  }
  const providerPaymentId = "providerPaymentId" in event ? event.providerPaymentId : undefined;
  if (providerPaymentId) {
    return findPaymentByProviderPaymentId(db, provider, providerPaymentId);
  }
  return null;
}

function carriesOwnPaymentId(event: NormalizedEvent): boolean {
  const paymentId = "paymentId" in event ? event.paymentId : null;
  return typeof paymentId === "string" && paymentId.startsWith("pay_");
}

async function creditsAlreadyDebited(db: Db, paymentId: string): Promise<number> {
  const row = await db.first<{ total: number }>(
    `SELECT COALESCE(SUM(-credits), 0) AS total FROM ledger_entries
     WHERE payment_id = ? AND kind IN ('refund', 'chargeback')`,
    [paymentId],
  );
  return Number(row?.total ?? 0);
}

async function dispatch(
  env: PlatformEnv,
  db: Db,
  provider: ProviderId,
  event: NormalizedEvent,
): Promise<{ outcome: WebhookResult["outcome"]; payment: PaymentRow | null }> {
  if (event.type === "ignored") return { outcome: "ignored", payment: null };

  const payment = await resolvePayment(db, provider, event);
  if (!payment) {
    // One Stripe account can feed several sites, so every endpoint also receives the others' events.
    // Our checkouts always tag the event with a `pay_` id; an event without one is not ours.
    if (!carriesOwnPaymentId(event)) {
      console.info(
        JSON.stringify({ evt: "payment_webhook_foreign", provider, event_id: event.eventId, type: event.type }),
      );
      return { outcome: "ignored", payment: null };
    }
    await alertOperators(env, db, {
      kind: "payment_unknown",
      summary: "A webhook referenced a payment that does not exist.",
      detail: { provider, event_id: event.eventId, type: event.type },
    });
    return { outcome: "review", payment: null };
  }

  if (event.type === "paid") {
    // Invariant 4: currency and pre-tax amount must match the pack price exactly.
    if (event.currency !== "USD" || event.subtotalCents !== payment.amount_cents) {
      await markPaymentStatus(db, payment.id, "review");
      await alertOperators(env, db, {
        kind: "payment_amount_mismatch",
        summary: "Provider amount does not match the pack price.",
        detail: {
          payment_id: payment.id,
          provider,
          expected_cents: payment.amount_cents,
          received_cents: event.subtotalCents,
          currency: event.currency,
        },
      });
      return { outcome: "review", payment };
    }
    const result = await grantPurchase(db, payment.id, {
      providerCheckoutId: event.providerCheckoutId,
      providerPaymentId: event.providerPaymentId ?? null,
      taxCents: event.taxCents ?? null,
      totalCents: event.totalCents ?? null,
      paidAt: event.paidAt,
    });
    if (result === "granted") await emitCommerceEvent(env, db, "purchaseGranted", payment.id);
    return { outcome: result, payment };
  }

  if (event.type === "failed" || event.type === "expired") {
    if (["created", "pending"].includes(payment.status)) await markPaymentStatus(db, payment.id, event.type);
    return { outcome: "ignored", payment };
  }

  // Refunds and chargebacks only make sense once the grant landed.
  if (!payment.paid_at) {
    await markPaymentStatus(db, payment.id, "review");
    await alertOperators(env, db, {
      kind: "debit_before_grant",
      summary: "Refund or chargeback arrived before the grant.",
      detail: { payment_id: payment.id, provider, event_id: event.eventId },
    });
    return { outcome: "review", payment };
  }

  if (event.type === "refund") {
    for (let attempt = 0; attempt < REFUND_ATTEMPTS; attempt += 1) {
      const fresh = await getPayment(db, payment.id);
      if (!fresh) return { outcome: "review", payment: null };
      const basis = fresh.total_cents ?? fresh.amount_cents;
      const cumulative =
        event.refundBasis === "incremental" ? fresh.refunded_cents + event.refundedCents : event.refundedCents;
      const capped = Math.min(cumulative, basis);
      if (capped <= fresh.refunded_cents) return { outcome: "duplicate", payment: fresh };

      const remaining = Math.max(0, fresh.credits - (await creditsAlreadyDebited(db, fresh.id)));
      const delta = capped - fresh.refunded_cents;
      const credits = capped >= basis ? remaining : refundCredits(fresh, delta, remaining);
      const result = await debitPayment(db, fresh.id, {
        kind: "refund",
        ref: event.ref,
        credits,
        refundedCents: capped,
      });
      if (result === "conflict") continue;
      return { outcome: result, payment: fresh };
    }
    // Contended longer than the retry budget: fail so the provider redelivers instead of losing
    // the clawback with a 200.
    await alertOperators(env, db, {
      kind: "payment_debit_contended",
      summary: "A refund could not be applied because the payment kept changing; provider will retry.",
      detail: { payment_id: payment.id, provider, event_id: event.eventId, ref: event.ref },
    });
    throw new HttpError("dependency_unavailable", 503, "Concurrent payment events; retry the delivery.");
  }

  for (let attempt = 0; attempt < REFUND_ATTEMPTS; attempt += 1) {
    const fresh = await getPayment(db, payment.id);
    if (!fresh) return { outcome: "review", payment: null };
    const remaining = Math.max(0, fresh.credits - (await creditsAlreadyDebited(db, fresh.id)));
    const result = await debitPayment(db, fresh.id, {
      kind: "chargeback",
      ref: event.ref,
      credits: remaining,
      refundedCents: fresh.refunded_cents,
    });
    if (result === "conflict") continue;
    if (result === "debited") {
      await alertOperators(env, db, {
        kind: "payment_chargeback",
        summary: "Chargeback debited credits; an admin decides the next step.",
        detail: { payment_id: fresh.id, provider, ref: event.ref, credits: remaining },
      });
    }
    return { outcome: result, payment: fresh };
  }
  await alertOperators(env, db, {
    kind: "payment_debit_contended",
    summary: "A chargeback could not be applied because the payment kept changing; provider will retry.",
    detail: { payment_id: payment.id, provider, event_id: event.eventId, ref: event.ref },
  });
  throw new HttpError("dependency_unavailable", 503, "Concurrent payment events; retry the delivery.");
}

export async function processWebhook(
  env: PlatformEnv,
  db: Db,
  providerId: ProviderId,
  rawBody: string,
  headers: Headers,
  nowMs?: number,
): Promise<WebhookResult> {
  const adapter = providerById(env, providerId);
  if (!adapter) throw new HttpError("not_found", 404, "Unknown payment provider.");

  let event: NormalizedEvent;
  try {
    event = await adapter.verifyAndParseWebhook(rawBody, headers, nowMs);
  } catch (error) {
    if (error instanceof HttpError && error.status === 400) {
      console.error(
        JSON.stringify({ evt: "payment_webhook_bad_signature", provider: providerId, reason: error.details?.reason }),
      );
    }
    throw error;
  }

  const { outcome, payment } = await dispatch(env, db, providerId, event);
  const inserted = await recordEvent(
    db,
    providerId,
    event.eventId || `${providerId}_${Date.now()}`,
    event.type === "ignored" ? event.rawType : event.type,
    payment?.id ?? null,
    outcome,
  );
  return { outcome: inserted ? outcome : "duplicate" };
}

export interface PaymentSummary {
  id: string;
  created_at: string;
  pack_id: string;
  credits: number;
  amount_cents: number;
  tax_cents: number | null;
  total_cents: number | null;
  currency: string;
  status: string;
  refunded_cents: number;
}

export async function listPaymentSummaries(db: Db, tenantId: string, limit = 50): Promise<PaymentSummary[]> {
  const rows = await db.all<PaymentRow>("SELECT * FROM payments WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?", [
    tenantId,
    limit,
  ]);
  return rows.map((row) => ({
    id: row.id,
    created_at: row.created_at,
    pack_id: row.pack_id,
    credits: row.credits,
    amount_cents: row.amount_cents,
    tax_cents: row.tax_cents,
    total_cents: row.total_cents,
    currency: row.currency,
    status: row.status,
    refunded_cents: row.refunded_cents,
  }));
}

export async function paymentReceiptUrl(
  env: PlatformEnv,
  db: Db,
  tenantId: string,
  paymentId: string,
): Promise<string> {
  const payment = await getPayment(db, paymentId);
  if (!payment || payment.tenant_id !== tenantId) throw new HttpError("not_found", 404, "Payment not found.");
  if (!["paid", "refunded", "partially_refunded", "chargeback"].includes(payment.status)) {
    throw new HttpError("not_found", 404, "No receipt for this payment.");
  }
  const provider = providerById(env, payment.provider as ProviderId);
  const url =
    provider && payment.provider_checkout_id
      ? await provider.receiptUrl(payment.provider_checkout_id, payment.provider_payment_id)
      : null;
  if (!url) {
    throw new HttpError("not_found", 404, "Receipt is unavailable.", { reason: "receipt_unavailable" });
  }
  return url;
}
