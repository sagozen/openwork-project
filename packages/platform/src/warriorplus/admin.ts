import { type AdminActor, auditAdmin } from "../admin";
import type { WarriorPlusConfig } from "../config";
import { type Db, id, nowIso } from "../db";
import { HttpError } from "../http";
import type { PlatformEnv } from "../types";
import { attachPurchases } from "./attach";
import { closeTestWindow, openTestWindow, readTestWindow, sendWelcomeEmail } from "./ipn";
import type { IpnEventRow, PurchaseRow } from "./types";

export interface PurchaseLookup {
  claimed: PurchaseRow[];
  unclaimed: PurchaseRow[];
}

export async function findPurchasesByEmail(db: Db, app: string, email: string): Promise<PurchaseLookup> {
  const rows = await db.all<PurchaseRow>(
    "SELECT * FROM wp_purchases WHERE app = ? AND lower(buyer_email) = ? ORDER BY granted_at DESC",
    [app, email.trim().toLowerCase()],
  );
  return {
    claimed: rows.filter((row) => row.tenant_id !== null),
    unclaimed: rows.filter((row) => row.tenant_id === null),
  };
}

export interface IpnFilter {
  status?: IpnEventRow["status"];
  sale?: string;
  limit?: number;
}

export async function listIpnEvents(db: Db, app: string, filter: IpnFilter = {}): Promise<IpnEventRow[]> {
  const where = ["app = ?"];
  const params: unknown[] = [app];
  if (filter.status) {
    where.push("status = ?");
    params.push(filter.status);
  }
  if (filter.sale) {
    where.push("sale = ?");
    params.push(filter.sale);
  }
  params.push(Math.min(Math.max(filter.limit ?? 50, 1), 200));
  return db.all<IpnEventRow>(
    `SELECT * FROM wp_ipn_events WHERE ${where.join(" AND ")} ORDER BY received_at DESC LIMIT ?`,
    params,
  );
}

/** Support can put a failed event back in the queue; the processor is idempotent. */
export async function requeueIpnEvent(db: Db, app: string, ipnId: string): Promise<void> {
  const { changes } = await db.run(
    "UPDATE wp_ipn_events SET status='pending', error=NULL, attempts=0 WHERE app=? AND ipn_id=? AND status IN ('failed','needs_review')",
    [app, ipnId],
  );
  if (changes === 0) throw new HttpError("not_found", 404, "That event is not in the review queue.");
}

export async function resendWelcome(
  env: PlatformEnv,
  db: Db,
  config: WarriorPlusConfig,
  email: string,
): Promise<{ sent: number }> {
  const normalized = email.trim().toLowerCase();
  const recent = await db.first<{ count: number }>(
    `SELECT COUNT(*) AS count FROM email_outbox
      WHERE to_email = ? AND template = 'product_notice' AND created_at > ?`,
    [normalized, new Date(Date.now() - 86_400_000).toISOString()],
  );
  const sent = recent?.count ?? 0;
  if (sent >= 3) throw new HttpError("rate_limited", 429, "This address already received three sign-in emails today.");
  await sendWelcomeEmail(env, db, config, normalized, true);
  return { sent: sent + 1 };
}

export interface GrantCompInput {
  email: string;
  productCode: string;
  reason: string;
  /** Required. A comp without an expiry is a permanent free tier by accident. */
  expiresAt: string;
}

