import { type AccountJobRow, EMPTY_PRODUCT_METRICS, type ProductMetrics, platformConfig } from "./config";
import { ensureWallet, ledgerStatement, releaseCredits } from "./credits";
import type { Db, Statement } from "./db";
import { id, nowIso } from "./db";
import { HttpError } from "./http";
import type { AuthUser, PlatformEnv } from "./types";

export type AdminRole = "admin" | "support";
export interface AdminActor {
  userId: string;
  email: string;
  role: AdminRole;
}

interface AdminRoleRow {
  user_id: string;
  role: AdminRole;
}

/**
 * Roles are explicit rows. `ADMIN_EMAILS` is a bootstrap only: the first time a
 * listed account opens the console it receives an admin row, which is then audited
 * like any other role change.
 */
export async function resolveAdmin(
  db: Db,
  user: Pick<AuthUser, "id" | "email">,
  env: PlatformEnv,
): Promise<AdminActor | null> {
  const row = await db.first<AdminRoleRow>("SELECT user_id, role FROM admin_roles WHERE user_id = ?", [user.id]);
  if (row) return { userId: user.id, email: user.email, role: row.role };
  const bootstrap = (env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((value: string) => value.trim().toLowerCase())
    .filter(Boolean);
  if (!bootstrap.includes(user.email.toLowerCase())) return null;
  const createdAt = nowIso();
  await db.run(
    "INSERT OR IGNORE INTO admin_roles (user_id, role, created_by, created_at) VALUES (?, 'admin', 'bootstrap', ?)",
    [user.id, createdAt],
  );
  await auditAdmin(
    db,
    { userId: user.id, role: "admin" },
    "admin.role.bootstrap",
    "admin_role",
    user.id,
    "bootstrap allowlist",
  );
  return { userId: user.id, email: user.email, role: "admin" };
}

export async function requireAdmin(
  db: Db,
  user: AuthUser | undefined,
  env: PlatformEnv,
  minimum: AdminRole = "support",
): Promise<AdminActor> {
  if (!user) throw new HttpError("unauthenticated", 401);
  const actor = await resolveAdmin(db, user, env);
  if (!actor) throw new HttpError("forbidden", 403, "Admin access is required.");
  if (minimum === "admin" && actor.role !== "admin") {
    throw new HttpError("forbidden", 403, "This action requires the admin role.", { role: actor.role });
  }
  return actor;
}

export async function auditAdmin(
  db: Db,
  actor: Pick<AdminActor, "userId" | "role">,
  action: string,
  resourceType: string,
  resourceId: string | null,
  reason: string | null,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await db.run(
    `INSERT INTO admin_audit
      (id, actor_user_id, actor_role, action, resource_type, resource_id, reason, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id("aud"),
      actor.userId,
      actor.role,
      action,
      resourceType,
      resourceId,
      reason,
      JSON.stringify(metadata).slice(0, 2000),
      nowIso(),
    ],
  );
}

export interface AdminSettings {
  freeMonthlyCredits: number;
  guestDailyCredits: number;
  testDailyCap: number;
  pauseAdmission: boolean;
  pausePreview: boolean;
  pauseCheckout: boolean;
  pauseWebhooks: boolean;
  adsEnabled: boolean;
  incidentActive: boolean;
  incidentBannerEn: string;
  incidentBannerVi: string;
}

const DEFAULTS: AdminSettings = {
  freeMonthlyCredits: 50,
  guestDailyCredits: 3,
  testDailyCap: 50,
  pauseAdmission: false,
  pausePreview: false,
  pauseCheckout: true,
  pauseWebhooks: false,
  adsEnabled: true,
  incidentActive: false,
  incidentBannerEn: "",
  incidentBannerVi: "",
};

function parseValue(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function numberValue(value: unknown, fallback: number): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export async function getAdminSettings(db: Db): Promise<AdminSettings> {
  const rows = await db.all<{ key: string; value_json: string }>("SELECT key, value_json FROM admin_settings");
  const map = new Map(rows.map((row) => [row.key, parseValue(row.value_json)]));
  return {
    freeMonthlyCredits: numberValue(map.get("free_monthly_credits"), DEFAULTS.freeMonthlyCredits),
    guestDailyCredits: numberValue(map.get("guest_daily_credits"), DEFAULTS.guestDailyCredits),
    testDailyCap: numberValue(map.get("test_daily_cap"), DEFAULTS.testDailyCap),
    pauseAdmission: Boolean(map.get("pause.admission") ?? DEFAULTS.pauseAdmission),
    pausePreview: Boolean(map.get("pause.preview") ?? DEFAULTS.pausePreview),
    pauseCheckout: Boolean(map.get("pause.checkout") ?? DEFAULTS.pauseCheckout),
    pauseWebhooks: Boolean(map.get("pause.webhooks") ?? DEFAULTS.pauseWebhooks),
    adsEnabled: Boolean(map.get("ads.enabled") ?? DEFAULTS.adsEnabled),
    incidentActive: Boolean(map.get("incident.active") ?? DEFAULTS.incidentActive),
    incidentBannerEn: String(map.get("incident.banner_en") ?? DEFAULTS.incidentBannerEn),
    incidentBannerVi: String(map.get("incident.banner_vi") ?? DEFAULTS.incidentBannerVi),
  };
}

const BASE_SETTING_KEYS = [
  "free_monthly_credits",
  "guest_daily_credits",
  "test_daily_cap",
  "pause.admission",
  "pause.preview",
  "pause.checkout",
  "pause.webhooks",
  "ads.enabled",
  "incident.active",
  "incident.banner_en",
  "incident.banner_vi",
];

/** Reads one setting without knowing the key list; products use it for their own keys. */
export async function getAdminSettingValue<T = unknown>(db: Db, key: string): Promise<T | null> {
  const row = await db.first<{ value_json: string }>("SELECT value_json FROM admin_settings WHERE key = ?", [key]);
  return row ? (parseValue(row.value_json) as T) : null;
}

export async function setAdminSetting(
  db: Db,
  actor: AdminActor,
  key: string,
  value: unknown,
  reason: string,
): Promise<void> {
  const extras = new Map((platformConfig().admin?.extraSettings ?? []).map((spec) => [spec.key, spec]));
  const allowed = new Set([...BASE_SETTING_KEYS, ...extras.keys()]);
  if (!allowed.has(key)) throw new HttpError("invalid_input", 400, "Unknown admin setting.");
  const extra = extras.get(key);
  const numericKeys = new Set(["free_monthly_credits", "guest_daily_credits", "test_daily_cap"]);
  if (extra?.kind === "number" || numericKeys.has(key)) {
    const number = Number(value);
    const max = extra?.max ?? 1_000_000;
    if (!Number.isInteger(number) || number < 0 || number > max) {
      throw new HttpError("invalid_input", 400, `Quota must be an integer between 0 and ${max}.`);
    }
    value = number;
  } else if (
    extra?.kind === "boolean" ||
    key.startsWith("pause.") ||
    key === "ads.enabled" ||
    key === "incident.active"
  ) {
    if (typeof value !== "boolean") throw new HttpError("invalid_input", 400, "This setting must be a boolean.");
  } else if (extra?.kind === "string" || key.startsWith("incident.banner_")) {
    if (typeof value !== "string" || value.length > (extra?.maxLength ?? 240)) {
      throw new HttpError("invalid_input", 400, "Banner text must be at most 240 characters.");
    }
    value = value.trim();
  } else if (extra?.kind === "json" && value === undefined) {
    throw new HttpError("invalid_input", 400, "This setting needs a value.");
  }
  await db.batch([
    {
      sql: `INSERT INTO admin_settings (key, value_json, updated_by, updated_at) VALUES (?, ?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
      params: [key, JSON.stringify(value), actor.userId, nowIso()],
    },
  ]);
  await auditAdmin(db, actor, "admin.setting.updated", "admin_setting", key, reason, { value });
}

