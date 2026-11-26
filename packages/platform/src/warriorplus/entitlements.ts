import { platformConfig, type WarriorPlusConfig, type WarriorPlusProduct } from "../config";
import type { Db, Statement } from "../db";
import { nowIso } from "../db";

export function warriorPlusConfig(explicit?: WarriorPlusConfig): WarriorPlusConfig {
  const config = explicit ?? platformConfig().warriorplus;
  if (!config) throw new Error("The warriorplus module is not configured for this app");
  return config;
}

export interface ResolvedProduct {
  itemNumber: string;
  product: WarriorPlusProduct;
}

/** Find a product by its IPN item number, then by product code (useful for fixtures and comps). */
export function resolveProduct(config: WarriorPlusConfig, itemNumber: string): ResolvedProduct | null {
  const direct = config.products[itemNumber];
  if (direct) return { itemNumber, product: direct };
  for (const [key, product] of Object.entries(config.products)) {
    if (product.code === itemNumber || product.restId === itemNumber) return { itemNumber: key, product };
  }
  return null;
}

export function entitlementKeys(config: WarriorPlusConfig): string[] {
  const keys = new Set<string>();
  for (const values of Object.values(config.entitlements)) {
    for (const key of Object.keys(values)) keys.add(key);
  }
  return [...keys];
}

interface Grant {
  code: string;
  value: number;
}

function grantsForKey(config: WarriorPlusConfig, key: string): Grant[] {
  const grants: Grant[] = [];
  for (const [code, values] of Object.entries(config.entitlements)) {
    const value = values[key];
    if (value === undefined) continue;
    grants.push({ code, value: value === true ? 1 : value === false ? 0 : value });
  }
  return grants;
}

const ELIGIBLE = `(
  (p.kind <> 'comp' AND (p.status = 'active' OR (p.status = 'cancelled' AND p.current_period_end IS NOT NULL AND p.current_period_end > ?)))
  OR (p.kind = 'comp' AND p.status = 'active' AND p.expires_at IS NOT NULL AND p.expires_at > ?)
)`;

/**
 * Recompute the licensed workspace's entitlement rows from active purchases. Every product key
 * gets an explicit row (0 when not granted), so deleting an override can never fall back to a
 * plan. The read and the write run in one atomic D1 batch; the values are derived in SQL from
 * the current purchase rows, so a stale snapshot cannot overwrite a newer one.
 */
export async function materializeEntitlements(
  db: Db,
  config: WarriorPlusConfig,
  tenantId: string,
): Promise<{ workspaceId: string | null; version: number }> {
  const workspace = await db.first<{ id: string }>(
    "SELECT id FROM workspaces WHERE app = ? AND tenant_id = ? AND licensed = 1 ORDER BY created_at LIMIT 1",
    [config.app, tenantId],
  );
  if (!workspace) return { workspaceId: null, version: 0 };
  const workspaceId = workspace.id;
  const now = nowIso();
  const keys = entitlementKeys(config);
  const gateCode = Object.hasOwn(config.entitlements, "fe") ? "fe" : null;

  const statements: Statement[] = [
    {
      sql: `INSERT INTO wp_entitlement_state (app, tenant_id, version) VALUES (?, ?, 1)
            ON CONFLICT (app, tenant_id) DO UPDATE SET version = version + 1`,
      params: [config.app, tenantId],
    },
    {
      sql: `DELETE FROM workspace_entitlements WHERE workspace_id = ? AND key IN (${keys.map(() => "?").join(",")})`,
      params: [workspaceId, ...keys],
    },
  ];

  for (const key of keys) {
    const grants = grantsForKey(config, key);
    const caseSql = grants.map(() => "WHEN p.product_code = ? THEN ?").join(" ");
    const caseParams = grants.flatMap((grant) => [grant.code, grant.value]);
    const gateSql = gateCode
      ? `AND (p.product_code = ? OR EXISTS (
           SELECT 1 FROM wp_purchases gate
           WHERE gate.app = p.app AND gate.tenant_id = p.tenant_id AND gate.product_code = ?
             AND (gate.kind <> 'comp' AND (gate.status = 'active' OR (gate.status = 'cancelled' AND gate.current_period_end IS NOT NULL AND gate.current_period_end > ?))
                  OR (gate.kind = 'comp' AND gate.status = 'active' AND gate.expires_at IS NOT NULL AND gate.expires_at > ?))
         ))`
      : "";
    const gateParams = gateCode ? [gateCode, gateCode, now, now] : [];
    statements.push({
      sql: `INSERT INTO workspace_entitlements (workspace_id, key, limit_value, source)
            SELECT ?, ?,
              CASE WHEN SUM(CASE WHEN granted = -1 THEN 1 ELSE 0 END) > 0 THEN -1
                   ELSE COALESCE(MAX(granted), 0) END,
              'override'
            FROM (
              SELECT CASE ${caseSql} ELSE NULL END AS granted
              FROM wp_purchases p
              WHERE p.app = ? AND p.tenant_id = ? AND ${ELIGIBLE} ${gateSql}
            ) merged`,
      params: [workspaceId, key, ...caseParams, config.app, tenantId, now, now, ...gateParams],
    });
  }

  await db.batch(statements);
  const state = await db.first<{ version: number }>(
    "SELECT version FROM wp_entitlement_state WHERE app = ? AND tenant_id = ?",
    [config.app, tenantId],
  );
  return { workspaceId, version: state?.version ?? 0 };
}

/** Read one effective value, for tests and admin screens. */
export async function entitlementValue(db: Db, workspaceId: string, key: string): Promise<number> {
  const row = await db.first<{ limit_value: number }>(
    "SELECT limit_value FROM workspace_entitlements WHERE workspace_id = ? AND key = ?",
    [workspaceId, key],
  );
  return row?.limit_value ?? 0;
}
