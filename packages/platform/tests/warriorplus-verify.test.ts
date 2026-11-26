import assert from "node:assert/strict";
import test from "node:test";
import type { AdminActor } from "../src/admin";
import { ensureTenant } from "../src/tenancy";
import { grantComp } from "../src/warriorplus/admin";
import type { WarriorPlusClient, WarriorPlusSale } from "../src/warriorplus/client";
import { RetryableError } from "../src/warriorplus/client";
import { verifyPendingPurchases } from "../src/warriorplus/verify";
import {
  IPN_KEY,
  insertUser,
  platformConfigForWarriorPlus,
  runIpn,
  salePayload,
  testDb,
  testEnv,
  WARRIORPLUS,
} from "./warriorplus-support";

const ADMIN: AdminActor = { userId: "adm_1", email: "admin@example.com", role: "admin" };

async function buyer(shim: ReturnType<typeof testDb>) {
  const email = "buyer@example.com";
  const userId = await insertUser(shim.db, { email });
  await ensureTenant(shim.db, { id: userId, email, name: "Buyer" });
}

function sale(overrides: Partial<WarriorPlusSale> = {}): WarriorPlusSale {
  return {
    id: "sale_1",
    status: "active",
    productIds: ["wso_fe"],
    offerId: "offer_1",
    refundDate: null,
    payments: [],
    raw: {},
    ...overrides,
  };
}

function client(getSale: (id: string) => Promise<WarriorPlusSale | null>): WarriorPlusClient {
  return { getSale, listSales: async () => [] } as unknown as WarriorPlusClient;
}

test("404, 429 and 5xx never revoke or verify a purchase", async () => {
  const shim = testDb();
  await buyer(shim);
  await runIpn(shim.db, salePayload({ WP_SECURITYKEY: IPN_KEY }));
  const env = testEnv();
  const config = platformConfigForWarriorPlus({
    ...WARRIORPLUS,
    onVerified: async () => {
      throw new Error("must not run");
    },
  });

  let summary = await verifyPendingPurchases(
    env,
    shim.db,
    config,
    client(async () => null),
  );
  assert.equal(summary.retried, 1);
  summary = await verifyPendingPurchases(
    env,
    shim.db,
    config,
    client(async () => {
      throw new RetryableError("rate limited", 429);
    }),
  );
  assert.equal(summary.retried, 1);
  const row = await shim.db.first<{ status: string; verified_at: string | null }>(
    "SELECT status, verified_at FROM wp_purchases LIMIT 1",
  );
  assert.equal(row?.status, "active");
  assert.equal(row?.verified_at, null);
});

test("a product mismatch needs review and is never revoked automatically", async () => {
  const shim = testDb();
  await buyer(shim);
  await runIpn(shim.db, salePayload());
  let verified = 0;
  const config = platformConfigForWarriorPlus({
    ...WARRIORPLUS,
    onVerified: async () => {
      verified += 1;
    },
  });
  const summary = await verifyPendingPurchases(
    testEnv(),
    shim.db,
    config,
    client(async () => sale({ productIds: ["wso_other"] })),
  );
  assert.equal(summary.needsReview, 1);
  assert.equal(verified, 0);
  const row = await shim.db.first<{ status: string; review_reason: string | null; revoked_at: string | null }>(
    "SELECT status, review_reason, revoked_at FROM wp_purchases LIMIT 1",
  );
  assert.equal(row?.status, "needs_review");
  assert.equal(row?.review_reason, "rest_product_mismatch");
  assert.equal(row?.revoked_at, null);
});

test("a REST-refunded sale needs review, not an automatic revocation", async () => {
  const shim = testDb();
  await buyer(shim);
  await runIpn(shim.db, salePayload());
  const config = platformConfigForWarriorPlus(WARRIORPLUS);
  await verifyPendingPurchases(
    testEnv(),
    shim.db,
    config,
    client(async () => sale({ status: "refunded" })),
  );
  const row = await shim.db.first<{ status: string; review_reason: string }>(
    "SELECT status, review_reason FROM wp_purchases LIMIT 1",
  );
  assert.equal(row?.status, "needs_review");
  assert.equal(row?.review_reason, "rest_refunded");
});

