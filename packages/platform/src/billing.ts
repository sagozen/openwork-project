import { createPaddleProvider } from "./billing/paddle";
import { createStripeProvider } from "./billing/stripe";
import type { CreditPack } from "./config";
import { HttpError } from "./http";
import type { ProviderId } from "./payments";
import type { PlatformEnv } from "./types";

/**
 * Payment-provider boundary. Packs and prices come from the platform config; adapters only turn a
 * `CheckoutRequest` into a hosted checkout and a signed webhook into `NormalizedEvent`.
 * No provider SDK is linked — both adapters use `fetch` and WebCrypto so they run on Workers.
 */

export type { ProviderId };

export interface CheckoutRequest {
  paymentId: string;
  tenantId: string;
  email: string;
  pack: CreditPack;
  successUrl: string;
  cancelUrl: string;
  customerId?: string | null;
}

export interface CheckoutSession {
  providerCheckoutId: string;
  url: string;
  customerId?: string | null;
}

export type NormalizedEvent =
  | {
      type: "paid";
      eventId: string;
      paymentId: string | null;
      providerCheckoutId: string;
      providerPaymentId?: string;
      currency: string;
      subtotalCents: number;
      taxCents?: number;
      totalCents?: number;
      paidAt: string;
    }
  | { type: "failed"; eventId: string; paymentId: string | null; providerCheckoutId: string }
  | { type: "expired"; eventId: string; paymentId: string | null; providerCheckoutId: string }
  | {
      type: "refund";
      eventId: string;
      paymentId: string | null;
      providerCheckoutId?: string;
      providerPaymentId?: string;
      ref: string;
      refundedCents: number;
      /** Paddle adjustments are per-adjustment; Stripe `charge.refunded` is cumulative. */
      refundBasis: "incremental" | "cumulative";
    }
  | {
      type: "chargeback";
      eventId: string;
      paymentId: string | null;
      providerCheckoutId?: string;
      providerPaymentId?: string;
      ref: string;
    }
  | { type: "ignored"; eventId: string; rawType: string };

export interface ProviderPaymentStatus {
  status: "paid" | "pending" | "failed" | "expired" | "refunded" | "partially_refunded" | "chargeback";
  subtotalCents?: number;
  taxCents?: number;
  totalCents?: number;
  currency?: string;
  refundedCents?: number;
  providerPaymentId?: string;
}

export interface CheckoutProvider {
  id: ProviderId;
  createCheckout(request: CheckoutRequest): Promise<CheckoutSession>;
  /** Throws `HttpError` 400 when the signature is missing, stale or wrong. */
  verifyAndParseWebhook(rawBody: string, headers: Headers, nowMs?: number): Promise<NormalizedEvent>;
  fetchPaymentStatus(providerCheckoutId: string): Promise<ProviderPaymentStatus>;
  receiptUrl(providerCheckoutId: string, providerPaymentId: string | null): Promise<string | null>;
}

export interface ProviderOptions {
  /** Injected in tests; production uses the global `fetch`. */
  fetcher?: typeof fetch;
}

/**
 * The provider used to create new checkouts. Requires both the API key and the webhook secret,
 * so a half-configured deployment offers no checkout instead of a broken one.
 */
export function configuredProvider(env: PlatformEnv, options: ProviderOptions = {}): CheckoutProvider | null {
  if (env.PAYMENTS_PROVIDER === "paddle") return createPaddleProvider(env, options);
  if (env.PAYMENTS_PROVIDER === "stripe") return createStripeProvider(env, options);
  return null;
}

/**
 * Any provider whose secrets are configured, for webhook handling and reconciliation.
 * Deliberately independent of `PAYMENTS_PROVIDER` so in-flight refunds still land after a
 * provider switch.
 */
export function providerById(env: PlatformEnv, id: ProviderId, options: ProviderOptions = {}): CheckoutProvider | null {
  return id === "paddle" ? createPaddleProvider(env, options) : createStripeProvider(env, options);
}

export function checkoutUnavailable(): never {
  throw new HttpError("dependency_unavailable", 503, "Checkout is not connected on this deployment.", {
    reason: "payments_deferred",
    docs: "/docs/concepts/credits/",
  });
}

export function providerError(provider: ProviderId, status: number): HttpError {
  // Never include the provider response body: it can echo request data.
  return new HttpError("dependency_unavailable", 502, "Payment provider error.", { provider, status });
}
