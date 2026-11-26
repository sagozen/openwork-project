import {
  type CheckoutProvider,
  type NormalizedEvent,
  type ProviderOptions,
  type ProviderPaymentStatus,
  providerError,
} from "../billing";
import type { PlatformEnv } from "../types";
import { verifyStripeSignature } from "./signature";

/**
 * Stripe adapter (no SDK, form-encoded `fetch`). Facts and payload shapes are recorded in
 * `plans/261025-1601-checkout-billing-production/reports/provider-facts.md`.
 */

interface StripeCharge {
  id?: string;
  amount?: number;
  amount_refunded?: number;
  currency?: string;
  payment_intent?: string | null;
  metadata?: Record<string, string> | null;
  refunds?: { data?: Array<{ id?: string; amount?: number; status?: string }> };
}

interface StripeDispute {
  id?: string;
  amount?: number;
  currency?: string;
  charge?: string;
  payment_intent?: string | null;
  metadata?: Record<string, string> | null;
}

interface StripeSession {
  id?: string;
  status?: string;
  payment_status?: string;
  amount_subtotal?: number | null;
  amount_total?: number | null;
  total_details?: { amount_tax?: number | null } | null;
  currency?: string | null;
  customer?: string | null;
  client_reference_id?: string | null;
  payment_intent?:
    | string
    | { id?: string; latest_charge?: { receipt_url?: string | null; amount_refunded?: number } | string }
    | null;
  metadata?: Record<string, string> | null;
}

interface StripeEvent {
  id?: string;
  type?: string;
  created?: number;
  data?: { object?: unknown };
}

const API_BASE = "https://api.stripe.com";

function objectOf(event: StripeEvent): Record<string, unknown> {
  return (event.data?.object ?? {}) as Record<string, unknown>;
}

function paymentIntentId(value: StripeSession["payment_intent"]): string | undefined {
  if (!value) return undefined;
  return typeof value === "string" ? value : value.id;
}

function latestCharge(value: StripeSession["payment_intent"]): {
  receipt_url?: string | null;
  amount_refunded?: number;
} {
  if (!value || typeof value === "string") return {};
  const charge = value.latest_charge;
  return charge && typeof charge === "object" ? charge : {};
}

function normalize(event: StripeEvent): NormalizedEvent {
  const eventId = event.id ?? "";
  const rawType = event.type ?? "";
  const object = objectOf(event);
  const occurredAt = new Date((event.created ?? Math.floor(Date.now() / 1000)) * 1000).toISOString();

  if (rawType === "checkout.session.completed" || rawType === "checkout.session.async_payment_succeeded") {
    const session = object as StripeSession;
    if (rawType === "checkout.session.completed" && session.payment_status !== "paid") {
      // Async payment methods complete unpaid first; `async_payment_succeeded` follows.
      return { type: "ignored", eventId, rawType };
    }
    return {
      type: "paid",
      eventId,
      paymentId: session.metadata?.payment_id ?? session.client_reference_id ?? null,
      providerCheckoutId: session.id ?? "",
      providerPaymentId: paymentIntentId(session.payment_intent),
      currency: (session.currency ?? "").toUpperCase(),
      subtotalCents: session.amount_subtotal ?? 0,
      taxCents: session.total_details?.amount_tax ?? undefined,
      totalCents: session.amount_total ?? undefined,
      paidAt: occurredAt,
    };
  }

  if (rawType === "checkout.session.expired" || rawType === "checkout.session.async_payment_failed") {
    const session = object as StripeSession;
    return {
      type: rawType === "checkout.session.expired" ? "expired" : "failed",
      eventId,
      paymentId: session.metadata?.payment_id ?? session.client_reference_id ?? null,
      providerCheckoutId: session.id ?? "",
    };
  }

  if (rawType === "charge.refunded") {
    const charge = object as StripeCharge;
    return {
      type: "refund",
      eventId,
      paymentId: charge.metadata?.payment_id ?? null,
      providerPaymentId: paymentIntentId(charge.payment_intent ?? undefined),
      // `amount_refunded` is cumulative and gross of tax; phase 3 subtracts the amount already
      // debited on the payment row before computing the credit delta.
      // `charge.refunded` lists every refund on the charge, so the newest entry is not reliably
      // this event's refund. A cumulative-based reference is unique per step and stable on replay.
      ref: `${charge.id ?? eventId}:${charge.amount_refunded ?? 0}`,
      refundedCents: charge.amount_refunded ?? 0,
      refundBasis: "cumulative",
    };
  }

  if (rawType === "charge.dispute.created") {
    const dispute = object as StripeDispute;
    return {
      type: "chargeback",
      eventId,
      paymentId: dispute.metadata?.payment_id ?? null,
      providerPaymentId: paymentIntentId(dispute.payment_intent ?? undefined),
      ref: dispute.id ?? eventId,
    };
  }

  return { type: "ignored", eventId, rawType };
}

