import assert from "node:assert/strict";
import { test } from "node:test";
import { listCustomers, notifyCheckoutStarted, reconcileCrm, runUsageDigest, usageLines, usageReport } from "@templatedesign/platform/crm";
import type { Db } from "@templatedesign/platform/db";
import { attachCheckout, createPaymentRow } from "@templatedesign/platform/payments";
import "../src/lib/platform";
import { createTestDb } from "./support/db";
import { createAccount, testEnv } from "./support/fixtures";

const NOW = Date.UTC(2026, 10, 2, 12, 30, 0);
const HOUR = 3_600_000;
const BLOCK = 6 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();

async function insertJob(
  db: Db,
  tenantId: string | null,
  status: string,
  createdAt: string,
  extra: { minutes?: number; credits?: number; error?: string; api?: boolean } = {},
) {
  await db.run(
    `INSERT INTO transcription_jobs (id, tenant_id, guest_id, source_kind, source_ref, status, billable_minutes,
       charged_credits, via_api, error_code, queued_at, created_at, updated_at)
     VALUES (?, ?, ?, 'youtube', 'ref', ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      `job_${Math.random().toString(16).slice(2)}`,
      tenantId,
      tenantId ? null : "guest_1",
      status,
      extra.minutes ?? null,
      extra.credits ?? 0,
      extra.api ? 1 : 0,
      extra.error ?? null,
      createdAt,
      createdAt,
      createdAt,
    ],
  );
}

test("the first successful transcription is the second journey step, guests are excluded", async () => {
  const { db, close } = createTestDb();
  try {
    const { tenantId } = await createAccount(db);
    await insertJob(db, tenantId, "failed", iso(NOW - 3 * HOUR));
    await insertJob(db, tenantId, "succeeded", iso(NOW - 2 * HOUR), { minutes: 5 });
    await insertJob(db, null, "succeeded", iso(NOW - HOUR));
    await reconcileCrm(db);
    await reconcileCrm(db);

    const list = await listCustomers(db, {}, NOW);
    assert.equal(list.total, 1);
    assert.equal(list.items[0].stage, "first_success");
    const events = await db.all<{ step: string }>("SELECT step FROM crm_events WHERE tenant_id = ? ORDER BY step", [tenantId]);
    assert.deepEqual(
      events.map((event) => event.step),
      ["first_success", "signed_up"],
    );
  } finally {
    close();
  }
});

test("usage counts accounts, guests, API calls, minutes and errors inside the window", async () => {
  const { db, close } = createTestDb();
  try {
    const { tenantId } = await createAccount(db);
    const end = Math.floor(NOW / BLOCK) * BLOCK;
    await insertJob(db, tenantId, "succeeded", iso(end - HOUR), { minutes: 7, credits: 7, api: true });
    await insertJob(db, tenantId, "failed", iso(end - 2 * HOUR), { error: "source_unavailable" });
    await insertJob(db, null, "succeeded", iso(end - 3 * HOUR), { minutes: 2 });
    await insertJob(db, tenantId, "succeeded", iso(end - 7 * HOUR), { minutes: 99 });

    const report = await usageReport(db, end - BLOCK, end);
    assert.equal(report.product.headline, "3 lượt phiên âm");
    const lines = usageLines(report, 1, 0).join("\n");
    assert.match(lines, /Lượt phiên âm: 3 \(thành công 2, lỗi 1\)/);
    assert.match(lines, /Số phút đã tính: 9\. Credit đã dùng: 7/);
    assert.match(lines, /Khách vãng lai: 1\. Qua API: 1/);
    assert.match(lines, /source_unavailable 1/);

    const env = { ...testEnv(), SALES_ALERT_EMAIL: "ops@example.com" };
    assert.equal(await runUsageDigest(env, db, NOW), true);
    assert.equal(await runUsageDigest(env, db, NOW + 60_000), false);
  } finally {
    close();
  }
});

test("pressing buy emails the operator once", async () => {
  const { db, close } = createTestDb();
  try {
    const { user, tenantId } = await createAccount(db);
    const row = await createPaymentRow(db, {
      tenantId,
      userId: user.id,
      provider: "stripe",
      packId: "starter",
      credits: 100,
      amountCents: 500,
      idempotencyKey: "k1",
    });
    await attachCheckout(db, row.id, { providerCheckoutId: "cs_1", url: "https://example.com/c" });
    const payment = await db.first<Parameters<typeof notifyCheckoutStarted>[2]>("SELECT * FROM payments WHERE id = ?", [row.id]);
    assert.ok(payment);
    const env = { ...testEnv(), SALES_ALERT_EMAIL: "ops@example.com" };
    await notifyCheckoutStarted(env, db, payment);
    await notifyCheckoutStarted(env, db, payment);
    const mails = await db.all<{ to_email: string; template: string }>("SELECT to_email, template FROM email_outbox");
    assert.deepEqual(
      mails.map((mail) => ({ ...mail })),
      [{ to_email: "ops@example.com", template: "ops_notice" }],
    );
  } finally {
    close();
  }
});
