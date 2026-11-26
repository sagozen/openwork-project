import { alertOperators } from "../alerts";
import type { WarriorPlusConfig } from "../config";
import type { Db } from "../db";
import { id, nowIso } from "../db";
import type { PlatformEnv } from "../types";
import { attachPurchases } from "./attach";
import type { WarriorPlusClient, WarriorPlusSale } from "./client";
import { materializeEntitlements, resolveProduct } from "./entitlements";
import { type PurchaseRow, toWarriorPlusPurchase } from "./types";

function isoDaysAgo(days: number): string {
  const date = new Date(Date.now() - days * 86_400_000);
  return date.toISOString().slice(0, 10);
}

/**
 * Daily reconciliation over the last three days: REST is the source of truth for a missing sale
 * or refund. A difference the module cannot resolve is alerted, never guessed at.
 */
export async function reconcileSales(
  env: PlatformEnv,
  db: Db,
  config: WarriorPlusConfig,
  client: WarriorPlusClient,
): Promise<{ inserted: number; refunded: number; unresolved: number }> {
  const sales = await client.listSales({ from: isoDaysAgo(3), to: isoDaysAgo(0) });
  const summary = { inserted: 0, refunded: 0, unresolved: 0 };
  for (const sale of sales) {
    const existing = await db.all<{ id: string; status: string }>(
      "SELECT id, status FROM wp_purchases WHERE app = ? AND sale = ?",
      [config.app, sale.id],
    );
    const refunded = sale.status === "refunded" || sale.status === "refund" || Boolean(sale.refundDate);
    if (existing.length > 0) {
      if (refunded) {
        const { changes } = await db.run(
          "UPDATE wp_purchases SET status='refunded', revoked_at=?, updated_at=? WHERE app=? AND sale=? AND status NOT IN ('refunded','revoked')",
          [nowIso(), nowIso(), config.app, sale.id],
        );
        summary.refunded += changes;
      }
      continue;
    }
    if (refunded) continue; // A refund for a sale we never saw has no row to close.
    const productId = sale.productIds[0] ?? "";
    const resolved = productId ? resolveProduct(config, productId) : null;
    if (!resolved) {
      summary.unresolved += 1;
      await alertOperators(env, db, {
        kind: "warriorplus_reconcile_unknown_product",
        summary: "A REST sale uses a product id the app does not map",
        detail: { sale: sale.id, products: sale.productIds.join(",") },
      });
      continue;
    }
    const buyerEmail = buyerEmailFrom(sale);
    if (!buyerEmail) {
      summary.unresolved += 1;
      await alertOperators(env, db, {
        kind: "warriorplus_reconcile_missing_email",
        summary: "A REST sale has no buyer email",
        detail: { sale: sale.id },
      });
      continue;
    }
    const timestamp = nowIso();
    await db.run(
      `INSERT INTO wp_purchases
        (id, app, sale, item_number, product_code, kind, buyer_email, status, amount_cents, source,
         verified_at, granted_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NULL, 'reconcile', ?, ?, ?)`,
      [
        id("wpu"),
        config.app,
        sale.id,
        resolved.itemNumber,
        resolved.product.code,
        resolved.product.kind,
        buyerEmail,
        timestamp,
        timestamp,
        timestamp,
      ],
    );
    summary.inserted += 1;
    await attachPurchases(db, config, buyerEmail);
    const purchase = await db.first<{ tenant_id: string | null }>(
      "SELECT tenant_id FROM wp_purchases WHERE app=? AND sale=? LIMIT 1",
      [config.app, sale.id],
    );
    if (purchase?.tenant_id) await materializeEntitlements(db, config, purchase.tenant_id);
    try {
      const row = await db.first<PurchaseRow>("SELECT * FROM wp_purchases WHERE app=? AND sale=? LIMIT 1", [
        config.app,
        sale.id,
      ]);
      if (row) await config.onVerified?.(db, toWarriorPlusPurchase(row));
    } catch (error) {
      console.error(
        JSON.stringify({
          evt: "warriorplus_reconcile_verified_failed",
          sale: sale.id,
          error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
        }),
      );
    }
  }
  return summary;
}

function buyerEmailFrom(sale: WarriorPlusSale): string {
  const value = sale.raw.buyer_email ?? sale.raw.buyerEmail ?? sale.raw.email;
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}
