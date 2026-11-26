import assert from "node:assert/strict";
import test from "node:test";
import type { AdminActor } from "../src/admin";
import { ensureTenant } from "../src/tenancy";
import {
  closeAdminTestWindow,
  findPurchasesByEmail,
  grantComp,
  listFeRefundQueue,
  openAdminTestWindow,
  requeueIpnEvent,
  resendWelcome,
  revokePurchase,
  testWindowState,
} from "../src/warriorplus/admin";
import {
  entitlements,
  insertUser,
  platformConfigForWarriorPlus,
  runIpn,
  salePayload,
  testDb,
  testEnv,
  WARRIORPLUS,
} from "./warriorplus-support";

const ADMIN: AdminActor = { userId: "adm_1", email: "admin@example.com", role: "admin" };
const SUPPORT: AdminActor = { userId: "sup_1", email: "support@example.com", role: "support" };

async function buyer(shim: ReturnType<typeof testDb>) {
  const email = "buyer@example.com";
  const userId = await insertUser(shim.db, { email });
  await ensureTenant(shim.db, { id: userId, email, name: "Buyer" });
}

test("comps need the admin role and an expiry, and never grant credits", async () => {
  const shim = testDb();
  await buyer(shim);
  let verified = 0;
  const config = platformConfigForWarriorPlus({
    ...WARRIORPLUS,
    onVerified: async () => {
      verified += 1;
    },
  });
  await assert.rejects(
    grantComp(shim.db, config, SUPPORT, {
      email: "buyer@example.com",
      productCode: "fe",
      reason: "reviewer",
      expiresAt: "2026-12-01T00:00:00.000Z",
    }),
    /admin role/,
  );
  await assert.rejects(
    grantComp(shim.db, config, ADMIN, {
      email: "buyer@example.com",
      productCode: "fe",
      reason: "reviewer",
      expiresAt: "",
    }),
    /expiry/,
  );
  const purchase = await grantComp(shim.db, config, ADMIN, {
    email: "buyer@example.com",
    productCode: "fe",
    reason: "reviewer account",
    expiresAt: "2026-12-01T00:00:00.000Z",
  });
  assert.equal(purchase.kind, "comp");
  assert.equal(purchase.source, "comp");
  assert.equal(verified, 0);
  assert.equal((await entitlements(shim.db))["books.perMonth"], 10);
  const audit = await shim.db.first<{ action: string }>("SELECT action FROM admin_audit WHERE resource_id = ?", [
    purchase.id,
  ]);
  assert.equal(audit?.action, "warriorplus.comp_grant");
});

test("revoking a purchase recomputes entitlements", async () => {
  const shim = testDb();
  await buyer(shim);
  const config = platformConfigForWarriorPlus(WARRIORPLUS);
  await runIpn(shim.db, salePayload());
  const purchase = await shim.db.first<{ id: string }>("SELECT id FROM wp_purchases LIMIT 1");
  assert.ok(purchase);
  assert.equal((await entitlements(shim.db))["books.perMonth"], 10);
  await revokePurchase(shim.db, config, ADMIN, purchase.id, "support refund");
  const row = await shim.db.first<{ status: string; revoked_at: string | null }>(
    "SELECT status, revoked_at FROM wp_purchases WHERE id = ?",
    [purchase.id],
  );
  assert.equal(row?.status, "revoked");
  assert.ok(row?.revoked_at);
  assert.equal((await entitlements(shim.db))["books.perMonth"], 0);
});

test("welcome resends stop at three per day", async () => {
  const shim = testDb();
  await runIpn(shim.db, salePayload());
  const config = platformConfigForWarriorPlus(WARRIORPLUS);
  const env = testEnv();
  // The ingest email already counts as one.
  await resendWelcome(env, shim.db, config, "buyer@example.com");
  await resendWelcome(env, shim.db, config, "buyer@example.com");
  await assert.rejects(resendWelcome(env, shim.db, config, "buyer@example.com"), /three sign-in emails/);
  const count = await shim.db.first<{ count: number }>(
    "SELECT COUNT(*) AS count FROM email_outbox WHERE to_email = 'buyer@example.com'",
  );
  assert.equal(count?.count, 3);
});

