import { platformConfig } from "./config";
import type { Db } from "./db";
import { id, nowIso } from "./db";
import { sendTransactionalEmail } from "./emails/send";
import { audit } from "./tenancy";
import type { AuthUser, PlatformEnv, Profile } from "./types";

export interface DeletionRequest {
  id: string;
  status: "requested" | "completed" | "failed";
  requestedAt: string;
  hardDeleteAt: string;
  creditsForfeited: number;
}

interface DeletionRow {
  id: string;
  user_id: string;
  tenant_id: string;
  status: "requested" | "completed" | "failed";
  credits_forfeited: number;
  requested_at: string;
  hard_delete_at: string;
  completed_at: string | null;
  last_error: string | null;
}

function mapDeletion(row: DeletionRow): DeletionRequest {
  return {
    id: row.id,
    status: row.status,
    requestedAt: row.requested_at,
    hardDeleteAt: row.hard_delete_at,
    creditsForfeited: row.credits_forfeited,
  };
}

/**
 * Immediate revocation is the contract. Hard deletion is scheduled for 30 days
 * later and is idempotent; a user may have at most one open request.
 */
export async function requestDeletion(
  env: PlatformEnv,
  db: Db,
  context: { user: AuthUser; tenantId: string; profile: Profile },
): Promise<DeletionRequest> {
  const existing = await db.first<DeletionRow>(
    "SELECT * FROM deletion_requests WHERE user_id = ? AND status = 'requested'",
    [context.user.id],
  );
  if (existing) return mapDeletion(existing);

  const timestamp = nowIso();
  const hardDeleteAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const credits = await db.first<{ total: number }>(
    "SELECT COALESCE(SUM(CASE WHEN kind='grant' THEN credits ELSE 0 END), 0) AS total FROM ledger_entries WHERE tenant_id = ?",
    [context.tenantId],
  );
  const deletionId = id("del");

  await db.batch([
    { sql: 'DELETE FROM "session" WHERE userId = ?', params: [context.user.id] },
    {
      sql: "UPDATE api_keys SET revoked_at = ? WHERE tenant_id = ? AND revoked_at IS NULL",
      params: [timestamp, context.tenantId],
    },
    {
      sql: "UPDATE share_links SET revoked_at = ? WHERE tenant_id = ? AND revoked_at IS NULL",
      params: [timestamp, context.tenantId],
    },
    {
      sql: "UPDATE webhook_endpoints SET disabled_at = ? WHERE tenant_id = ? AND disabled_at IS NULL",
      params: [timestamp, context.tenantId],
    },
    {
      sql: `INSERT INTO deletion_requests (id, user_id, tenant_id, status, credits_forfeited, requested_at, hard_delete_at)
            VALUES (?, ?, ?, 'requested', ?, ?, ?)`,
      params: [deletionId, context.user.id, context.tenantId, credits?.total ?? 0, timestamp, hardDeleteAt],
    },
  ]);

  await audit(db, {
    tenantId: context.tenantId,
    actorUserId: context.user.id,
    action: "account.deletion_requested",
    targetType: "user",
    targetId: context.user.id,
    metadata: { hardDeleteAt, creditsForfeited: credits?.total ?? 0 },
  });
  await sendTransactionalEmail(env, db, {
    userId: context.user.id,
    to: context.user.email,
    locale: context.profile.uiLanguage,
    template: "deletion_requested",
    data: { hardDeleteAt },
  });

  return {
    id: deletionId,
    status: "requested",
    requestedAt: timestamp,
    hardDeleteAt,
    creditsForfeited: credits?.total ?? 0,
  };
}

export async function getDeletionRequest(db: Db, userId: string): Promise<DeletionRequest | null> {
  const row = await db.first<DeletionRow>(
    "SELECT * FROM deletion_requests WHERE user_id = ? ORDER BY requested_at DESC LIMIT 1",
    [userId],
  );
  return row ? mapDeletion(row) : null;
}

