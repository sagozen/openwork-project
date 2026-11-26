import type { WarriorPlusConfig } from "../config";
import type { Db } from "../db";
import { id, nowIso } from "../db";
import { materializeEntitlements } from "./entitlements";

export interface AttachResult {
  tenantId: string;
  workspaceId: string;
  claimed: number;
  createdWorkspace: boolean;
}

function randomSlug(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return `u-${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Each buyer has exactly one licensed workspace. It is created on their tenant the first time a
 * verified email matches a purchase, and never again: a second workspace would multiply the
 * book quota and seats.
 */
export async function ensureLicensedWorkspace(
  db: Db,
  config: WarriorPlusConfig,
  tenantId: string,
  userId: string,
): Promise<{ workspaceId: string; created: boolean }> {
  const existing = await db.first<{ id: string }>(
    "SELECT id FROM workspaces WHERE app = ? AND tenant_id = ? AND licensed = 1 ORDER BY created_at LIMIT 1",
    [config.app, tenantId],
  );
  if (existing) {
    await db.run(
      "INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)",
      [existing.id, userId, nowIso()],
    );
    return { workspaceId: existing.id, created: false };
  }
  const workspaceId = id("ws");
  const timestamp = nowIso();
  const slug = randomSlug();
  await db.batch([
    {
      sql: `INSERT INTO workspaces (id, app, slug, tenant_id, name, plan, status, licensed, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'My books', 'free', 'active', 1, ?, ?)`,
      params: [workspaceId, config.app, slug, tenantId, timestamp, timestamp],
    },
    {
      sql: "INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)",
      params: [workspaceId, userId, timestamp],
    },
    {
      sql: "INSERT INTO workspace_branding (workspace_id, display_name, updated_at) VALUES (?, 'My books', ?)",
      params: [workspaceId, timestamp],
    },
  ]);
  return { workspaceId, created: true };
}

/**
 * Attach every purchase for a verified email to that buyer's tenant and licensed workspace, then
 * recompute entitlements. Idempotent, and safe to call after ingest, in `onUserCreated` and on
 * every `/app` load (the lazy repair path).
 */
export async function attachPurchases(db: Db, config: WarriorPlusConfig, email: string): Promise<AttachResult | null> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return null;
  const user = await db.first<{ id: string }>(
    'SELECT id FROM "user" WHERE lower(email) = ? AND emailVerified = 1 LIMIT 1',
    [normalized],
  );
  if (!user) return null;

  const membership = await db.first<{ tenant_id: string }>(
    "SELECT tenant_id FROM memberships WHERE user_id = ? LIMIT 1",
    [user.id],
  );
  const tenantId =
    membership?.tenant_id ??
    (
      await db.first<{ tenant_id: string }>(
        "SELECT tenant_id FROM wp_purchases WHERE app = ? AND lower(buyer_email) = ? AND tenant_id IS NOT NULL LIMIT 1",
        [config.app, normalized],
      )
    )?.tenant_id;
  if (!tenantId) return null;

  const workspace = await ensureLicensedWorkspace(db, config, tenantId, user.id);
  const timestamp = nowIso();
  const { changes } = await db.run(
    `UPDATE wp_purchases
        SET tenant_id = ?, workspace_id = ?, updated_at = ?
      WHERE app = ? AND lower(buyer_email) = ? AND (tenant_id IS NULL OR tenant_id = ?)`,
    [tenantId, workspace.workspaceId, timestamp, config.app, normalized, tenantId],
  );
  await materializeEntitlements(db, config, tenantId);
  return {
    tenantId,
    workspaceId: workspace.workspaceId,
    claimed: changes,
    createdWorkspace: workspace.created,
  };
}

/** Lazy claim used by `/app`; returns the buyer's licensed workspace without creating a tenant. */
export async function claimForUser(
  db: Db,
  config: WarriorPlusConfig,
  user: { id: string; email: string },
): Promise<{ tenantId: string; workspaceId: string } | null> {
  const result = await attachPurchases(db, config, user.email);
  if (!result) return null;
  return { tenantId: result.tenantId, workspaceId: result.workspaceId };
}
