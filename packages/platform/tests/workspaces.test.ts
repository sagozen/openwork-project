import assert from "node:assert/strict";
import { test } from "node:test";
import type { Db } from "../src/db";
import { HttpError } from "../src/http";
import {
  addMember,
  checkEntitlement,
  consume,
  createWorkspace,
  entitlementLimit,
  expireWorkspacePlans,
  getBranding,
  listWorkspacesForUser,
  purchasePlan,
  refund,
  requireEntitlement,
  requireMember,
  resolveBrand,
  resolveWorkspace,
  setWorkspacePlan,
  setWorkspaceStatus,
  slugProblem,
  updateBranding,
} from "../src/workspaces";
import { createTestDb } from "./support/db";
import { configureTestPlatform } from "./support/platform";

const rejected = (code: string, status: number) => (error: unknown) =>
  error instanceof HttpError && error.code === code && error.status === status;

async function account(db: Db, index: number) {
  const userId = `usr_${index}`;
  const tenantId = `ten_${index}`;
  const now = "2026-01-01T00:00:00.000Z";
  await db.run('INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)', [
    userId,
    `User ${index}`,
    `u${index}@example.com`,
    now,
    now,
  ]);
  await db.run("INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)", [tenantId, `Tenant ${index}`, now]);
  return { userId, tenantId };
}

function configure() {
  configureTestPlatform({
    plans: {
      free: { name: "Free", entitlements: { branches: 1, orders: 3, "brand.logo": true, sepay: false } },
      pro: { name: "Pro", entitlements: { branches: 20, orders: -1, "brand.logo": true, sepay: true } },
    },
    reservedSlugs: ["acme-internal"],
    maxFreeWorkspacesPerUser: 2,
  });
}

test("slugs follow the pattern and the reserved list", () => {
  configure();
  assert.equal(slugProblem("pho-24"), null);
  assert.equal(slugProblem("a1b"), null);
  for (const bad of ["ab", "-abc", "abc-", "a--b", "UPPER", "has space", "a".repeat(41), "dot.slug", ""]) {
    assert.equal(slugProblem(bad), "invalid", bad);
  }
  for (const reserved of ["admin", "api", "pricing", "_astro", "acme-internal"]) {
    assert.equal(slugProblem(reserved), reserved === "_astro" ? "invalid" : "reserved", reserved);
  }
  assert.equal(slugProblem("a".repeat(40)), null);
});

test("createWorkspace makes the caller the owner and rejects bad, reserved and taken slugs", async () => {
  configure();
  const { db, close } = createTestDb({ modules: ["workspaces"] });
  try {
    const alice = await account(db, 1);
    const bob = await account(db, 2);
    const ws = await createWorkspace(db, { app: "restaurant", slug: "pho-24", ...alice, name: "Phở 24" });
    assert.equal(ws.plan, "free");
    assert.equal((await requireMember(db, ws, alice.userId)).role, "owner");

    await assert.rejects(
      () => createWorkspace(db, { app: "restaurant", slug: "admin", ...bob }),
      rejected("invalid_input", 400),
    );
    await assert.rejects(
      () => createWorkspace(db, { app: "restaurant", slug: "x", ...bob }),
      rejected("invalid_input", 400),
    );
    await assert.rejects(
      () => createWorkspace(db, { app: "restaurant", slug: "pho-24", ...bob }),
      rejected("revision_conflict", 409),
    );
    // Same slug in another app is a different workspace.
    await createWorkspace(db, { app: "erp", slug: "pho-24", ...bob });
    assert.equal((await listWorkspacesForUser(db, "restaurant", alice.userId)).length, 1);
  } finally {
    close();
  }
});

test("a user can own only so many free workspaces per app", async () => {
  configure();
  const { db, close } = createTestDb({ modules: ["workspaces"] });
  try {
    const alice = await account(db, 1);
    await createWorkspace(db, { app: "erp", slug: "one", ...alice });
    await createWorkspace(db, { app: "erp", slug: "two", ...alice });
    await assert.rejects(
      () => createWorkspace(db, { app: "erp", slug: "three", ...alice }),
      rejected("quota_exceeded", 402),
    );
    // The limit is per app.
    await createWorkspace(db, { app: "ota", slug: "three", ...alice });
  } finally {
    close();
  }
});

test("requireMember checks membership, roles and the locked flag", async () => {
  configure();
  const { db, close } = createTestDb({ modules: ["workspaces"] });
  try {
    const alice = await account(db, 1);
    const bob = await account(db, 2);
    const carol = await account(db, 3);
    const ws = await createWorkspace(db, { app: "restaurant", slug: "pho-24", ...alice });
    await addMember(db, ws.id, bob.userId, "cashier");

    assert.equal((await requireMember(db, ws, bob.userId, ["cashier"])).role, "cashier");
    await assert.rejects(() => requireMember(db, ws, bob.userId, ["manager"]), rejected("forbidden", 403));
    await assert.rejects(() => requireMember(db, ws, carol.userId), rejected("forbidden", 403));
    // The owner satisfies any role list.
    await requireMember(db, ws, alice.userId, ["manager"]);
    // Nobody can be promoted to owner or demote the owner through addMember.
    await assert.rejects(() => addMember(db, ws.id, bob.userId, "owner"), rejected("invalid_input", 400));
    await addMember(db, ws.id, alice.userId, "staff");
    assert.equal((await requireMember(db, ws, alice.userId)).role, "owner");

    const locked = await setWorkspaceStatus(db, ws, "locked");
    await assert.rejects(() => requireMember(db, locked, alice.userId), rejected("forbidden", 403));
  } finally {
    close();
  }
});