/**
 * Hard-delete one due request. Templates/assets/jobs/outputs/keys/shares/webhooks and
 * the user are removed; ledger rows stay and are anonymised. The tenant row is kept as
 * a tombstone so financial records retain a tenant key without personal data.
 */
export async function purgeDeletion(
  env: PlatformEnv,
  db: Db,
  store: { delete(key: string): Promise<void> },
  row: DeletionRow,
): Promise<void> {
  const user = await db.first<{ email: string; name: string }>('SELECT email, name FROM "user" WHERE id = ?', [
    row.user_id,
  ]);
  const exports = await db.all<{ artifact_key: string | null }>(
    "SELECT artifact_key FROM export_jobs WHERE tenant_id = ? AND artifact_key IS NOT NULL",
    [row.tenant_id],
  );
  for (const artifact of exports) {
    if (artifact.artifact_key) await store.delete(artifact.artifact_key);
  }

  const completedAt = nowIso();
  // Product rows go first through the configured hook (not atomic with the shared rows by
  // design: the hook may touch several product tables and storage). It must be idempotent,
  // because a failed deletion request is retried.
  await platformConfig().deletion?.purgeProductData?.(db, row.tenant_id);
  await db.batch([
    { sql: "DELETE FROM api_keys WHERE tenant_id = ?", params: [row.tenant_id] },
    { sql: "DELETE FROM webhook_endpoints WHERE tenant_id = ?", params: [row.tenant_id] },
    { sql: "DELETE FROM export_jobs WHERE tenant_id = ?", params: [row.tenant_id] },
    { sql: "DELETE FROM email_outbox WHERE user_id = ?", params: [row.user_id] },
    { sql: 'DELETE FROM "session" WHERE userId = ?', params: [row.user_id] },
    { sql: 'DELETE FROM "account" WHERE userId = ?', params: [row.user_id] },
    {
      sql: "UPDATE ledger_entries SET user_id = NULL, anonymized_at = ? WHERE tenant_id = ?",
      params: [completedAt, row.tenant_id],
    },
    { sql: "DELETE FROM provider_customers WHERE tenant_id = ?", params: [row.tenant_id] },
    // Financial records are retained; the payer identity is removed. `payments.tenant_id` uses
    // ON DELETE RESTRICT and the tenant row is kept as a tombstone, so this never blocks purging.
    { sql: "UPDATE payments SET user_id = NULL WHERE tenant_id = ?", params: [row.tenant_id] },
    { sql: "UPDATE tenants SET name = 'Deleted account' WHERE id = ?", params: [row.tenant_id] },
    {
      sql: "UPDATE deletion_requests SET status='completed', completed_at=? WHERE id=?",
      params: [completedAt, row.id],
    },
  ]);
  await db.run('DELETE FROM "user" WHERE id = ?', [row.user_id]);

  if (user) {
    await sendTransactionalEmail(env, db, {
      to: user.email,
      locale: "en",
      template: "deletion_completed",
      data: {},
    });
    // Delivery record is no longer needed; do not retain the address after deletion.
    await db.run("DELETE FROM email_outbox WHERE to_email = ?", [user.email]);
  }
  await audit(db, {
    tenantId: row.tenant_id,
    actorUserId: null,
    action: "account.deletion_completed",
    targetType: "user",
    targetId: row.user_id,
  });
}

export async function purgeDueDeletions(
  env: PlatformEnv,
  db: Db,
  store: { delete(key: string): Promise<void> },
): Promise<number> {
  const due = await db.all<DeletionRow>(
    "SELECT * FROM deletion_requests WHERE status='requested' AND hard_delete_at <= ? LIMIT 20",
    [nowIso()],
  );
  let count = 0;
  for (const row of due) {
    try {
      await purgeDeletion(env, db, store, row);
      count += 1;
    } catch (error) {
      await db.run("UPDATE deletion_requests SET last_error=? WHERE id=?", [
        error instanceof Error ? error.message.slice(0, 500) : "purge failed",
        row.id,
      ]);
    }
  }
  return count;
}
