import { platformConfig } from "./config";
import { notifyCheckoutStarted, notifyPurchase } from "./crm";
import type { Db } from "./db";
import { getPayment } from "./payments";
import type { PlatformEnv } from "./types";

/**
 * Tells the product's CRM about a payment moment (a no-op for apps without `crm` config). It is
 * best-effort: a notification failure is logged and never reaches the caller, so it can neither
 * fail a checkout nor make a provider redeliver a webhook that already granted the credits.
 */
export async function emitCommerceEvent(
  env: PlatformEnv,
  db: Db,
  event: "checkoutStarted" | "purchaseGranted",
  paymentId: string,
): Promise<void> {
  if (!platformConfig().crm) return;
  try {
    const payment = await getPayment(db, paymentId);
    if (!payment) return;
    if (event === "checkoutStarted") await notifyCheckoutStarted(env, db, payment);
    else await notifyPurchase(env, db, payment);
  } catch (error) {
    console.error(
      JSON.stringify({
        evt: "commerce_hook_failed",
        hook: event,
        payment_id: paymentId,
        error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
      }),
    );
  }
}