/** Tenant override wins over the global value until it expires. */
export async function effectiveQuota(db: Db, tenantId: string, key: string): Promise<number | null> {
  const now = nowIso();
  const row = await db.first<{ value_json: string }>(
    "SELECT value_json FROM admin_overrides WHERE tenant_id = ? AND key = ? AND (expires_at IS NULL OR expires_at > ?)",
    [tenantId, key, now],
  );
  if (row) return numberValue(parseValue(row.value_json), 0);
  return null;
}

export async function setTenantOverride(
  db: Db,
  actor: AdminActor,
  tenantId: string,
  key: string,
  value: number | null,
  expiresAt: string | null,
  reason: string,
): Promise<void> {
  if (!["test_daily_cap", "free_monthly_credits", "jobs_per_minute"].includes(key)) {
    throw new HttpError("invalid_input", 400, "Unknown tenant override.");
  }
  if (value === null) {
    await db.run("DELETE FROM admin_overrides WHERE tenant_id = ? AND key = ?", [tenantId, key]);
  } else {
    if (!Number.isInteger(value) || value < 0 || value > 1_000_000) {
      throw new HttpError("invalid_input", 400, "Override must be a non-negative integer.");
    }
    await db.run(
      `INSERT INTO admin_overrides (tenant_id, key, value_json, expires_at, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, key) DO UPDATE SET value_json=excluded.value_json, expires_at=excluded.expires_at, created_by=excluded.created_by, created_at=excluded.created_at`,
      [tenantId, key, JSON.stringify(value), expiresAt, actor.userId, nowIso()],
    );
  }
  await auditAdmin(db, actor, "admin.override.updated", "tenant", tenantId, reason, { key, value, expiresAt });
}

