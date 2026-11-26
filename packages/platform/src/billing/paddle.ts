import {
  type CheckoutProvider,
  type NormalizedEvent,
  type ProviderOptions,
  type ProviderPaymentStatus,
  providerError,
} from "../billing";
import { HttpError } from "../http";
import type { PlatformEnv } from "../types";
import { verifyPaddleSignature } from "./signature";

/**
 * Paddle Billing adapter (no SDK). Facts and payload shapes are recorded in
 * `plans/261025-1601-checkout-billing-production/reports/provider-facts.md`.
 */

interface PaddleTotals {
  subtotal?: string;
  tax?: string;
  total?: string;
  currency_code?: string;
}

interface PaddleTransaction {
  id?: string;
  status?: string;
  currency_code?: string;
  customer_id?: string | null;
  custom_data?: Record<string, unknown> | null;
  billed_at?: string | null;
  created_at?: string;
  details?: { totals?: PaddleTotals };
}

interface PaddleAdjustment {
  id?: string;
  action?: string;
  status?: string;
  transaction_id?: string;
  totals?: PaddleTotals;
}

interface PaddleEvent {
  event_id?: string;
  event_type?: string;
  occurred_at?: string;
  data?: unknown;
}

const PAID_EVENTS = new Set(["transaction.completed", "transaction.paid"]);

function baseUrl(env: PlatformEnv): string {
  return env.PADDLE_ENVIRONMENT === "sandbox" ? "https://sandbox-api.paddle.com" : "https://api.paddle.com";
}

