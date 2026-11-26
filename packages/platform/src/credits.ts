import { platformConfig } from "./config";
import type { Db, Statement } from "./db";
import { id, nowIso } from "./db";
import { HttpError } from "./http";

export const FREE_MONTHLY_CREDITS = 50;

function nextReset(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0)).toISOString();
}

export interface Wallet {
  free: number;
  purchased: number;
  reserved: number;
  available: number;
  freeResetAt: string;
}

interface WalletRow {
  free_balance: number;
  purchased_balance: number;
  reserved_credits: number;
  free_reset_at: string;
}

async function configuredFreeCredits(db: Db, tenantId: string): Promise<number> {
  const now = nowIso();
  const override = await db.first<{ value_json: string }>(
    "SELECT value_json FROM admin_overrides WHERE tenant_id = ? AND key = 'free_monthly_credits' AND (expires_at IS NULL OR expires_at > ?)",
    [tenantId, now],
  );
  if (override) {
    const value = Number(JSON.parse(override.value_json));
    if (Number.isFinite(value) && value >= 0) return value;
  }
  const setting = await db.first<{ value_json: string }>(
    "SELECT value_json FROM admin_settings WHERE key = 'free_monthly_credits'",
  );
  if (setting) {
    const value = Number(JSON.parse(setting.value_json));
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return FREE_MONTHLY_CREDITS;
}

export async function ensureWallet(db: Db, tenantId: string): Promise<Wallet> {
  const timestamp = nowIso();
  const monthly = await configuredFreeCredits(db, tenantId);
  const inserted = await db.run(
    `INSERT OR IGNORE INTO wallets (tenant_id, free_balance, purchased_balance, reserved_credits, free_reset_at, updated_at)
     VALUES (?, ?, 0, 0, ?, ?)`,
    [tenantId, monthly, nextReset(), timestamp],
  );
  if (inserted.changes > 0 && monthly > 0) {
    await grantLedger(db, tenantId, monthly, "free", null, "grant");
  }
  const row = await db.first<WalletRow>("SELECT * FROM wallets WHERE tenant_id = ?", [tenantId]);
  if (!row) throw new Error("Wallet was not created");
  if (row.free_reset_at <= timestamp) {
    const reset = nextReset();
    const expired = row.free_balance;
    // Conditional on the reset timestamp we read: a concurrent caller that already reset the
    // month changes 0 rows, so exactly one expiry/grant pair is ever written.
    const updated = await db.run(
      "UPDATE wallets SET free_balance = ?, free_reset_at = ?, updated_at = ? WHERE tenant_id = ? AND free_reset_at = ?",
      [monthly, reset, timestamp, tenantId, row.free_reset_at],
    );
    if (updated.changes === 1) {
      // Expired free credits are an explicit ledger event so the balance invariant still
      // holds after a reset lowers (or repeats) the monthly grant.
      const statements: Statement[] = [];
      if (expired > 0)
        statements.push(ledgerStatement({ tenantId, credits: -expired, source: "free", kind: "adjustment" }));
      if (monthly > 0) statements.push(ledgerStatement({ tenantId, credits: monthly, source: "free", kind: "grant" }));
      if (statements.length > 0) await db.batch(statements);
      row.free_balance = monthly;
      row.free_reset_at = reset;
    } else {
      const latest = await db.first<WalletRow>("SELECT * FROM wallets WHERE tenant_id = ?", [tenantId]);
      if (!latest) throw new Error("Wallet was not created");
      Object.assign(row, latest);
    }
  }
  return summary(row);
}

function summary(row: WalletRow): Wallet {
  return {
    free: row.free_balance,
    purchased: row.purchased_balance,
    reserved: row.reserved_credits,
    available: row.free_balance + row.purchased_balance - row.reserved_credits,
    freeResetAt: row.free_reset_at,
  };
}

export async function getWallet(db: Db, tenantId: string): Promise<Wallet> {
  return ensureWallet(db, tenantId);
}

/** Atomic reserve. Free credits are spent before purchased at settlement. */
export async function reserveCredits(db: Db, tenantId: string, credits: number, jobId: string): Promise<void> {
  if (!Number.isInteger(credits) || credits < 1)
    throw new HttpError("invalid_input", 400, "Credits must be a positive integer.");
  const wallet = await ensureWallet(db, tenantId);
  if (wallet.available < credits) {
    throw new HttpError("insufficient_credits", 402, `Needs ${credits} credits, ${wallet.available} available.`, {
      needed: credits,
      available: wallet.available,
      topup_url: platformConfig().brand.topupPath ?? "/app/credits",
    });
  }
  const timestamp = nowIso();
  const result = await db.run(
    `UPDATE wallets SET reserved_credits = reserved_credits + ?, updated_at = ?
     WHERE tenant_id = ? AND free_balance + purchased_balance - reserved_credits >= ?`,
    [credits, timestamp, tenantId, credits],
  );
  if (result.changes === 0) {
    const latest = await ensureWallet(db, tenantId);
    throw new HttpError("insufficient_credits", 402, `Needs ${credits} credits, ${latest.available} available.`, {
      needed: credits,
      available: latest.available,
      topup_url: platformConfig().brand.topupPath ?? "/app/credits",
    });
  }
  await grantLedger(db, tenantId, -credits, "reserved", jobId, "reserve");
}

export interface SettlementPlan {
  fromFree: number;
  fromPurchased: number;
  statements: Statement[];
}

/**
 * Statement form of a settlement, so a product can commit the job transition and the money
 * movement in **one** `db.batch`. `guard` is appended to every statement (as `WHERE EXISTS …`
 * for the ledger inserts), which lets the caller key the whole settlement on a per-attempt id:
 * a retry whose claim already lost changes nothing, so a job can never be charged twice.
 */
export function planSettlement(
  wallet: Wallet,
  tenantId: string,
  jobId: string,
  reserved: number,
  charged: number,
  guard?: { clause: string; params: unknown[] },
): SettlementPlan {
  const actual = Math.max(0, Math.min(charged, reserved));
  const fromFree = Math.min(wallet.free, actual);
  const fromPurchased = actual - fromFree;
  const timestamp = nowIso();
  const guardClause = guard ? ` AND (${guard.clause})` : "";
  const guardParams = guard?.params ?? [];
  const statements: Statement[] = [
    {
      sql: `UPDATE wallets SET free_balance = free_balance - ?, purchased_balance = purchased_balance - ?,
       reserved_credits = reserved_credits - ?, updated_at = ? WHERE tenant_id = ?${guardClause}`,
      params: [fromFree, fromPurchased, reserved, timestamp, tenantId, ...guardParams],
    },
  ];
  const ledger = (credits: number, source: "reserved" | "free" | "purchased", kind: "release" | "settle") => {
    const statement = ledgerStatement({ tenantId, credits, source, jobId, kind });
    if (!guard) return statement;
    // INSERT … SELECT … WHERE <guard>: the row only lands when the caller's guard still holds.
    return {
      sql: statement.sql.replace(
        /VALUES \(\?, \?, \?, \?, \?, \?, \?, \?, \?, \?\)$/,
        "SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 WHERE 1 = 1" + guardClause + ")",
      ),
      params: [...(statement.params ?? []), ...guardParams],
    } satisfies Statement;
  };
  // The reservation is always released in full, and the spend is booked against free/purchased.
  // That keeps `sum(ledger credits) per source == balance per source` (invariant 6).
  if (reserved > 0) statements.push(ledger(reserved, "reserved", "release"));
  if (fromFree > 0) statements.push(ledger(-fromFree, "free", "settle"));
  if (fromPurchased > 0) statements.push(ledger(-fromPurchased, "purchased", "settle"));
  return { fromFree, fromPurchased, statements };
}

export async function settleCredits(
  db: Db,
  tenantId: string,
  jobId: string,
  reserved: number,
  charged: number,
): Promise<void> {
  const wallet = await ensureWallet(db, tenantId);
  await db.batch(planSettlement(wallet, tenantId, jobId, reserved, charged).statements);
}

export async function releaseCredits(db: Db, tenantId: string, jobId: string, reserved: number): Promise<void> {
  if (reserved <= 0) return;
  await db.batch([
    {
      sql: "UPDATE wallets SET reserved_credits = reserved_credits - ?, updated_at = ? WHERE tenant_id = ?",
      params: [reserved, nowIso(), tenantId],
    },
    ledgerStatement({ tenantId, credits: reserved, source: "reserved", jobId, kind: "release" }),
  ]);
}

export type LedgerKind = "grant" | "reserve" | "settle" | "release" | "adjustment" | "refund" | "chargeback";
export type LedgerSource = "free" | "purchased" | "reserved";

export interface LedgerInput {
  tenantId: string;
  credits: number;
  source: LedgerSource;
  kind: LedgerKind;
  jobId?: string | null;
  paymentId?: string | null;
  ref?: string | null;
  userId?: string | null;
}

/** Statement form so callers can commit a ledger row and a balance change in one `db.batch`. */
export function ledgerStatement(input: LedgerInput): Statement {
  return {
    sql: `INSERT INTO ledger_entries (id, tenant_id, user_id, kind, credits, source, job_id, payment_id, ref, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [
      id("led"),
      input.tenantId,
      input.userId ?? null,
      input.kind,
      input.credits,
      input.source,
      input.jobId ?? null,
      input.paymentId ?? null,
      input.ref ?? null,
      nowIso(),
    ],
  };
}

async function grantLedger(
  db: Db,
  tenantId: string,
  credits: number,
  source: LedgerSource,
  jobId: string | null,
  kind: LedgerKind,
): Promise<void> {
  const statement = ledgerStatement({ tenantId, credits, source, jobId, kind });
  await db.run(statement.sql, statement.params);
}

export interface LedgerRow {
  id: string;
  kind: string;
  credits: number;
  source: string;
  job_id: string | null;
  created_at: string;
}

export async function listLedger(db: Db, tenantId: string, limit = 50): Promise<LedgerRow[]> {
  return db.all<LedgerRow>(
    "SELECT id, kind, credits, source, job_id, created_at FROM ledger_entries WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?",
    [tenantId, limit],
  );
}

/* --------------------------------------------------------------- guests */

function guestDay(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function reserveGuestCredits(db: Db, guestId: string, credits: number, locale?: string): Promise<void> {
  const day = guestDay();
  const timestamp = nowIso();
  const policy = platformConfig().guestPolicy;
  const lang = locale === "vi" ? "vi" : "en";
  await db.run("INSERT OR IGNORE INTO guest_usage (guest_id, day, credits_used, updated_at) VALUES (?, ?, 0, ?)", [
    guestId,
    day,
    timestamp,
  ]);
  if (credits > policy.dailyCredits) {
    throw new HttpError(
      "insufficient_credits",
      402,
      policy.exceedingMessage(lang, { needed: credits, allowed: policy.dailyCredits }),
      {
        needed: credits,
        available: policy.dailyCredits,
        reason: "guest_quota",
      },
    );
  }
  const result = await db.run(
    "UPDATE guest_usage SET credits_used = credits_used + ?, updated_at = ? WHERE guest_id = ? AND day = ? AND credits_used + ? <= ?",
    [credits, timestamp, guestId, day, credits, policy.dailyCredits],
  );
  if (result.changes === 0) {
    throw new HttpError(
      "quota_exceeded",
      429,
      policy.exhaustedMessage(lang, { allowed: policy.dailyCredits, freeMonthlyCredits: FREE_MONTHLY_CREDITS }),
      {
        limit: "guest_daily_credits",
        resets_at: day,
        signup_url: policy.signupPath,
      },
    );
  }
}

export async function releaseGuestCredits(db: Db, guestId: string, credits: number): Promise<void> {
  await db.run(
    "UPDATE guest_usage SET credits_used = MAX(0, credits_used - ?), updated_at = ? WHERE guest_id = ? AND day = ?",
    [credits, nowIso(), guestId, guestDay()],
  );
}