export interface AccountSearchResult {
  tenantId: string;
  email: string;
  displayName: string;
  uiLanguage: string;
  createdAt: string;
  suspendedAt: string | null;
  suspensionReason: string | null;
  wallet: { free: number; purchased: number; reserved: number; available: number };
  keys: Array<{ id: string; name: string; prefix: string; scopes: string[]; revokedAt: string | null }>;
  /** Product rows from `admin.loadAccountJobs`; empty when the product has no jobs. */
  jobs: AccountJobRow[];
  recentAudit: Array<{ id: string; action: string; reason: string | null; createdAt: string }>;
}

/** Account lookup never selects product payloads, object keys or file bytes. */
export async function searchAccounts(
  db: Db,
  actor: AdminActor,
  query: string,
  loadJobs: ((db: Db, tenantId: string) => Promise<AccountJobRow[]>) | undefined = platformConfig().admin
    ?.loadAccountJobs,
): Promise<AccountSearchResult[]> {
  const term = query.trim();
  if (term.length < 3 || term.length > 200) throw new HttpError("invalid_input", 400, "Search with 3–200 characters.");
  const rows = await db.all<{
    tenant_id: string;
    email: string;
    display_name: string;
    ui_language: string;
    created_at: string;
    suspended_at: string | null;
    suspension_reason: string | null;
  }>(
    `SELECT m.tenant_id, u.email, p.display_name, p.ui_language, m.created_at, t.suspended_at, t.suspension_reason
     FROM memberships m
     JOIN "user" u ON u.id = m.user_id
     JOIN profiles p ON p.user_id = m.user_id
     JOIN tenants t ON t.id = m.tenant_id
     WHERE lower(u.email) = lower(?) OR m.tenant_id = ?
     ORDER BY m.created_at DESC LIMIT 10`,
    [term, term],
  );
  const results: AccountSearchResult[] = [];
  for (const row of rows) {
    const wallet = await ensureWallet(db, row.tenant_id);
    const keys = await db.all<{ id: string; name: string; prefix: string; scopes: string; revoked_at: string | null }>(
      "SELECT id, name, prefix, scopes, revoked_at FROM api_keys WHERE tenant_id = ? ORDER BY created_at DESC",
      [row.tenant_id],
    );
    const jobs = loadJobs ? await loadJobs(db, row.tenant_id) : [];
    const recentAudit = await db.all<{ id: string; action: string; reason: string | null; created_at: string }>(
      "SELECT id, action, reason, created_at FROM admin_audit WHERE resource_id = ? ORDER BY created_at DESC LIMIT 10",
      [row.tenant_id],
    );
    results.push({
      tenantId: row.tenant_id,
      email: row.email,
      displayName: row.display_name,
      uiLanguage: row.ui_language,
      createdAt: row.created_at,
      suspendedAt: row.suspended_at,
      suspensionReason: row.suspension_reason,
      wallet,
      keys: keys.map((key) => ({
        id: key.id,
        name: key.name,
        prefix: key.prefix,
        scopes: JSON.parse(key.scopes) as string[],
        revokedAt: key.revoked_at,
      })),
      jobs,
      recentAudit: recentAudit.map((entry) => ({
        id: entry.id,
        action: entry.action,
        reason: entry.reason,
        createdAt: entry.created_at,
      })),
    });
  }
  await auditAdmin(db, actor, "admin.account.lookup", "tenant", rows[0]?.tenant_id ?? null, "account lookup", {
    query: term,
    resultCount: results.length,
  });
  return results;
}

