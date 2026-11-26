import assert from "node:assert/strict";
import { test } from "node:test";
import { adminMetrics, getAdminSettings, setAdminSetting } from "../src/admin";
import { createPlatform, packById, platformConfig, resetPlatformConfig } from "../src/config";
import { ensureWallet, reserveGuestCredits } from "../src/credits";
import { HttpError } from "../src/http";
import { createApiKey, isWellFormedApiKey } from "../src/keys";
import { ensureTenant } from "../src/tenancy";
import { createWebhookEndpoint, webhookEvents } from "../src/webhooks";
import { createTestDb } from "./support/db";
import { configureTestPlatform, proposeTestActor } from "./support/platform";

test("the platform baseline applies without any product table", () => {
  const { db, raw, close } = createTestDb();
  try {
    const tables = raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name);
    for (const table of ["tenants", "wallets", "ledger_entries", "webhook_deliveries", "payments", "admin_settings"]) {
      assert.ok(tables.includes(table), `${table} should exist`);
    }
    for (const table of ["templates", "jobs", "outputs", "share_links", "assets"]) {
      assert.ok(!tables.includes(table), `${table} is product-specific and must not be in the baseline`);
    }
    assert.ok(db);
  } finally {
    close();
  }
});

test("guests see the product's own copy, not a platform default", async () => {
  configureTestPlatform();
  const { db, close } = createTestDb();
  try {
    await assert.rejects(
      () => reserveGuestCredits(db, "guest-1", 9),
      (error: unknown) => error instanceof HttpError && /Test files are limited to 2 per day/.test(error.message),
    );
    await reserveGuestCredits(db, "guest-1", 2);
    await assert.rejects(
      () => reserveGuestCredits(db, "guest-1", 2),
      (error: unknown) => error instanceof HttpError && /Sign in for 50 free credits/.test(error.message),
    );
  } finally {
    close();
  }
});

test("packs come from the app, so an unknown pack id is rejected", () => {
  configureTestPlatform();
  assert.equal(packById("starter")?.credits, 1000);
  assert.equal(packById("does-not-exist"), null);
});

test("API key scopes and prefix are per product", async () => {
  configureTestPlatform();
  assert.equal(isWellFormedApiKey("tt_live_" + "a".repeat(32) + "abcdef"), false);
  const { db, close } = createTestDb();
  try {
    await db.run(
      'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
      ["usr_1", "User", "user@example.com", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"],
    );
    const tenantId = await ensureTenant(db, { id: "usr_1", email: "user@example.com", name: "User" });
    await ensureWallet(db, tenantId);
    const created = await createApiKey(
      {
        DB: {} as D1Database,
        BETTER_AUTH_SECRET: "x",
        BETTER_AUTH_URL: "http://localhost",
        APP_ORIGIN: "http://localhost",
      },
      db,
      {
        user: { id: "usr_1", email: "user@example.com", name: "User", emailVerified: true },
        tenantId,
        profile: {
          userId: "usr_1",
          tenantId,
          displayName: "User",
          uiLanguage: "en",
          docLanguage: "en",
          defaultRetentionSeconds: 3600,
          numberLocale: "en-US",
          dateLocale: "en-GB",
          lowBalanceEmail: false,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      },
      { name: "CI" },
    );
    assert.match(created.key, /^tt_live_/);
    assert.deepEqual(created.metadata.scopes, ["transcriptions:write", "transcriptions:read"]);
    await assert.rejects(
      () =>
        createApiKey(
          {
            DB: {} as D1Database,
            BETTER_AUTH_SECRET: "x",
            BETTER_AUTH_URL: "http://localhost",
            APP_ORIGIN: "http://localhost",
          },
          db,
          {
            user: { id: "usr_1", email: "user@example.com", name: "User", emailVerified: true },
            tenantId,
            profile: {
              userId: "usr_1",
              tenantId,
              displayName: "User",
              uiLanguage: "en",
              docLanguage: "en",
              defaultRetentionSeconds: 3600,
              numberLocale: "en-US",
              dateLocale: "en-GB",
              lowBalanceEmail: false,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          },
          { name: "bad", scopes: ["jobs:write"] },
        ),
      (error: unknown) => error instanceof HttpError && error.status === 400,
    );
  } finally {
    close();
  }
});

test("webhook events are the product's, and an unknown event is rejected", async () => {
  configureTestPlatform();
  assert.deepEqual(webhookEvents(), ["transcription.completed", "transcription.failed", "webhook.test"]);
  const { db, close } = createTestDb();
  try {
    await assert.rejects(
      () =>
        createWebhookEndpoint(
          {
            DB: {} as D1Database,
            BETTER_AUTH_SECRET: "x",
            BETTER_AUTH_URL: "http://localhost",
            APP_ORIGIN: "http://localhost",
          },
          db,
          { tenantId: "ten_1", userId: "usr_1" },
          { url: "https://example.com/hook", events: ["job.succeeded"] },
          async () => new Response(JSON.stringify({ challenge: "x" }), { status: 200 }),
        ),
      (error: unknown) => error instanceof HttpError && error.status === 400,
    );
  } finally {
    close();
  }
});

test("product admin hooks replace the platform's job queries", async () => {
  configureTestPlatform();
  const { db, close } = createTestDb();
  try {
    await db.run("INSERT INTO tenants (id, name, created_at) VALUES ('ten_1', 'A', '2026-01-01T00:00:00.000Z')");
    await db.run(
      'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
      ["usr_1", "User", "user@example.com", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"],
    );
    await db.run(
      "INSERT INTO memberships (user_id, tenant_id, role, created_at) VALUES ('usr_1', 'ten_1', 'owner', '2026-01-01T00:00:00.000Z')",
    );
    await db.run(
      "INSERT INTO profiles (user_id, tenant_id, display_name, created_at, updated_at) VALUES ('usr_1', 'ten_1', 'User', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
    );
    await ensureWallet(db, "ten_1");
    const metrics = await adminMetrics(db);
    assert.equal(metrics.jobs24h, 3);
    assert.deepEqual(metrics.failureByLabel, [{ label: "gdrive", count: 1 }]);
    assert.equal(metrics.tenants, 1);
  } finally {
    close();
  }
});

test("extra settings are validated with their kind and read back generically", async () => {
  configureTestPlatform();
  const { db, close } = createTestDb();
  try {
    const actor = proposeTestActor();
    await setAdminSetting(db, actor, "transcript.monthly_cap_minutes", 600, "test");
    const settings = await getAdminSettings(db);
    assert.equal(settings.freeMonthlyCredits, 50);
    await assert.rejects(
      () => setAdminSetting(db, actor, "transcript.monthly_cap_minutes", -1, "test"),
      (error: unknown) => error instanceof HttpError && error.status === 400,
    );
    const { getAdminSettingValue } = await import("../src/admin");
    assert.equal(await getAdminSettingValue(db, "transcript.monthly_cap_minutes"), 600);
  } finally {
    close();
  }
});

test("resetPlatformConfig restores the defaults so tests do not leak state", () => {
  configureTestPlatform();
  assert.equal(platformConfig().brand.name, "TestProduct");
  resetPlatformConfig();
  assert.equal(platformConfig().brand.name, "Platform");
  const created = createPlatform({ ...platformConfig(), brand: { ...platformConfig().brand, name: "Again" } });
  assert.equal(created.brand.name, "Again");
});
