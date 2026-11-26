import { alertOperators } from "../alerts";
import type { WarriorPlusConfig } from "../config";
import type { Db } from "../db";
import { nowIso } from "../db";
import type { PlatformEnv } from "../types";
import { saleMatchesProduct, type WarriorPlusClient, type WarriorPlusSale } from "./client";
import { type PurchaseRow, toWarriorPlusPurchase } from "./types";

const VERIFY_BATCH = 50;
const UNVERIFIED_ALERT_MS = 24 * 60 * 60 * 1000;

export interface VerifySummary {
  checked: number;
  verified: number;
  needsReview: number;
  retried: number;
}

/**
 * Cross-check unverified purchases against REST. A mismatch is a review item, never an automatic
 * revocation: the id mapping between `wso_…` and `product_…` is not documented, so the owner
 * decides. Value-bearing callbacks run only after `verified_at` is written. Comps are skipped:
 * their sale id is invented locally, so REST can never confirm them.
 */
export async function verifyPendingPurchases(
  env: PlatformEnv,
  db: Db,
  config: WarriorPlusConfig,
  client: WarriorPlusClient,
): Promise<VerifySummary> {
  const rows = await db.all<PurchaseRow>(
    `SELECT * FROM wp_purchases
      WHERE app = ? AND verified_at IS NULL AND kind <> 'comp' AND status IN ('active','cancelled','suspended')
      ORDER BY granted_at LIMIT ?`,
    [config.app, VERIFY_BATCH],
  );
  const summary: VerifySummary = { checked: 0, verified: 0, needsReview: 0, retried: 0 };

  for (const purchase of rows) {
    summary.checked += 1;
    let sale: WarriorPlusSale | null;
    try {
      sale = await client.getSale(purchase.sale);
    } catch {
      summary.retried += 1;
      await alertIfOld(db, env, config, purchase);
      continue;
    }
    if (!sale) {
      summary.retried += 1;
      await alertIfOld(db, env, config, purchase);
      continue;
    }
    const refunded = sale.status === "refunded" || sale.status === "refund" || Boolean(sale.refundDate);
    if (refunded || !saleMatchesProduct(sale, purchase, config)) {
      summary.needsReview += 1;
      await db.run("UPDATE wp_purchases SET status='needs_review', review_reason=?, updated_at=? WHERE id=?", [
        refunded ? "rest_refunded" : "rest_product_mismatch",
        nowIso(),
        purchase.id,
      ]);
      await alertOperators(env, db, {
        kind: "warriorplus_rest_mismatch",
        summary: "A WarriorPlus purchase did not match the REST sale",
        detail: { purchase: purchase.id, sale: purchase.sale, reason: refunded ? "refunded" : "product_mismatch" },
      });
      continue;
    }
    summary.verified += 1;
    await verifyPurchase(db, config, purchase, sale.payments);
  }
  return summary;
}

async function verifyPurchase(
  db: Db,
  config: WarriorPlusConfig,
  purchase: PurchaseRow,
  payments: Array<{ paymentNum: number | null; status: string }>,
): Promise<void> {
  await db.run("UPDATE wp_purchases SET verified_at=?, updated_at=? WHERE id=?", [nowIso(), nowIso(), purchase.id]);
  const verified = toWarriorPlusPurchase({ ...purchase, verified_at: nowIso() });
  try {
    await config.onVerified?.(db, verified);
  } catch (error) {
    console.error(
      JSON.stringify({
        evt: "warriorplus_on_verified_failed",
        purchase: purchase.id,
        error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
      }),
    );
  }
  if (purchase.kind !== "recurring") return;
  const lastPayment = Math.max(...payments.map((payment) => payment.paymentNum ?? 0), 0);
  if (lastPayment <= 0) return;
  const next = (purchase.last_granted_payment_num ?? 0) + 1;
  if (lastPayment !== next) return;
  await db.run("UPDATE wp_purchases SET last_granted_payment_num=?, updated_at=? WHERE id=?", [
    lastPayment,
    nowIso(),
    purchase.id,
  ]);
  try {
    await config.onPaymentCompleted?.(db, verified, lastPayment);
  } catch (error) {
    console.error(
      JSON.stringify({
        evt: "warriorplus_on_payment_failed",
        purchase: purchase.id,
        error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
      }),
    );
  }
}

async function alertIfOld(db: Db, env: PlatformEnv, config: WarriorPlusConfig, purchase: PurchaseRow): Promise<void> {
  if (Date.parse(purchase.granted_at) > Date.now() - UNVERIFIED_ALERT_MS) return;
  await alertOperators(env, db, {
    kind: "warriorplus_unverified",
    summary: "A WarriorPlus purchase is still unverified after 24 hours",
    detail: { purchase: purchase.id, sale: purchase.sale, app: config.app },
    throttle: { limit: 1, windowSeconds: 12 * 60 * 60, bucket: "warriorplus_unverified" },
  });
}