/** Admin-only. A comp never triggers credit grants: it is a feature grant with an end date. */
export async function grantComp(
  db: Db,
  config: WarriorPlusConfig,
  actor: AdminActor,
  input: GrantCompInput,
): Promise<PurchaseRow> {
  if (actor.role !== "admin") throw new HttpError("forbidden", 403, "The admin role is required.");
  const product = Object.entries(config.products).find(([, value]) => value.code === input.productCode);
  if (!product) throw new HttpError("invalid_input", 400, "Unknown product code.");
  const email = input.email.trim().toLowerCase();
  if (!email.includes("@")) throw new HttpError("invalid_input", 400, "A buyer email is required.");
  if (!input.expiresAt || Number.isNaN(Date.parse(input.expiresAt))) {
    throw new HttpError("invalid_input", 400, "An expiry date is required for a comp.");
  }
  const timestamp = nowIso();
  const purchaseId = id("wpu");
  await db.run(
    `INSERT INTO wp_purchases
      (id, app, sale, item_number, product_code, kind, buyer_email, status, expires_at, source,
       granted_by, comp_reason, granted_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'comp', ?, 'active', ?, 'comp', ?, ?, ?, ?)`,
    [
      purchaseId,
      config.app,
      `comp_${purchaseId}`,
      product[0],
      product[1].code,
      email,
      new Date(input.expiresAt).toISOString(),
      actor.userId,
      input.reason.slice(0, 500),
      timestamp,
      timestamp,
    ],
  );
  await attachPurchases(db, config, email);
  await auditAdmin(db, actor, "warriorplus.comp_grant", "wp_purchase", purchaseId, input.reason, {
    email,
    productCode: input.productCode,
    expiresAt: input.expiresAt,
  });
  const row = await db.first<PurchaseRow>("SELECT * FROM wp_purchases WHERE id = ?", [purchaseId]);
  if (!row) throw new HttpError("dependency_unavailable", 503, "The comp was not saved.");
  return row;
}

export async function revokePurchase(
  db: Db,
  config: WarriorPlusConfig,
  actor: AdminActor,
  purchaseId: string,
  reason: string,
): Promise<void> {
  if (actor.role !== "admin") throw new HttpError("forbidden", 403, "The admin role is required.");
  const purchase = await db.first<PurchaseRow>("SELECT * FROM wp_purchases WHERE id = ? AND app = ?", [
    purchaseId,
    config.app,
  ]);
  if (!purchase) throw new HttpError("not_found", 404, "Purchase not found.");
  await db.run("UPDATE wp_purchases SET status='revoked', revoked_at=?, updated_at=? WHERE id=?", [
    nowIso(),
    nowIso(),
    purchaseId,
  ]);
  await attachPurchases(db, config, purchase.buyer_email);
  await auditAdmin(db, actor, "warriorplus.purchase_revoke", "wp_purchase", purchaseId, reason, {
    email: purchase.buyer_email,
    productCode: purchase.product_code,
  });
}

/** Admin-only, audit-logged Send Test window. At most 15 minutes; it can never grant anything. */
export async function openAdminTestWindow(
  db: Db,
  config: WarriorPlusConfig,
  actor: AdminActor,
  minutes: number,
): Promise<{ until: string }> {
  if (actor.role !== "admin") throw new HttpError("forbidden", 403, "The admin role is required.");
  const result = await openTestWindow(db, config.app, actor.userId, minutes);
  await auditAdmin(db, actor, "warriorplus.test_window_open", "wp_test_window", config.app, null, {
    until: result.until,
  });
  return result;
}

export async function closeAdminTestWindow(db: Db, config: WarriorPlusConfig, actor: AdminActor): Promise<void> {
  if (actor.role !== "admin") throw new HttpError("forbidden", 403, "The admin role is required.");
  await closeTestWindow(db, config.app);
  await auditAdmin(db, actor, "warriorplus.test_window_close", "wp_test_window", config.app, null, {});
}

export function testWindowState(db: Db, app: string): Promise<{ until: string; openedBy: string } | null> {
  return readTestWindow(db, app);
}

/** A support-visible roster of buyers whose add-ons still need a refund after an FE refund. */
export async function listFeRefundQueue(db: Db, app: string): Promise<PurchaseRow[]> {
  return db.all<PurchaseRow>(
    `SELECT * FROM wp_purchases
      WHERE app = ? AND status = 'needs_review' AND review_reason = 'fe_refunded_refund_addon'
      ORDER BY updated_at`,
    [app],
  );
}
