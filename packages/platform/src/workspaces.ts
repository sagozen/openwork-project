import { platformConfig } from "./config";
import { ensureWallet, planSettlement, releaseCredits, reserveCredits } from "./credits";
import type { Db } from "./db";
import { id, nowIso } from "./db";
import { HttpError } from "./http";

/**
 * Workspaces: one customer site on an app's shared Worker, served under `/<slug>/`. Requires the
 * opt-in `workspaces` migration module. A workspace belongs to the owner's account tenant, so the
 * wallet, API keys and webhooks stay with the account; branding, members, plan and usage are
 * per workspace.
 */

export interface Workspace {
  id: string;
  app: string;
  slug: string;
  tenantId: string;
  name: string;
  /** The plan in force right now: a paid plan whose period ended reads as `free`. */
  plan: string;
  /** When the paid period ends, or null for `free` and for plans granted without an expiry. */
  planExpiresAt: string | null;
  status: "active" | "locked";
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceMember {
  workspaceId: string;
  userId: string;
  role: string;
}

export interface WorkspaceBranding {
  displayName: string | null;
  logoKey: string | null;
  logoDarkKey: string | null;
  accentColor: string | null;
}

/** What a page renders: the workspace's own branding with the app's brand as the fallback. */
export interface ResolvedBrand {
  displayName: string;
  logoKey: string | null;
  logoDarkKey: string | null;
  accentColor: string | null;
  /** True when the workspace set nothing and the app's global brand is shown. */
  isDefault: boolean;
}

export const SLUG_PATTERN = /^[a-z0-9](-?[a-z0-9]){2,39}$/;
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

/** Path segments and routes a slug must never shadow. Apps add their own via `reservedSlugs`. */
export const RESERVED_SLUGS: readonly string[] = [
  "admin",
  "api",
  "app",
  "assets",
  "auth",
  "billing",
  "blog",
  "brand",
  "dashboard",
  "docs",
  "favicon",
  "health",
  "help",
  "login",
  "logout",
  "onboarding",
  "order",
  "pricing",
  "robots",
  "settings",
  "share",
  "sign-in",
  "sign-up",
  "sitemap",
  "static",
  "status",
  "support",
  "www",
  "_astro",
];

export type SlugProblem = "invalid" | "reserved";

export function slugProblem(slug: string): SlugProblem | null {
  if (!SLUG_PATTERN.test(slug)) return "invalid";
  const reserved = new Set([...RESERVED_SLUGS, ...(platformConfig().reservedSlugs ?? [])]);
  return reserved.has(slug) ? "reserved" : null;
}

interface WorkspaceRow {
  id: string;
  app: string;
  slug: string;
  tenant_id: string;
  name: string;
  plan: string;
  plan_expires_at: string | null;
  status: "active" | "locked";
  created_at: string;
  updated_at: string;
}

function mapWorkspace(row: WorkspaceRow): Workspace {
  const expired = row.plan !== "free" && row.plan_expires_at !== null && row.plan_expires_at <= nowIso();
  return {
    id: row.id,
    app: row.app,
    slug: row.slug,
    tenantId: row.tenant_id,
    name: row.name,
    plan: expired ? "free" : row.plan,
    planExpiresAt: expired ? null : row.plan_expires_at,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateWorkspaceInput {
  app: string;
  slug: string;
  userId: string;
  tenantId: string;
  /** Display name; defaults to the slug. */
  name?: string;
}

/**
 * Creates a workspace on the free plan and makes `userId` its owner. Rejects malformed or
 * reserved slugs, a slug already taken in this app, and a user who already owns the maximum
 * number of free workspaces.
 */
export async function createWorkspace(db: Db, input: CreateWorkspaceInput): Promise<Workspace> {
  const slug = input.slug.trim().toLowerCase();
  const problem = slugProblem(slug);
  if (problem === "invalid") {
    throw new HttpError(
      "invalid_input",
      400,
      "Use 3-40 lowercase letters, digits or single dashes, starting and ending with a letter or digit.",
      { field: "slug" },
    );
  }
  if (problem === "reserved") {
    throw new HttpError("invalid_input", 400, "That address is reserved. Choose another.", { field: "slug" });
  }

  const name = (input.name?.trim() || slug).slice(0, 80);

  const limit = platformConfig().maxFreeWorkspacesPerUser ?? 3;
  const owned = await db.first<{ count: number }>(
    `SELECT COUNT(*) AS count FROM workspaces w
       JOIN workspace_members m ON m.workspace_id = w.id
      WHERE m.user_id = ? AND m.role = 'owner' AND w.app = ? AND w.plan = 'free'`,
    [input.userId, input.app],
  );
  if ((owned?.count ?? 0) >= limit) {
    throw new HttpError("quota_exceeded", 402, `You can own up to ${limit} free workspaces.`, {
      limit,
      key: "workspaces.free",
    });
  }

  const workspaceId = id("ws");
  const timestamp = nowIso();
  try {
    await db.batch([
      {
        sql: `INSERT INTO workspaces (id, app, slug, tenant_id, name, plan, status, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, 'free', 'active', ?, ?)`,
        params: [workspaceId, input.app, slug, input.tenantId, name, timestamp, timestamp],
      },
      {
        sql: "INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)",
        params: [workspaceId, input.userId, timestamp],
      },
      {
        sql: "INSERT INTO workspace_branding (workspace_id, display_name, updated_at) VALUES (?, ?, ?)",
        params: [workspaceId, name, timestamp],
      },
    ]);
  } catch (error) {
    if (error instanceof Error && /UNIQUE/i.test(error.message)) {
      throw new HttpError("revision_conflict", 409, "That address is already taken.", { field: "slug" });
    }
    throw error;
  }
  return {
    id: workspaceId,
    app: input.app,
    slug,
    tenantId: input.tenantId,
    name,
    plan: "free",
    planExpiresAt: null,
    status: "active",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

/** The slice of Workers KV the resolver needs, so tests can pass a Map-backed fake. */
export interface SlugCache {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

const CACHE_TTL_SECONDS = 60;
const cacheKey = (app: string, slug: string) => `ws:${app}:${slug}`;

/** Looks a workspace up by app and slug. A short KV cache keeps the per-request hop cheap. */
export async function resolveWorkspace(
  db: Db,
  app: string,
  slug: string,
  cache?: SlugCache,
): Promise<Workspace | null> {
  if (!SLUG_PATTERN.test(slug)) return null;
  const key = cacheKey(app, slug);
  const cached = cache ? await cache.get(key).catch(() => null) : null;
  if (cached) {
    try {
      return JSON.parse(cached) as Workspace;
    } catch {
      // A corrupt entry is just a miss.
    }
  }
  const row = await db.first<WorkspaceRow>("SELECT * FROM workspaces WHERE app = ? AND slug = ?", [app, slug]);
  if (!row) return null;
  const workspace = mapWorkspace(row);
  if (cache)
    await cache.put(key, JSON.stringify(workspace), { expirationTtl: CACHE_TTL_SECONDS }).catch(() => undefined);
  return workspace;
}

/** Drop the cached copy after the plan, status or name changed. */
export async function invalidateWorkspace(cache: SlugCache | undefined, workspace: Workspace): Promise<void> {
  if (cache) await cache.delete(cacheKey(workspace.app, workspace.slug)).catch(() => undefined);
}

export async function getWorkspaceById(db: Db, workspaceId: string): Promise<Workspace | null> {
  const row = await db.first<WorkspaceRow>("SELECT * FROM workspaces WHERE id = ?", [workspaceId]);
  return row ? mapWorkspace(row) : null;
}

export async function listWorkspacesForUser(
  db: Db,
  app: string,
  userId: string,
): Promise<Array<Workspace & { role: string }>> {
  const rows = await db.all<WorkspaceRow & { role: string }>(
    `SELECT w.*, m.role AS role FROM workspaces w
       JOIN workspace_members m ON m.workspace_id = w.id
      WHERE m.user_id = ? AND w.app = ? ORDER BY w.created_at`,
    [userId, app],
  );
  return rows.map((row) => ({ ...mapWorkspace(row), role: row.role }));
}

export async function getMember(db: Db, workspaceId: string, userId: string): Promise<WorkspaceMember | null> {
  const row = await db.first<{ workspace_id: string; user_id: string; role: string }>(
    "SELECT workspace_id, user_id, role FROM workspace_members WHERE workspace_id = ? AND user_id = ?",
    [workspaceId, userId],
  );
  return row ? { workspaceId: row.workspace_id, userId: row.user_id, role: row.role } : null;
}

/**
 * Throws 403 unless `userId` is a member of the workspace with one of `roles`. The owner always
 * passes. An empty or omitted `roles` accepts any member. A locked workspace admits nobody.
 */
export async function requireMember(
  db: Db,
  workspace: Workspace,
  userId: string,
  roles: readonly string[] = [],
): Promise<WorkspaceMember> {
  if (workspace.status === "locked") throw new HttpError("forbidden", 403, "This workspace is locked.");
  const member = await getMember(db, workspace.id, userId);
  if (!member) throw new HttpError("forbidden", 403, "You are not a member of this workspace.");
  if (roles.length > 0 && member.role !== "owner" && !roles.includes(member.role)) {
    throw new HttpError("forbidden", 403, "Your role cannot do this.", { role: member.role });
  }
  return member;
}

export async function addMember(db: Db, workspaceId: string, userId: string, role: string): Promise<void> {
  if (!/^[a-z][a-z-]{1,23}$/.test(role) || role === "owner") {
    throw new HttpError("invalid_input", 400, "Unknown role.", { field: "role" });
  }
  await db.run(
    `INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = excluded.role
       WHERE workspace_members.role <> 'owner'`,
    [workspaceId, userId, role, nowIso()],
  );
}

export async function removeMember(db: Db, workspaceId: string, userId: string): Promise<void> {
  await db.run("DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND role <> 'owner'", [
    workspaceId,
    userId,
  ]);
}

// --- Branding ---------------------------------------------------------------------------

export async function getBranding(db: Db, workspaceId: string): Promise<WorkspaceBranding> {
  const row = await db.first<{
    display_name: string | null;
    logo_key: string | null;
    logo_dark_key: string | null;
    accent_color: string | null;
  }>("SELECT display_name, logo_key, logo_dark_key, accent_color FROM workspace_branding WHERE workspace_id = ?", [
    workspaceId,
  ]);
  return {
    displayName: row?.display_name ?? null,
    logoKey: row?.logo_key ?? null,
    logoDarkKey: row?.logo_dark_key ?? null,
    accentColor: row?.accent_color ?? null,
  };
}

export interface BrandingPatch {
  displayName?: string | null;
  logoKey?: string | null;
  logoDarkKey?: string | null;
  accentColor?: string | null;
}

/** Applies only the provided fields. Colour must be `#rrggbb`; the name is 1-80 characters. */
export async function updateBranding(db: Db, workspaceId: string, patch: BrandingPatch): Promise<WorkspaceBranding> {
  if (patch.displayName !== undefined && patch.displayName !== null) {
    const trimmed = patch.displayName.trim();
    if (trimmed.length < 1 || trimmed.length > 80) {
      throw new HttpError("invalid_input", 400, "Use between 1 and 80 characters.", { field: "displayName" });
    }
    patch.displayName = trimmed;
  }
  if (patch.accentColor !== undefined && patch.accentColor !== null && !COLOR_PATTERN.test(patch.accentColor)) {
    throw new HttpError("invalid_input", 400, "Use a #rrggbb colour.", { field: "accentColor" });
  }
  const current = await getBranding(db, workspaceId);
  const next = {
    displayName: patch.displayName === undefined ? current.displayName : patch.displayName,
    logoKey: patch.logoKey === undefined ? current.logoKey : patch.logoKey,
    logoDarkKey: patch.logoDarkKey === undefined ? current.logoDarkKey : patch.logoDarkKey,
    accentColor: patch.accentColor === undefined ? current.accentColor : patch.accentColor,
  };
  await db.run(
    `INSERT INTO workspace_branding (workspace_id, display_name, logo_key, logo_dark_key, accent_color, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (workspace_id) DO UPDATE SET display_name = excluded.display_name, logo_key = excluded.logo_key,
       logo_dark_key = excluded.logo_dark_key, accent_color = excluded.accent_color, updated_at = excluded.updated_at`,
    [workspaceId, next.displayName, next.logoKey, next.logoDarkKey, next.accentColor, nowIso()],
  );
  return next;
}

/**
 * The brand a request renders with. The workspace's own settings win; anything it left empty
 * falls back to the app's global `BrandConfig`, so a fresh workspace looks like the product.
 */
export async function resolveBrand(db: Db, workspace: Pick<Workspace, "id" | "name">): Promise<ResolvedBrand> {
  const branding = await getBranding(db, workspace.id);
  const fallbackName = platformConfig().brand.name;
  const displayName = branding.displayName?.trim() || fallbackName;
  return {
    displayName,
    logoKey: branding.logoKey,
    logoDarkKey: branding.logoDarkKey,
    accentColor: branding.accentColor,
    isDefault: !branding.displayName && !branding.logoKey && !branding.accentColor,
  };
}

// --- Plans and entitlements ---------------------------------------------------------------

export const UNLIMITED = -1;

/**
 * Effective limit for `key`: a per-workspace override first, then the plan's definition.
 * Returns `UNLIMITED` (-1), a non-negative number, or 0 when the plan does not grant the key.
 * Boolean features count as 1 (granted) or 0.
 */
export async function entitlementLimit(
  db: Db,
  workspace: Pick<Workspace, "id" | "plan">,
  key: string,
): Promise<number> {
  const override = await db.first<{ limit_value: number }>(
    "SELECT limit_value FROM workspace_entitlements WHERE workspace_id = ? AND key = ? AND source = 'override'",
    [workspace.id, key],
  );
  if (override) return override.limit_value;
  const value = platformConfig().plans?.[workspace.plan]?.entitlements[key];
  if (value === undefined || value === false) return 0;
  if (value === true) return 1;
  return value;
}

export interface EntitlementResult {
  allowed: boolean;
  limit: number;
  used: number;
}

export function currentPeriod(date = new Date()): string {
  return date.toISOString().slice(0, 7);
}

async function usedIn(db: Db, workspaceId: string, key: string, period: string): Promise<number> {
  const row = await db.first<{ used: number }>(
    "SELECT used FROM workspace_usage WHERE workspace_id = ? AND key = ? AND period = ?",
    [workspaceId, key, period],
  );
  return row?.used ?? 0;
}

export interface CheckOptions {
  /** Units about to be added. Defaults to 1. */
  need?: number;
  /**
   * Current count for stock limits the app derives from its own tables (branches, tables, apps).
   * When set, the check compares `current + need` to the limit instead of reading usage.
   */
  current?: number;
  /** Usage bucket, `"total"` or a month like `"2026-10"`. Defaults to the current month. */
  period?: string;
}

/** Read-only check: would adding `need` units stay within the limit? */
export async function checkEntitlement(
  db: Db,
  workspace: Pick<Workspace, "id" | "plan">,
  key: string,
  options: CheckOptions = {},
): Promise<EntitlementResult> {
  const need = options.need ?? 1;
  const limit = await entitlementLimit(db, workspace, key);
  const used =
    options.current !== undefined
      ? options.current
      : await usedIn(db, workspace.id, key, options.period ?? currentPeriod());
  return { allowed: limit === UNLIMITED || used + need <= limit, limit, used };
}

/** Like `checkEntitlement` but throws the app-facing 402 so a route can just call it. */
export async function requireEntitlement(
  db: Db,
  workspace: Pick<Workspace, "id" | "plan">,
  key: string,
  options: CheckOptions = {},
): Promise<EntitlementResult> {
  const result = await checkEntitlement(db, workspace, key, options);
  if (!result.allowed) {
    throw new HttpError("quota_exceeded", 402, "Your plan limit is reached. Upgrade to continue.", {
      key,
      limit: result.limit,
      used: result.used,
      upgrade: true,
    });
  }
  return result;
}

/**
 * Atomically adds `n` to the usage counter if the result stays within the limit. A single
 * conditional upsert, so two concurrent requests cannot both squeeze under the cap.
 */
export async function consume(
  db: Db,
  workspace: Pick<Workspace, "id" | "plan">,
  key: string,
  n = 1,
  period = currentPeriod(),
): Promise<EntitlementResult> {
  const limit = await entitlementLimit(db, workspace, key);
  if (limit === UNLIMITED) {
    await db.run(
      `INSERT INTO workspace_usage (workspace_id, key, period, used) VALUES (?, ?, ?, ?)
       ON CONFLICT (workspace_id, key, period) DO UPDATE SET used = used + excluded.used`,
      [workspace.id, key, period, n],
    );
    return { allowed: true, limit, used: await usedIn(db, workspace.id, key, period) };
  }
  const { changes } = await db.run(
    `INSERT INTO workspace_usage (workspace_id, key, period, used)
     SELECT ?, ?, ?, ? WHERE ? <= ?
     ON CONFLICT (workspace_id, key, period) DO UPDATE SET used = used + excluded.used
       WHERE used + excluded.used <= ?`,
    [workspace.id, key, period, n, n, limit, limit],
  );
  const used = await usedIn(db, workspace.id, key, period);
  if (changes === 0) {
    throw new HttpError("quota_exceeded", 402, "Your plan limit is reached. Upgrade to continue.", {
      key,
      limit,
      used,
      upgrade: true,
    });
  }
  return { allowed: true, limit, used };
}

/** Gives units back, for example when the action that consumed them failed afterwards. */
export async function refund(
  db: Db,
  workspace: Pick<Workspace, "id">,
  key: string,
  n = 1,
  period = currentPeriod(),
): Promise<void> {
  await db.run("UPDATE workspace_usage SET used = MAX(0, used - ?) WHERE workspace_id = ? AND key = ? AND period = ?", [
    n,
    workspace.id,
    key,
    period,
  ]);
}

/**
 * Moves a workspace to another plan. Downgrades never delete data: the new limits only block
 * creating more, which is how the apps apply them.
 */
export async function setWorkspacePlan(
  db: Db,
  workspace: Workspace,
  plan: string,
  cache?: SlugCache,
): Promise<Workspace> {
  const plans = platformConfig().plans ?? {};
  if (!plans[plan]) throw new HttpError("invalid_input", 400, "Unknown plan.", { field: "plan" });
  await db.run("UPDATE workspaces SET plan = ?, plan_expires_at = NULL, updated_at = ? WHERE id = ?", [
    plan,
    nowIso(),
    workspace.id,
  ]);
  await invalidateWorkspace(cache, workspace);
  return { ...workspace, plan, planExpiresAt: null };
}

export async function setWorkspaceStatus(
  db: Db,
  workspace: Workspace,
  status: "active" | "locked",
  cache?: SlugCache,
): Promise<Workspace> {
  await db.run("UPDATE workspaces SET status = ?, updated_at = ? WHERE id = ?", [status, nowIso(), workspace.id]);
  await invalidateWorkspace(cache, workspace);
  return { ...workspace, status };
}

// --- Buying a plan with credits ------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

export interface PlanPurchase {
  workspace: Workspace;
  charged: number;
}

/**
 * Upgrades (or renews) a workspace to a paid plan by spending credits from the owner's wallet.
 * The plan runs `periodDays` from now, or from the current expiry when renewing the same plan
 * early. The charge and the plan change commit in one batch, and the ledger job id includes the
 * new expiry so a retried request cannot charge twice for the same period.
 */
export async function purchasePlan(
  db: Db,
  workspace: Workspace,
  planId: string,
  cache?: SlugCache,
): Promise<PlanPurchase> {
  const plan = platformConfig().plans?.[planId];
  if (!plan || planId === "free" || !plan.priceCredits || plan.priceCredits < 1) {
    throw new HttpError("invalid_input", 400, "That plan is not for sale.", { field: "plan" });
  }
  const price = plan.priceCredits;
  const periodMs = (plan.periodDays ?? 30) * DAY_MS;
  const now = Date.now();
  const base = workspace.plan === planId && workspace.planExpiresAt ? Date.parse(workspace.planExpiresAt) : now;
  const expiresAt = new Date(Math.max(base, now) + periodMs).toISOString();
  const jobId = `plan:${workspace.id}:${expiresAt}`;

  const already = await db.first<{ id: string }>("SELECT id FROM ledger_entries WHERE job_id = ? LIMIT 1", [jobId]);
  if (already) return { workspace: { ...workspace, plan: planId, planExpiresAt: expiresAt }, charged: 0 };

  await reserveCredits(db, workspace.tenantId, price, jobId);
  try {
    const wallet = await ensureWallet(db, workspace.tenantId);
    const settlement = planSettlement(wallet, workspace.tenantId, jobId, price, price);
    await db.batch([
      ...settlement.statements,
      {
        sql: "UPDATE workspaces SET plan = ?, plan_expires_at = ?, updated_at = ? WHERE id = ?",
        params: [planId, expiresAt, nowIso(), workspace.id],
      },
    ]);
  } catch (error) {
    await releaseCredits(db, workspace.tenantId, jobId, price);
    throw error;
  }
  await invalidateWorkspace(cache, workspace);
  return { workspace: { ...workspace, plan: planId, planExpiresAt: expiresAt }, charged: price };
}

/** Daily job: persist the downgrade of every paid plan whose period ended. Returns how many. */
export async function expireWorkspacePlans(db: Db, now = new Date()): Promise<number> {
  const { changes } = await db.run(
    `UPDATE workspaces SET plan = 'free', plan_expires_at = NULL, updated_at = ?
      WHERE plan <> 'free' AND plan_expires_at IS NOT NULL AND plan_expires_at <= ?`,
    [nowIso(), now.toISOString()],
  );
  return changes;
}