export async function adjustCredits(
  db: Db,
  actor: AdminActor,
  input: { tenantId: string; credits: number; reason: string },
): Promise<{ free: number; purchased: number }> {
  if (!input.reason?.trim() || input.reason.trim().length > 500) {
    throw new HttpError("invalid_input", 400, "A reason between 1 and 500 characters is required.");
  }
  if (!Number.isInteger(input.credits) || input.credits === 0) {
    throw new HttpError("invalid_input", 400, "Credits must be a non-zero integer.");
  }
  const cap = actor.role === "support" ? 500 : 100_000;
  if (Math.abs(input.credits) > cap) {
    throw new HttpError("forbidden", 403, `This role can adjust at most ${cap} credits per action.`, { cap });
  }
  const wallet = await ensureWallet(db, input.tenantId);
  let fromFree = 0;
  let fromPurchased = 0;
  if (input.credits > 0) {
    fromPurchased = input.credits;
    await db.run("UPDATE wallets SET purchased_balance = purchased_balance + ?, updated_at = ? WHERE tenant_id = ?", [
      input.credits,
      nowIso(),
      input.tenantId,
    ]);
  } else {
    const needed = -input.credits;
    if (wallet.available < needed) {
      throw new HttpError("insufficient_credits", 402, "The account does not have enough credits to reverse.", {
        available: wallet.available,
      });
    }
    fromFree = Math.min(wallet.free, needed);
    fromPurchased = needed - fromFree;
    await db.run(
      "UPDATE wallets SET free_balance = free_balance - ?, purchased_balance = purchased_balance - ?, updated_at = ? WHERE tenant_id = ?",
      [fromFree, fromPurchased, nowIso(), input.tenantId],
    );
  }
  // One row per affected bucket, so reconciliation can prove balance == ledger sum per source.
  const statements: Statement[] = [];
  if (fromFree !== 0) {
    statements.push(
      ledgerStatement({ tenantId: input.tenantId, credits: -fromFree, source: "free", kind: "adjustment" }),
    );
  }
  if (fromPurchased !== 0) {
    statements.push(
      ledgerStatement({
        tenantId: input.tenantId,
        credits: input.credits > 0 ? fromPurchased : -fromPurchased,
        source: "purchased",
        kind: "adjustment",
      }),
    );
  }
  await db.batch(statements);
  await auditAdmin(db, actor, "admin.credit.adjustment", "tenant", input.tenantId, input.reason.trim(), {
    credits: input.credits,
  });
  const next = await ensureWallet(db, input.tenantId);
  return { free: next.free, purchased: next.purchased };
}

export async function suspendTenant(db: Db, actor: AdminActor, tenantId: string, reason: string): Promise<void> {
  if (!reason.trim()) throw new HttpError("invalid_input", 400, "A suspension reason is required.");
  const timestamp = nowIso();
  const queued = await db.all<{ id: string; reserved_credits: number; livemode: number }>(
    "SELECT id, reserved_credits, livemode FROM jobs WHERE tenant_id = ? AND status = 'queued'",
    [tenantId],
  );
  await db.batch([
    {
      sql: "UPDATE tenants SET suspended_at = ?, suspension_reason = ? WHERE id = ?",
      params: [timestamp, reason.trim().slice(0, 500), tenantId],
    },
    {
      sql: "UPDATE share_links SET revoked_at = ? WHERE tenant_id = ? AND revoked_at IS NULL",
      params: [timestamp, tenantId],
    },
    {
      sql: "UPDATE api_keys SET revoked_at = ? WHERE tenant_id = ? AND revoked_at IS NULL",
      params: [timestamp, tenantId],
    },
    {
      sql: "UPDATE webhook_endpoints SET disabled_at = ?, updated_at = ? WHERE tenant_id = ? AND disabled_at IS NULL",
      params: [timestamp, timestamp, tenantId],
    },
    {
      sql: "UPDATE jobs SET status='cancelled', finished_at=? WHERE tenant_id = ? AND status = 'queued'",
      params: [timestamp, tenantId],
    },
  ]);
  for (const job of queued) {
    if (job.livemode === 1) await releaseCredits(db, tenantId, job.id, job.reserved_credits);
  }
  await auditAdmin(db, actor, "admin.tenant.suspended", "tenant", tenantId, reason.trim(), {
    queuedJobsCancelled: queued.length,
  });
}