function paymentIdOf(data: { custom_data?: Record<string, unknown> | null }): string | null {
  const value = data.custom_data?.payment_id;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function cents(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalize(event: PaddleEvent): NormalizedEvent {
  const eventId = event.event_id ?? "";
  const rawType = event.event_type ?? "";
  const data = (event.data ?? {}) as PaddleTransaction & PaddleAdjustment;

  if (PAID_EVENTS.has(rawType)) {
    const transaction = data as PaddleTransaction;
    if (transaction.status && !["paid", "completed"].includes(transaction.status)) {
      return { type: "ignored", eventId, rawType };
    }
    const totals = transaction.details?.totals;
    return {
      type: "paid",
      eventId,
      paymentId: paymentIdOf(transaction),
      providerCheckoutId: transaction.id ?? "",
      currency: (totals?.currency_code ?? transaction.currency_code ?? "").toUpperCase(),
      subtotalCents: cents(totals?.subtotal) ?? 0,
      taxCents: cents(totals?.tax),
      totalCents: cents(totals?.total),
      paidAt: transaction.billed_at ?? event.occurred_at ?? new Date().toISOString(),
    };
  }

  if (rawType === "transaction.payment_failed" || rawType === "transaction.canceled") {
    const transaction = data as PaddleTransaction;
    return {
      type: rawType === "transaction.canceled" ? "expired" : "failed",
      eventId,
      paymentId: paymentIdOf(transaction),
      providerCheckoutId: transaction.id ?? "",
    };
  }

  if (rawType === "adjustment.created" || rawType === "adjustment.updated") {
    const adjustment = data as PaddleAdjustment;
    const action = adjustment.action ?? "";
    const approved = adjustment.status === "approved";
    if (action === "refund" && approved) {
      return {
        type: "refund",
        eventId,
        paymentId: null,
        providerCheckoutId: adjustment.transaction_id,
        ref: adjustment.id ?? eventId,
        refundedCents: cents(adjustment.totals?.total) ?? 0,
        refundBasis: "incremental",
      };
    }
    if (action === "chargeback") {
      return {
        type: "chargeback",
        eventId,
        paymentId: null,
        providerCheckoutId: adjustment.transaction_id,
        ref: adjustment.id ?? eventId,
      };
    }
    // `credit`, pending/rejected refunds, chargeback warnings and reversals are out of scope for
    // V1: they are recorded by the caller as `ignored` and surfaced through reconciliation.
    return { type: "ignored", eventId, rawType };
  }

  return { type: "ignored", eventId, rawType };
}

function mapStatus(transaction: PaddleTransaction): ProviderPaymentStatus {
  const totals = transaction.details?.totals;
  const status: ProviderPaymentStatus["status"] = (() => {
    switch (transaction.status) {
      case "paid":
      case "completed":
        return "paid";
      case "canceled":
        return "expired";
      case "past_due":
        return "failed";
      default:
        return "pending";
    }
  })();
  return {
    status,
    subtotalCents: cents(totals?.subtotal),
    taxCents: cents(totals?.tax),
    totalCents: cents(totals?.total),
    currency: (totals?.currency_code ?? transaction.currency_code ?? "").toUpperCase() || undefined,
    refundedCents: 0,
  };
}

export function createPaddleProvider(env: PlatformEnv, options: ProviderOptions = {}): CheckoutProvider | null {
  if (!env.PADDLE_API_KEY || !env.PADDLE_WEBHOOK_SECRET) return null;
  const fetcher = options.fetcher ?? fetch;
  const base = baseUrl(env);
  const headers = { authorization: `Bearer ${env.PADDLE_API_KEY}`, "content-type": "application/json" };

  async function call(path: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; data: unknown }> {
    const response = await fetcher(`${base}${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
    const body = response.ok ? await response.json().catch(() => ({})) : null;
    return { ok: response.ok, status: response.status, data: body };
  }

  return {
    id: "paddle",

    async createCheckout(request) {
      if (!env.PADDLE_PRODUCT_ID) {
        throw new HttpError("dependency_unavailable", 503, "Paddle product is not configured.", {
          reason: "paddle_product_missing",
        });
      }
      const body = {
        items: [
          {
            quantity: 1,
            price: {
              description: `${request.pack.name.en} — ${request.pack.credits} credits`,
              name: `${request.pack.name.en} — ${request.pack.credits} credits`,
              product_id: env.PADDLE_PRODUCT_ID,
              tax_mode: "account_setting",
              unit_price: { amount: String(request.pack.priceCents), currency_code: "USD" },
            },
          },
        ],
        custom_data: { payment_id: request.paymentId, tenant_id: request.tenantId, pack_id: request.pack.id },
        checkout: { url: request.successUrl },
        ...(request.customerId ? { customer_id: request.customerId } : {}),
      };
      const result = await call("/transactions", {
        method: "POST",
        // Paddle honours Idempotency-Key on POST, so a retried create cannot open a second transaction.
        headers: { "idempotency-key": request.paymentId },
        body: JSON.stringify(body),
      });
      if (!result.ok) throw providerError("paddle", result.status);
      const data = (result.data as { data?: { id?: string; checkout?: { url?: string }; customer_id?: string | null } })
        .data;
      if (!data?.id || !data.checkout?.url) throw providerError("paddle", result.status);
      return { providerCheckoutId: data.id, url: data.checkout.url, customerId: data.customer_id ?? null };
    },

    async verifyAndParseWebhook(rawBody, requestHeaders, nowMs) {
      const secret = env.PADDLE_WEBHOOK_SECRET ?? "";
      await verifyPaddleSignature(rawBody, requestHeaders.get("paddle-signature"), secret, nowMs);
      return normalize(JSON.parse(rawBody) as PaddleEvent);
    },

    async fetchPaymentStatus(providerCheckoutId) {
      const result = await call(`/transactions/${encodeURIComponent(providerCheckoutId)}`);
      if (!result.ok) throw providerError("paddle", result.status);
      return mapStatus((result.data as { data?: PaddleTransaction }).data ?? {});
    },

    async receiptUrl(providerCheckoutId) {
      const result = await call(`/transactions/${encodeURIComponent(providerCheckoutId)}/invoice`);
      if (!result.ok) return null;
      const url = (result.data as { data?: { url?: string } }).data?.url;
      return url && /^https:\/\//.test(url) ? url : null;
    },
  };
}