function mapStatus(session: StripeSession): ProviderPaymentStatus {
  const charge = latestCharge(session.payment_intent);
  const refunded = charge.amount_refunded ?? 0;
  const total = session.amount_total ?? 0;
  let status: ProviderPaymentStatus["status"] = "pending";
  if (session.status === "expired") status = "expired";
  else if (session.payment_status === "paid" && session.status === "complete") status = "paid";
  if (refunded > 0 && total > 0) status = refunded >= total ? "refunded" : "partially_refunded";
  return {
    status,
    subtotalCents: session.amount_subtotal ?? undefined,
    taxCents: session.total_details?.amount_tax ?? undefined,
    totalCents: session.amount_total ?? undefined,
    currency: (session.currency ?? "").toUpperCase() || undefined,
    refundedCents: refunded,
    providerPaymentId: paymentIntentId(session.payment_intent),
  };
}

export function createStripeProvider(env: PlatformEnv, options: ProviderOptions = {}): CheckoutProvider | null {
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) return null;
  const fetcher = options.fetcher ?? fetch;
  const auth = { authorization: `Bearer ${env.STRIPE_SECRET_KEY}` };

  async function call(path: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; data: unknown }> {
    const response = await fetcher(`${API_BASE}${path}`, { ...init, headers: { ...auth, ...(init.headers ?? {}) } });
    const body = response.ok ? await response.json().catch(() => ({})) : null;
    return { ok: response.ok, status: response.status, data: body };
  }

  return {
    id: "stripe",

    async createCheckout(request) {
      const body = new URLSearchParams();
      body.set("mode", "payment");
      body.set("success_url", request.successUrl);
      body.set("cancel_url", request.cancelUrl);
      body.set("client_reference_id", request.paymentId);
      body.set("metadata[payment_id]", request.paymentId);
      body.set("metadata[tenant_id]", request.tenantId);
      body.set("metadata[pack_id]", request.pack.id);
      // Refund and dispute events arrive on the charge, so the payment id must live on the intent.
      body.set("payment_intent_data[metadata][payment_id]", request.paymentId);
      body.set("payment_intent_data[metadata][tenant_id]", request.tenantId);
      body.set("line_items[0][quantity]", "1");
      body.set("line_items[0][price_data][currency]", "usd");
      body.set("line_items[0][price_data][unit_amount]", String(request.pack.priceCents));
      body.set(
        "line_items[0][price_data][product_data][name]",
        `${request.pack.name.en} — ${request.pack.credits} credits`,
      );
      if (request.customerId) body.set("customer", request.customerId);
      else body.set("customer_email", request.email);

      const result = await call("/v1/checkout/sessions", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "idempotency-key": request.paymentId },
        body: body.toString(),
      });
      if (!result.ok) throw providerError("stripe", result.status);
      const data = result.data as { id?: string; url?: string; customer?: string | null };
      if (!data?.id || !data.url) throw providerError("stripe", result.status);
      return { providerCheckoutId: data.id, url: data.url, customerId: data.customer ?? null };
    },

    async verifyAndParseWebhook(rawBody, requestHeaders, nowMs) {
      await verifyStripeSignature(
        rawBody,
        requestHeaders.get("stripe-signature"),
        env.STRIPE_WEBHOOK_SECRET ?? "",
        nowMs,
      );
      return normalize(JSON.parse(rawBody) as StripeEvent);
    },

    async fetchPaymentStatus(providerCheckoutId) {
      const result = await call(
        `/v1/checkout/sessions/${encodeURIComponent(providerCheckoutId)}?expand[]=payment_intent.latest_charge`,
      );
      if (!result.ok) throw providerError("stripe", result.status);
      return mapStatus(result.data as StripeSession);
    },

    async receiptUrl(providerCheckoutId) {
      const result = await call(
        `/v1/checkout/sessions/${encodeURIComponent(providerCheckoutId)}?expand[]=payment_intent.latest_charge`,
      );
      if (!result.ok) return null;
      const url = latestCharge((result.data as StripeSession).payment_intent).receipt_url;
      return url && /^https:\/\//.test(url) ? url : null;
    },
  };
}
