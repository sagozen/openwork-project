import assert from "node:assert/strict";
import test from "node:test";
import { ensureTenant } from "../src/tenancy";
import { attachPurchases } from "../src/warriorplus/attach";
import { entitlementValue } from "../src/warriorplus/entitlements";
import {
  entitlements,
  insertUser,
  licensedWorkspaces,
  platformConfigForWarriorPlus,
  purchase,
  runIpn,
  salePayload,
  testDb,
  WARRIORPLUS,
} from "./warriorplus-support";

test.beforeEach(() => {
  platformConfigForWarriorPlus();
});

async function buyer(shim: ReturnType<typeof testDb>, email = "buyer@example.com") {
  const userId = await insertUser(shim.db, { email });
  await ensureTenant(shim.db, { id: userId, email, name: "Buyer" });
  return userId;
}

test("FE grants the Front End keys and writes an explicit zero for everything else", async () => {
  const shim = testDb();
  await buyer(shim);
  const { response } = await runIpn(shim.db, salePayload());
  assert.equal(response.status, 200);
  const values = await entitlements(shim.db);
  assert.equal(values["books.perMonth"], 10);
  assert.equal(values["packs.decades.core"], 1);
  assert.equal(values["wordlists.custom"], 1);
  assert.equal(values.seats, 1);
  assert.equal(values["packs.holiday"], 0);
  assert.equal(values["ai.themes.perDay"], 0);
  assert.equal(values["cover.builder"], 0);
  assert.equal(values["etsy.export"], 0);
});

test("Pro overrides the quota to unlimited and adds its own keys", async () => {
  const shim = testDb();
  await buyer(shim);
  await runIpn(shim.db, salePayload());
  await runIpn(shim.db, salePayload({ WP_ITEM_NUMBER: "wso_oto1", WP_SALE: "sale_pro", WP_SALE_AMOUNT: "37.00" }));
  const values = await entitlements(shim.db);
  assert.equal(values["books.perMonth"], -1);
  assert.equal(values["packs.decades.pro"], 1);
  assert.equal(values["puzzles.pro"], 1);
  assert.equal(values["ai.themes.perDay"], 20);
  assert.equal(values["cover.builder"], 1);
});

test("Pro Lite has unlimited books and Pro formats but no AI themes or cover builder", async () => {
  const shim = testDb();
  await buyer(shim);
  await runIpn(shim.db, salePayload());
  await runIpn(shim.db, salePayload({ WP_ITEM_NUMBER: "wso_oto1_ds", WP_SALE: "sale_lite" }));
  const values = await entitlements(shim.db);
  assert.equal(values["books.perMonth"], -1);
  assert.equal(values["puzzles.pro"], 1);
  assert.equal(values["ai.themes.perDay"], 0);
  assert.equal(values["cover.builder"], 0);
});

test("an add-on without a Front End grants nothing", async () => {
  const shim = testDb();
  await buyer(shim);
  await runIpn(shim.db, salePayload({ WP_ITEM_NUMBER: "wso_oto2", WP_SALE: "sale_only_oto2" }));
  const values = await entitlements(shim.db);
  assert.equal(values["etsy.export"], 0);
  assert.equal(values["personalize.enabled"], 0);
  assert.equal(values["books.perMonth"], 0);
});

test("OTO2 and OTO3 grant their own keys", async () => {
  const shim = testDb();
  await buyer(shim);
  await runIpn(shim.db, salePayload());
  await runIpn(shim.db, salePayload({ WP_ITEM_NUMBER: "wso_oto2", WP_SALE: "sale_oto2" }));
  let values = await entitlements(shim.db);
  assert.equal(values["etsy.export"], 1);
  assert.equal(values["keepsake.pages"], 1);
  assert.equal(values["personalize.rowsPerBatch"], 100);
  assert.equal(values["credits.bridge"], 1000);
  await runIpn(shim.db, salePayload({ WP_ITEM_NUMBER: "wso_oto3", WP_SALE: "sale_oto3" }));
  values = await entitlements(shim.db);
  assert.equal(values.seats, 5);
  assert.equal(values.whitelabel, 1);
  assert.equal(values["commercial.license"], 1);
  assert.equal(values["dfy.books"], 1);
});

test("a Front End refund drops every key and marks active add-ons for refund", async () => {
  const shim = testDb();
  await buyer(shim);
  const sale = "sale_fe_cascade";
  await runIpn(shim.db, salePayload({ WP_SALE: sale }));
  await runIpn(shim.db, salePayload({ WP_ITEM_NUMBER: "wso_oto1", WP_SALE: "sale_addon" }));
  await runIpn(
    shim.db,
    salePayload({
      WP_ACTION: "subscr_created",
      WP_ITEM_NUMBER: "wso_club",
      WP_SALE: "sale_club",
      WP_SUBSCR_ID: "sub_1",
      WP_SUBSCR_PAYMENT_NUM: "1",
      WP_SUBSCR_NEXT_PAYMENT_DATE: "2026-12-01 00:00:00",
    }),
  );
  assert.equal((await entitlements(shim.db))["books.perMonth"], -1);

  await runIpn(shim.db, salePayload({ WP_ACTION: "refund", WP_SALE: sale, WP_SALE_AMOUNT: "-17.00" }));
  const values = await entitlements(shim.db);
  assert.equal(values["books.perMonth"], 0);
  assert.equal(values["ai.themes.perDay"], 0);
  assert.equal(values["club.drops"], 0);
  const addon = await purchase(shim.db, "sale_addon", "wso_oto1");
  assert.equal(addon?.status, "needs_review");
  assert.equal(addon?.review_reason, "fe_refunded_refund_addon");
  const club = await purchase(shim.db, "sale_club", "wso_club");
  assert.equal(club?.status, "needs_review");
});