export async function unsuspendTenant(db: Db, actor: AdminActor, tenantId: string, reason: string): Promise<void> {
  await db.run("UPDATE tenants SET suspended_at = NULL, suspension_reason = NULL WHERE id = ?", [tenantId]);
  await auditAdmin(db, actor, "admin.tenant.unsuspended", "tenant", tenantId, reason);
}

export async function listAudit(
  db: Db,
  limit = 100,
): Promise<
  Array<{
    id: string;
    actor_user_id: string;
    actor_role: string;
    action: string;
    resource_type: string;
    resource_id: string | null;
    reason: string | null;
    created_at: string;
  }>
> {
  return db.all(
    `SELECT id, actor_user_id, actor_role, action, resource_type, resource_id, reason, created_at
     FROM admin_audit ORDER BY created_at DESC LIMIT ?`,
    [limit],
  );
}

export interface AdminMetrics extends ProductMetrics {
  tenants: number;
  ledgerMismatch: number;
  failedEmails: number;
  openReports: number;
}

/**
 * Shared numbers plus whatever the product's `admin.loadProductMetrics` hook reports.
 * A product without jobs (or without the hook) gets zeros for the job fields.
 */
export async function adminMetrics(
  db: Db,
  loadProductMetrics: ((db: Db) => Promise<ProductMetrics>) | undefined = platformConfig().admin?.loadProductMetrics,
): Promise<AdminMetrics> {
  const [tenants, ledger, failedEmails, openReports] = await Promise.all([
    db.first<{ count: number }>("SELECT COUNT(*) AS count FROM tenants"),
    db.first<{ ledger: number; wallets: number }>(
      `SELECT
       (SELECT COALESCE(SUM(credits), 0) FROM ledger_entries WHERE kind IN ('grant', 'adjustment', 'settle', 'refund', 'chargeback')) AS ledger,
       (SELECT COALESCE(SUM(free_balance + purchased_balance), 0) FROM wallets) AS wallets`,
    ),
    db.first<{ count: number }>("SELECT COUNT(*) AS count FROM email_outbox WHERE status='failed'"),
    db
      .first<{ count: number }>("SELECT COUNT(*) AS count FROM abuse_reports WHERE status='open'")
      .catch(() => ({ count: 0 })),
  ]);
  const product = loadProductMetrics ? await loadProductMetrics(db) : EMPTY_PRODUCT_METRICS;
  return {
    ...EMPTY_PRODUCT_METRICS,
    ...product,
    tenants: tenants?.count ?? 0,
    ledgerMismatch: (ledger?.ledger ?? 0) - (ledger?.wallets ?? 0),
    failedEmails: failedEmails?.count ?? 0,
    openReports: openReports?.count ?? 0,
  };
}

export async function assignRole(
  db: Db,
  actor: AdminActor,
  userEmail: string,
  role: AdminRole,
  reason: string,
): Promise<void> {
  if (actor.role !== "admin") throw new HttpError("forbidden", 403, "Only an admin can change roles.");
  if (!["admin", "support"].includes(role)) throw new HttpError("invalid_input", 400, "Unknown role.");
  const user = await db.first<{ id: string }>('SELECT id FROM "user" WHERE lower(email) = lower(?)', [userEmail]);
  if (!user) throw new HttpError("not_found", 404, "No account with that email.");
  if (role !== "admin") {
    const current = await db.first<{ role: string }>("SELECT role FROM admin_roles WHERE user_id = ?", [user.id]);
    if (current?.role === "admin") {
      const admins = await db.first<{ count: number }>(
        "SELECT COUNT(*) AS count FROM admin_roles WHERE role = 'admin'",
      );
      if ((admins?.count ?? 0) <= 1) {
        throw new HttpError("invalid_input", 409, "At least one admin must remain.");
      }
    }
  }
  await db.run(
    `INSERT INTO admin_roles (user_id, role, created_by, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET role=excluded.role, created_by=excluded.created_by, created_at=excluded.created_at`,
    [user.id, role, actor.userId, nowIso()],
  );
  await auditAdmin(db, actor, "admin.role.updated", "admin_role", user.id, reason, { role, email: userEmail });
}