test("verification runs the value-bearing hook exactly once", async () => {
  const shim = testDb();
  await buyer(shim);
  await runIpn(shim.db, salePayload());
  let verified = 0;
  const config = platformConfigForWarriorPlus({
    ...WARRIORPLUS,
    onVerified: async () => {
      verified += 1;
    },
  });
  assert.equal(verified, 0, "ingest must not grant credits");
  await verifyPendingPurchases(
    testEnv(),
    shim.db,
    config,
    client(async () => sale()),
  );
  assert.equal(verified, 1);
  const second = await verifyPendingPurchases(
    testEnv(),
    shim.db,
    config,
    client(async () => sale()),
  );
  assert.equal(second.checked, 0);
  assert.equal(verified, 1);
});

test("recurring payments grant only in sequence", async () => {
  const shim = testDb();
  await buyer(shim);
  await runIpn(shim.db, salePayload());
  await runIpn(
    shim.db,
    salePayload({
      WP_ACTION: "subscr_created",
      WP_ITEM_NUMBER: "wso_club",
      WP_SALE: "sale_club_verify",
      WP_SUBSCR_ID: "sub_verify",
      WP_SUBSCR_PAYMENT_NUM: "1",
      WP_SUBSCR_NEXT_PAYMENT_DATE: "2026-12-01 00:00:00",
    }),
  );
  const granted: number[] = [];
  const config = platformConfigForWarriorPlus({
    ...WARRIORPLUS,
    onPaymentCompleted: async (_db, _purchase, paymentNum) => {
      granted.push(paymentNum);
    },
  });
  await verifyPendingPurchases(
    testEnv(),
    shim.db,
    config,
    client(async () =>
      sale({
        productIds: ["wso_club"],
        payments: [{ paymentNum: 1, status: "completed" }],
      }),
    ),
  );
  assert.deepEqual(granted, [1]);
  const row = await shim.db.first<{ last_granted_payment_num: number }>(
    "SELECT last_granted_payment_num FROM wp_purchases WHERE item_number = 'wso_club'",
  );
  assert.equal(row?.last_granted_payment_num, 1);

  // A later, out-of-sequence payment never grants.
  await shim.db.run("UPDATE wp_purchases SET verified_at = NULL WHERE item_number = 'wso_club'");
  await verifyPendingPurchases(
    testEnv(),
    shim.db,
    config,
    client(async () =>
      sale({
        productIds: ["wso_club"],
        payments: [{ paymentNum: 3, status: "completed" }],
      }),
    ),
  );
  assert.deepEqual(granted, [1]);
});

test("comps are never looked up in REST and never raise the unverified alert", async () => {
  const shim = testDb();
  await buyer(shim);
  await grantComp(shim.db, platformConfigForWarriorPlus(WARRIORPLUS), ADMIN, {
    email: "buyer@example.com",
    productCode: "fe",
    reason: "reviewer account",
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
  await shim.db.run("UPDATE wp_purchases SET granted_at = '2020-01-01T00:00:00.000Z' WHERE kind = 'comp'");
  await runIpn(shim.db, salePayload({ WP_SECURITYKEY: IPN_KEY }));

  const looked: string[] = [];
  const summary = await verifyPendingPurchases(
    testEnv(),
    shim.db,
    platformConfigForWarriorPlus(WARRIORPLUS),
    client(async (id) => {
      looked.push(id);
      return sale({ id });
    }),
  );
  assert.equal(summary.checked, 1);
  assert.equal(looked.length, 1);
  assert.ok(!looked.some((id) => id.startsWith("comp_")));
  const comp = await shim.db.first<{ verified_at: string | null }>(
    "SELECT verified_at FROM wp_purchases WHERE kind = 'comp'",
  );
  assert.equal(comp?.verified_at, null);
});