test("one buyer gets exactly one licensed workspace", async () => {
  const shim = testDb();
  const userId = await buyer(shim);
  await runIpn(shim.db, salePayload());
  assert.equal(await licensedWorkspaces(shim.db), 1);
  const tenant = await shim.db.first<{ tenant_id: string }>("SELECT tenant_id FROM memberships WHERE user_id = ?", [
    userId,
  ]);
  assert.ok(tenant);
  // A second, hand-made workspace is not licensed and receives no entitlements.
  await shim.db.run(
    `INSERT INTO workspaces (id, app, slug, tenant_id, name, plan, status, licensed, created_at, updated_at)
     VALUES ('ws_hand', 'puzzle', 'hand-made', ?, 'Hand made', 'free', 'active', 0, ?, ?)`,
    [tenant.tenant_id, new Date().toISOString(), new Date().toISOString()],
  );
  assert.equal(await licensedWorkspaces(shim.db), 1);
  assert.equal(await entitlementValue(shim.db, "ws_hand", "books.perMonth"), 0);
});

test("an unverified account does not claim, and claims on first verified attach", async () => {
  const shim = testDb();
  const userId = await insertUser(shim.db, { email: "late@example.com", verified: false });
  await ensureTenant(shim.db, { id: userId, email: "late@example.com" });
  await runIpn(shim.db, salePayload({ WP_BUYER_EMAIL: "late@example.com" }));
  const row = await shim.db.first<{ tenant_id: string | null }>(
    "SELECT tenant_id FROM wp_purchases WHERE lower(buyer_email) = 'late@example.com'",
  );
  assert.equal(row?.tenant_id, null);
  assert.equal(await licensedWorkspaces(shim.db), 0);

  await shim.db.run('UPDATE "user" SET emailVerified = 1 WHERE id = ?', [userId]);
  const attached = await attachPurchases(shim.db, WARRIORPLUS, "late@example.com");
  assert.equal(attached?.claimed, 1);
  assert.equal(await licensedWorkspaces(shim.db), 1);
  const claimed = await shim.db.first<{ tenant_id: string | null }>(
    "SELECT tenant_id FROM wp_purchases WHERE lower(buyer_email) = 'late@example.com'",
  );
  assert.ok(claimed?.tenant_id);
});

test("a purchase made after sign-in reaches the same workspace without a new session", async () => {
  const shim = testDb();
  await buyer(shim);
  await runIpn(shim.db, salePayload());
  const first = await shim.db.first<{ id: string }>("SELECT id FROM workspaces WHERE licensed = 1");
  await runIpn(shim.db, salePayload({ WP_ITEM_NUMBER: "wso_bump", WP_SALE: "sale_later" }));
  const after = await shim.db.first<{ workspace_id: string }>(
    "SELECT workspace_id FROM wp_purchases WHERE sale = 'sale_later'",
  );
  assert.equal(after?.workspace_id, first?.id);
  assert.equal((await entitlements(shim.db))["packs.holiday"], 1);
});

test("a Club purchase grants club keys and keeps one row across events", async () => {
  const shim = testDb();
  await buyer(shim);
  await runIpn(shim.db, salePayload());
  await runIpn(
    shim.db,
    salePayload({
      WP_ACTION: "subscr_created",
      WP_ITEM_NUMBER: "wso_club",
      WP_SALE: "sale_club_2",
      WP_SUBSCR_ID: "sub_2",
      WP_SUBSCR_PAYMENT_NUM: "1",
      WP_SUBSCR_NEXT_PAYMENT_DATE: "2026-12-01 00:00:00",
    }),
  );
  await runIpn(
    shim.db,
    salePayload({
      WP_ACTION: "subscr_completed",
      WP_ITEM_NUMBER: "wso_club",
      WP_SALE: "sale_club_2",
      WP_SUBSCR_ID: "sub_2",
      WP_SUBSCR_PAYMENT_NUM: "2",
      WP_SUBSCR_NEXT_PAYMENT_DATE: "2027-01-01 00:00:00",
    }),
  );
  const rows = await shim.db.all<{ id: string; last_payment_num: number }>(
    "SELECT id, last_payment_num FROM wp_purchases WHERE sale = 'sale_club_2'",
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.last_payment_num, 2);
  assert.equal((await entitlements(shim.db))["club.drops"], 1);
});