test("resolveWorkspace caches by app and slug and ignores malformed slugs", async () => {
  configure();
  const { db, close } = createTestDb({ modules: ["workspaces"] });
  try {
    const alice = await account(db, 1);
    const ws = await createWorkspace(db, { app: "restaurant", slug: "pho-24", ...alice });
    const store = new Map<string, string>();
    const cache = {
      get: async (key: string) => store.get(key) ?? null,
      put: async (key: string, value: string) => void store.set(key, value),
      delete: async (key: string) => void store.delete(key),
    };
    assert.equal((await resolveWorkspace(db, "restaurant", "pho-24", cache))?.id, ws.id);
    assert.equal(store.size, 1);
    assert.equal(await resolveWorkspace(db, "erp", "pho-24", cache), null);
    assert.equal(await resolveWorkspace(db, "restaurant", "../etc", cache), null);
    const upgraded = await setWorkspacePlan(db, ws, "pro", cache);
    assert.equal(store.size, 0, "a plan change drops the cached copy");
    assert.equal((await resolveWorkspace(db, "restaurant", "pho-24", cache))?.plan, upgraded.plan);
  } finally {
    close();
  }
});

test("brand falls back to the app brand and validates what a workspace sets", async () => {
  configure();
  const { db, close } = createTestDb({ modules: ["workspaces"] });
  try {
    const alice = await account(db, 1);
    const ws = await createWorkspace(db, { app: "restaurant", slug: "pho-24", ...alice, name: "Phở 24" });
    assert.equal((await resolveBrand(db, ws)).displayName, "Phở 24");

    await db.run("UPDATE workspace_branding SET display_name = NULL WHERE workspace_id = ?", [ws.id]);
    const fallback = await resolveBrand(db, ws);
    assert.equal(fallback.displayName, "TestProduct");
    assert.equal(fallback.isDefault, true);

    await updateBranding(db, ws.id, {
      displayName: "  Quán Phở  ",
      logoKey: "brand/x/abc.png",
      accentColor: "#c0392b",
    });
    const brand = await resolveBrand(db, ws);
    assert.deepEqual(
      { name: brand.displayName, logo: brand.logoKey, accent: brand.accentColor, isDefault: brand.isDefault },
      { name: "Quán Phở", logo: "brand/x/abc.png", accent: "#c0392b", isDefault: false },
    );
    await assert.rejects(() => updateBranding(db, ws.id, { accentColor: "red" }), rejected("invalid_input", 400));
    await assert.rejects(
      () => updateBranding(db, ws.id, { accentColor: "url(javascript:alert(1))" }),
      rejected("invalid_input", 400),
    );
    await assert.rejects(() => updateBranding(db, ws.id, { displayName: " " }), rejected("invalid_input", 400));
    // A rejected patch changes nothing.
    assert.equal((await getBranding(db, ws.id)).accentColor, "#c0392b");

    // Another workspace is unaffected.
    const bob = await account(db, 2);
    const other = await createWorkspace(db, { app: "restaurant", slug: "bun-cha", ...bob });
    assert.equal((await resolveBrand(db, other)).logoKey, null);
  } finally {
    close();
  }
});