test("the admin test window is bounded, audited and admin-only", async () => {
  const shim = testDb();
  const config = platformConfigForWarriorPlus(WARRIORPLUS);
  await assert.rejects(openAdminTestWindow(shim.db, config, SUPPORT, 5), /admin role/);
  const { until } = await openAdminTestWindow(shim.db, config, ADMIN, 60);
  const minutes = (Date.parse(until) - Date.now()) / 60_000;
  assert.ok(minutes <= 15 && minutes > 14);
  assert.ok(await testWindowState(shim.db, "puzzle"));
  const audit = await shim.db.first<{ action: string }>(
    "SELECT action FROM admin_audit WHERE action = 'warriorplus.test_window_open'",
  );
  assert.ok(audit);
  await closeAdminTestWindow(shim.db, config, ADMIN);
  assert.equal(await testWindowState(shim.db, "puzzle"), null);
});

test("support can look up purchases and requeue a failed event", async () => {
  const shim = testDb();
  await buyer(shim);
  await runIpn(shim.db, salePayload());
  const lookup = await findPurchasesByEmail(shim.db, "puzzle", "BUYER@example.com");
  assert.equal(lookup.claimed.length, 1);
  assert.equal(lookup.unclaimed.length, 0);
  await shim.db.run("UPDATE wp_ipn_events SET status='failed'");
  const event = await shim.db.first<{ ipn_id: string }>("SELECT ipn_id FROM wp_ipn_events LIMIT 1");
  assert.ok(event);
  await requeueIpnEvent(shim.db, "puzzle", event.ipn_id);
  const row = await shim.db.first<{ status: string; attempts: number }>(
    "SELECT status, attempts FROM wp_ipn_events WHERE ipn_id = ?",
    [event.ipn_id],
  );
  assert.equal(row?.status, "pending");
  assert.equal(row?.attempts, 0);
});

test("the FE refund queue lists add-ons waiting for a support refund", async () => {
  const shim = testDb();
  await buyer(shim);
  const sale = "sale_queue";
  await runIpn(shim.db, salePayload({ WP_SALE: sale }));
  await runIpn(shim.db, salePayload({ WP_ITEM_NUMBER: "wso_oto1", WP_SALE: "sale_queue_addon" }));
  await runIpn(shim.db, salePayload({ WP_ACTION: "refund", WP_SALE: sale, WP_SALE_AMOUNT: "-17.00" }));
  const queue = await listFeRefundQueue(shim.db, "puzzle");
  assert.equal(queue.length, 1);
  assert.equal(queue[0]?.product_code, "oto1");
  assert.equal(queue[0]?.review_reason, "fe_refunded_refund_addon");
});

test("the cron sweeps stale events and drops buyer PII after 400 days", async () => {
  const shim = testDb();
  await runIpn(shim.db, salePayload());
  const event = await shim.db.first<{ ipn_id: string }>("SELECT ipn_id FROM wp_ipn_events LIMIT 1");
  assert.ok(event);
  await shim.db.run("UPDATE wp_ipn_events SET status='pending', received_at=? WHERE ipn_id=?", [
    new Date(Date.now() - 10 * 60_000).toISOString(),
    event.ipn_id,
  ]);
  const { staleEventIds, purgeIpnPayloads, expireCancelledSubscriptions } = await import(
    "../src/warriorplus/retention"
  );
  assert.deepEqual(await staleEventIds(shim.db, "puzzle"), [event.ipn_id]);

  await shim.db.run("UPDATE wp_ipn_events SET received_at='2024-01-01T00:00:00.000Z'");
  await purgeIpnPayloads(shim.db, "puzzle");
  const payload = await shim.db.first<{ payload: string }>("SELECT payload FROM wp_ipn_events LIMIT 1");
  assert.equal(payload?.payload, "{}");

  await shim.db.run(
    `UPDATE wp_purchases SET kind='recurring', status='cancelled', current_period_end='2024-01-01T00:00:00.000Z'`,
  );
  const tenants = await expireCancelledSubscriptions(shim.db, "puzzle");
  assert.equal(tenants.length, 0);
  const ended = await shim.db.first<{ status: string }>("SELECT status FROM wp_purchases LIMIT 1");
  assert.equal(ended?.status, "ended");
});
