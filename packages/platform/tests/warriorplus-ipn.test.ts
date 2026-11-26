import assert from "node:assert/strict";
import test from "node:test";
import { closeTestWindow, handleWarriorPlusIpn, openTestWindow } from "../src/warriorplus/ipn";
import { DUMMY_SECURITY_KEY } from "../src/warriorplus/types";
import { platformConfigForWarriorPlus, runIpn, salePayload, testDb, testEnv } from "./warriorplus-support";

test.beforeEach(() => {
  platformConfigForWarriorPlus();
});

async function count(db: ReturnType<typeof testDb>["db"], table: string): Promise<number> {
  const row = await db.first<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`);
  return row?.count ?? 0;
}

test("a wrong security key returns 401 and writes nothing", async () => {
  const shim = testDb();
  const { response } = await runIpn(shim.db, salePayload({ WP_SECURITYKEY: "wrong" }));
  assert.equal(response.status, 401);
  assert.equal(await count(shim.db, "wp_ipn_events"), 0);
  assert.equal(await count(shim.db, "wp_purchases"), 0);
});

test("the next key works during rotation", async () => {
  const shim = testDb();
  const { response } = await runIpn(
    shim.db,
    salePayload({ WP_SECURITYKEY: "next_secret" }),
    testEnv({ WARRIORPLUS_IPN_KEY: "old_secret", WARRIORPLUS_IPN_KEY_NEXT: "next_secret" }),
  );
  assert.equal(response.status, 200);
  assert.equal(await count(shim.db, "wp_purchases"), 1);
});

test("Send Test's dummy key is refused outside a window and isolated inside one", async () => {
  const shim = testDb();
  const payload = salePayload({ WP_SECURITYKEY: DUMMY_SECURITY_KEY });
  let result = await runIpn(shim.db, payload);
  assert.equal(result.response.status, 401);
  assert.equal(await count(shim.db, "wp_ipn_test_events"), 0);
  assert.equal(await count(shim.db, "wp_ipn_events"), 0);
  assert.equal(await count(shim.db, "wp_purchases"), 0);

  await openTestWindow(shim.db, "puzzle", "adm_1", 5);
  result = await runIpn(shim.db, payload);
  assert.equal(result.response.status, 200);
  assert.equal(await count(shim.db, "wp_ipn_test_events"), 1);
  assert.equal(await count(shim.db, "wp_ipn_events"), 0);
  assert.equal(await count(shim.db, "wp_purchases"), 0);
  assert.equal(await count(shim.db, "workspace_entitlements"), 0);
  assert.equal(await count(shim.db, "email_outbox"), 0);

  await closeTestWindow(shim.db, "puzzle");
  result = await runIpn(shim.db, payload);
  assert.equal(result.response.status, 401);
});

test("a duplicate IPN is processed once", async () => {
  const shim = testDb();
  const payload = salePayload();
  await runIpn(shim.db, payload);
  await runIpn(shim.db, payload);
  assert.equal(await count(shim.db, "wp_ipn_events"), 1);
  assert.equal(await count(shim.db, "wp_purchases"), 1);
});

test("an unfinished event is recovered by a resend", async () => {
  const shim = testDb();
  const payload = salePayload();
  const ipnId = payload.IPN_ID;
  assert.ok(ipnId);
  await shim.db.run(
    `INSERT INTO wp_ipn_events (ipn_id, app, action, payload, status, attempts, received_at)
     VALUES (?, 'puzzle', 'sale', '{}', 'failed', 1, ?)`,
    [ipnId, new Date().toISOString()],
  );
  const { response } = await runIpn(shim.db, payload);
  assert.equal(response.status, 200);
  const event = await shim.db.first<{ status: string; attempts: number }>(
    "SELECT status, attempts FROM wp_ipn_events WHERE ipn_id = ?",
    [ipnId],
  );
  assert.equal(event?.status, "processed");
  assert.equal(event?.attempts, 2);
});

test("affiliate deliveries and obfuscated payloads are stored as ignored", async () => {
  const shim = testDb();
  await runIpn(shim.db, salePayload({ IPN_RCPT_TYPE: "aff" }));
  await runIpn(shim.db, salePayload({ WP_PII_OBFUSCATED: "1" }));
  const rows = await shim.db.all<{ status: string }>("SELECT status FROM wp_ipn_events");
  assert.deepEqual(
    rows.map((row) => row.status),
    ["ignored", "ignored"],
  );
  assert.equal(await count(shim.db, "wp_purchases"), 0);
});

test("malformed events need review and never create a purchase", async () => {
  const shim = testDb();
  await runIpn(shim.db, salePayload({ WP_BUYER_EMAIL: "" }));
  await runIpn(shim.db, salePayload({ WP_ITEM_NUMBER: "wso_unknown" }));
  const rows = await shim.db.all<{ status: string; error: string }>(
    "SELECT status, error FROM wp_ipn_events ORDER BY received_at",
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.status, "needs_review");
  assert.match(rows[0]?.error ?? "", /missing buyer email/);
  assert.equal(rows[1]?.status, "needs_review");
  assert.match(rows[1]?.error ?? "", /unknown product/);
  assert.equal(await count(shim.db, "wp_purchases"), 0);
});

test("the stored payload never contains the security key", async () => {
  const shim = testDb();
  await runIpn(shim.db, salePayload());
  const row = await shim.db.first<{ payload: string }>("SELECT payload FROM wp_ipn_events LIMIT 1");
  assert.ok(row);
  assert.equal(row.payload.includes("WP_SECURITYKEY"), false);
  assert.equal(row.payload.includes("ipn_test_secret"), false);
});

test("a refund before sale is a tombstone and a later sale does not reactivate it", async () => {
  const shim = testDb();
  const sale = "sale_tombstone";
  await runIpn(shim.db, salePayload({ WP_ACTION: "refund", WP_SALE: sale, WP_SALE_AMOUNT: "-17.00" }));
  await runIpn(shim.db, salePayload({ WP_SALE: sale }));
  const row = await shim.db.first<{ status: string }>("SELECT status FROM wp_purchases WHERE sale = ?", [sale]);
  assert.equal(row?.status, "refunded");
});

test("multipart IPNs parse as the documented wire format", async () => {
  const shim = testDb();
  const form = new FormData();
  for (const [key, value] of Object.entries(salePayload())) form.set(key, value);
  const request = new Request("https://largeprint.zhst.app/api/warriorplus/ipn", {
    method: "POST",
    body: form,
  });
  const processed: Promise<unknown>[] = [];
  const response = await handleWarriorPlusIpn(
    request,
    testEnv(),
    { waitUntil: (promise) => processed.push(promise) },
    (await import("./warriorplus-support")).WARRIORPLUS,
    shim.db,
  );
  await Promise.all(processed);
  assert.equal(response.status, 200);
  assert.equal(await count(shim.db, "wp_purchases"), 1);
});

test("GET is refused", async () => {
  const shim = testDb();
  const request = new Request("https://largeprint.zhst.app/api/warriorplus/ipn", { method: "GET" });
  const response = await handleWarriorPlusIpn(
    request,
    testEnv(),
    { waitUntil: () => {} },
    (await import("./warriorplus-support")).WARRIORPLUS,
    shim.db,
  );
  assert.equal(response.status, 405);
});