test("entitlements come from the plan, overrides win, and consume stops at the limit", async () => {
  configure();
  const { db, close } = createTestDb({ modules: ["workspaces"] });
  try {
    const alice = await account(db, 1);
    const ws = await createWorkspace(db, { app: "restaurant", slug: "pho-24", ...alice });

    assert.equal(await entitlementLimit(db, ws, "branches"), 1);
    assert.equal(await entitlementLimit(db, ws, "sepay"), 0);
    assert.equal(await entitlementLimit(db, ws, "brand.logo"), 1);
    assert.equal(await entitlementLimit(db, ws, "unknown"), 0);

    // Stock limits compare the app's own row count.
    assert.equal((await checkEntitlement(db, ws, "branches", { current: 0 })).allowed, true);
    assert.equal((await checkEntitlement(db, ws, "branches", { current: 1 })).allowed, false);
    await assert.rejects(() => requireEntitlement(db, ws, "branches", { current: 1 }), rejected("quota_exceeded", 402));

    // Counters stop exactly at the limit and a refused call changes nothing.
    for (let index = 0; index < 3; index += 1) await consume(db, ws, "orders", 1, "2026-10");
    await assert.rejects(() => consume(db, ws, "orders", 1, "2026-10"), rejected("quota_exceeded", 402));
    assert.equal((await checkEntitlement(db, ws, "orders", { period: "2026-10" })).used, 3);
    // A new month starts fresh and an oversized first request is refused outright.
    await consume(db, ws, "orders", 1, "2026-11");
    await assert.rejects(() => consume(db, ws, "orders", 4, "2026-12"), rejected("quota_exceeded", 402));
    assert.equal((await checkEntitlement(db, ws, "orders", { period: "2026-12" })).used, 0);

    await refund(db, ws, "orders", 2, "2026-10");
    await consume(db, ws, "orders", 2, "2026-10");

    // Overrides beat the plan; -1 is unlimited.
    await db.run("INSERT INTO workspace_entitlements (workspace_id, key, limit_value) VALUES (?, 'branches', 5)", [
      ws.id,
    ]);
    assert.equal(await entitlementLimit(db, ws, "branches"), 5);

    // Upgrading opens the limits; downgrading blocks new work without touching rows.
    const pro = await setWorkspacePlan(db, ws, "pro");
    assert.equal(await entitlementLimit(db, pro, "sepay"), 1);
    for (let index = 0; index < 10; index += 1) await consume(db, pro, "orders", 1, "2026-10");
    const back = await setWorkspacePlan(db, pro, "free");
    await assert.rejects(() => consume(db, back, "orders", 1, "2026-10"), rejected("quota_exceeded", 402));
    await assert.rejects(() => setWorkspacePlan(db, back, "gold"), rejected("invalid_input", 400));
  } finally {
    close();
  }
});

test("a paid plan is bought with credits, renews from its expiry and falls back to free when it ends", async () => {
  configureTestPlatform({
    plans: {
      free: { name: "Free", entitlements: { orders: 3 } },
      pro: { name: "Pro", priceCredits: 400, periodDays: 30, entitlements: { orders: -1 } },
    },
  });
  const { db, close } = createTestDb({ modules: ["workspaces"] });
  try {
    const alice = await account(db, 1);
    const ws = await createWorkspace(db, { app: "restaurant", slug: "pho-24", ...alice });
    const fund = (credits: number) =>
      db.run(
        `INSERT INTO wallets (tenant_id, free_balance, purchased_balance, reserved_credits, free_reset_at, updated_at)
         VALUES (?, 0, ?, 0, '2099-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
         ON CONFLICT (tenant_id) DO UPDATE SET purchased_balance = ?`,
        [alice.tenantId, credits, credits],
      );
    const purchased = async () =>
      (
        await db.first<{ purchased_balance: number }>("SELECT purchased_balance FROM wallets WHERE tenant_id = ?", [
          alice.tenantId,
        ])
      )?.purchased_balance;

    // Not enough credits: nothing changes and the reservation is not left behind.
    await fund(100);
    await assert.rejects(() => purchasePlan(db, ws, "pro"), rejected("insufficient_credits", 402));
    assert.equal((await resolveWorkspace(db, "restaurant", "pho-24"))?.plan, "free");
    assert.equal(
      (await db.first<{ r: number }>("SELECT reserved_credits AS r FROM wallets WHERE tenant_id = ?", [alice.tenantId]))
        ?.r,
      0,
    );

    await fund(1000);
    const first = await purchasePlan(db, ws, "pro");
    assert.equal(first.charged, 400);
    assert.equal(await purchased(), 600);
    assert.equal(first.workspace.plan, "pro");
    const live = await resolveWorkspace(db, "restaurant", "pho-24");
    assert.equal(live?.plan, "pro");
    assert.equal(await entitlementLimit(db, live as NonNullable<typeof live>, "orders"), -1);
    const days = (Date.parse(live?.planExpiresAt ?? "") - Date.now()) / 86_400_000;
    assert.ok(days > 29.9 && days <= 30);

    // Renewing early stacks a second period on top of the first.
    const renewed = await purchasePlan(db, live as NonNullable<typeof live>, "pro");
    const stacked = (Date.parse(renewed.workspace.planExpiresAt ?? "") - Date.now()) / 86_400_000;
    assert.ok(stacked > 59.9 && stacked <= 60);
    assert.equal(await purchased(), 200);

    // Plans that are not for sale, and unknown plans, are refused.
    await assert.rejects(() => purchasePlan(db, ws, "free"), rejected("invalid_input", 400));
    await assert.rejects(() => purchasePlan(db, ws, "gold"), rejected("invalid_input", 400));

    // When the period ends the workspace reads as free immediately and the daily job persists it.
    await db.run("UPDATE workspaces SET plan_expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?", [ws.id]);
    const lapsed = await resolveWorkspace(db, "restaurant", "pho-24");
    assert.equal(lapsed?.plan, "free");
    assert.equal(await entitlementLimit(db, lapsed as NonNullable<typeof lapsed>, "orders"), 3);
    assert.equal(await expireWorkspacePlans(db), 1);
    assert.equal(await expireWorkspacePlans(db), 0);
    assert.equal((await db.first<{ plan: string }>("SELECT plan FROM workspaces WHERE id = ?", [ws.id]))?.plan, "free");
    assert.equal(await purchased(), 200, "expiring a plan does not refund or charge");
  } finally {
    close();
  }
});
