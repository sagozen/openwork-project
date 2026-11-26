import { alertOperators } from "./alerts";
import { emitCommerceEvent } from "./commerce-events";
import { providerById } from "./billing";
import type { Db } from "./db";
import { id, nowIso } from "./db";
import { grantPurchase, markPaymentStatus, type PaymentRow, type ProviderId } from "./payments";
import type { PlatformEnv } from "./types";

/**
 * Nightly reconciliation: provider records vs `payments`, ledger vs wallet balances.
 * Findings are written for `/admin/reconciliation`; only reconciliation sets
 * `provider_paid_not_granted.auto_fixed` by calling the exactly-once grant.
 */

export type FindingKind =
  | "wallet_ledger_mismatch"
  | "provider_paid_not_granted"
  | "granted_not_paid"
  | "amount_mismatch"
  | "stale_pending"
  | "review"
  | "provider_skipped";

export interface WalletLedgerMismatch {
  tenantId: string;
  wallet: { free: number; purchased: number; reserved: number };
  ledger: { free: number; purchased: number; reserved: number };
}

const MAX_PROVIDER_CALLS = 50;
const STALE_AFTER_MS = 60 * 60 * 1000;
const EXPIRE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const PAID_CHECK_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

/** One formula, shared by reconciliation and the test helper. */
export async function findWalletLedgerMismatches(db: Db): Promise<WalletLedgerMismatch[]> {
  const wallets = await db.all<{
    tenant_id: string;
    free_balance: number;
    purchased_balance: number;
    reserved_credits: number;
  }>("SELECT tenant_id, free_balance, purchased_balance, reserved_credits FROM wallets");
  const sums = await db.all<{ tenant_id: string; source: string; total: number }>(
    "SELECT tenant_id, source, SUM(credits) AS total FROM ledger_entries GROUP BY tenant_id, source",
  );
  const byTenant = new Map<string, Map<string, number>>();
  for (const row of sums) {
    const bucket = byTenant.get(row.tenant_id) ?? new Map<string, number>();
    bucket.set(row.source, Number(row.total));
    byTenant.set(row.tenant_id, bucket);
  }
  const mismatches: WalletLedgerMismatch[] = [];
  for (const wallet of wallets) {
    const ledger = byTenant.get(wallet.tenant_id) ?? new Map<string, number>();
    const expected = {
      free: ledger.get("free") ?? 0,
      purchased: ledger.get("purchased") ?? 0,
      reserved: -(ledger.get("reserved") ?? 0),
    };
    if (
      expected.free !== wallet.free_balance ||
      expected.purchased !== wallet.purchased_balance ||
      expected.reserved !== wallet.reserved_credits
    ) {
      mismatches.push({
        tenantId: wallet.tenant_id,
        wallet: {
          free: wallet.free_balance,
          purchased: wallet.purchased_balance,
          reserved: wallet.reserved_credits,
        },
        ledger: expected,
      });
    }
  }
  return mismatches;
}

export interface ReconciliationResult {
  runAt: string;
  counts: Record<FindingKind, number>;
  skipped: ProviderId[];
  providerCalls: number;
}

const ZERO_COUNTS: Record<FindingKind, number> = {
  wallet_ledger_mismatch: 0,
  provider_paid_not_granted: 0,
  granted_not_paid: 0,
  amount_mismatch: 0,
  stale_pending: 0,
  review: 0,
  provider_skipped: 0,
};

export interface ReconciliationOptions {
  fetcher?: typeof fetch;
}

export async function runReconciliation(
  env: PlatformEnv,
  db: Db,
  now: Date = new Date(),
  options: ReconciliationOptions = {},
): Promise<ReconciliationResult> {
  const runAt = now.toISOString();
  const counts: Record<FindingKind, number> = { ...ZERO_COUNTS };
  const skipped: ProviderId[] = [];
  let providerCalls = 0;

  async function record(
    kind: FindingKind,
    detail: Record<string, unknown>,
    tenantId: string | null = null,
    paymentId: string | null = null,
  ): Promise<void> {
    counts[kind] += 1;
    // One unresolved row per (kind, tenant, payment): a nightly re-run must not duplicate the
    // operator's queue. Counts still reflect the current run, so alerts keep firing until fixed.
    const existing = await db.first<{ id: string }>(
      `SELECT id FROM reconciliation_findings
       WHERE kind = ? AND resolved_at IS NULL
         AND COALESCE(tenant_id, '') = ? AND COALESCE(payment_id, '') = ?`,
      [kind, tenantId ?? "", paymentId ?? ""],
    );
    if (existing) return;
    await db.run(
      `INSERT INTO reconciliation_findings (id, run_at, kind, tenant_id, payment_id, detail_json, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      [id("rec"), runAt, kind, tenantId, paymentId, JSON.stringify(detail)],
    );
  }

  const adapters: Partial<Record<ProviderId, ReturnType<typeof providerById>>> = {};
  for (const providerId of ["paddle", "stripe"] as ProviderId[]) {
    const adapter = providerById(env, providerId, { fetcher: options.fetcher });
    if (adapter) adapters[providerId] = adapter;
    else skipped.push(providerId);
  }
  for (const providerId of skipped) {
    // A skipped provider is not a passing check: surface it in the admin queue.
    await record("provider_skipped", { provider: providerId, reason: "secrets_missing" });
  }

  for (const mismatch of await findWalletLedgerMismatches(db)) {
    await record("wallet_ledger_mismatch", mismatch as unknown as Record<string, unknown>, mismatch.tenantId);
  }

  const staleBefore = new Date(now.getTime() - STALE_AFTER_MS).toISOString();
  const expireBefore = new Date(now.getTime() - EXPIRE_AFTER_MS).toISOString();
  const paidAfter = new Date(now.getTime() - PAID_CHECK_WINDOW_MS).toISOString();

  const abandoned = await db.all<PaymentRow>(
    "SELECT * FROM payments WHERE status IN ('created', 'pending') AND created_at < ? LIMIT 100",
    [expireBefore],
  );
  for (const payment of abandoned) {
    await markPaymentStatus(db, payment.id, "expired");
    await record("stale_pending", { action: "expired", age_days: 7 }, payment.tenant_id, payment.id);
  }

  const candidates = await db.all<PaymentRow>(
    `SELECT * FROM payments
     WHERE (status IN ('created', 'pending') AND created_at < ? AND created_at >= ?)
        OR (status IN ('paid', 'partially_refunded') AND paid_at IS NOT NULL AND paid_at >= ?)
     ORDER BY created_at ASC LIMIT 120`,
    [staleBefore, expireBefore, paidAfter],
  );

  for (const payment of candidates) {
    if (providerCalls >= MAX_PROVIDER_CALLS) break;
    const adapter = adapters[payment.provider as ProviderId];
    if (!adapter || !payment.provider_checkout_id) continue;
    let status: Awaited<ReturnType<NonNullable<typeof adapter>["fetchPaymentStatus"]>>;
    try {
      providerCalls += 1;
      status = await adapter.fetchPaymentStatus(payment.provider_checkout_id);
    } catch {
      // A provider outage is not evidence of fraud; leave the payment alone for the next run.
      continue;
    }

    if (payment.status === "paid" || payment.status === "partially_refunded") {
      const paidLike = ["paid", "partially_refunded", "refunded", "chargeback"];
      if (!paidLike.includes(status.status)) {
        await record(
          "granted_not_paid",
          { provider_status: status.status, payment_status: payment.status },
          payment.tenant_id,
          payment.id,
        );
      }
      continue;
    }

    if (status.status === "paid") {
      const amountMatches = status.currency === "USD" && (status.subtotalCents ?? 0) === payment.amount_cents;
      if (!amountMatches) {
        await markPaymentStatus(db, payment.id, "review");
        await record(
          "amount_mismatch",
          { expected_cents: payment.amount_cents, received_cents: status.subtotalCents ?? 0 },
          payment.tenant_id,
          payment.id,
        );
        continue;
      }
      const result = await grantPurchase(db, payment.id, {
        providerCheckoutId: payment.provider_checkout_id,
        providerPaymentId: status.providerPaymentId ?? null,
        taxCents: status.taxCents ?? null,
        totalCents: status.totalCents ?? null,
        paidAt: nowIso(),
      });
      if (result === "granted") {
        await emitCommerceEvent(env, db, "purchaseGranted", payment.id);
        await record(
          "provider_paid_not_granted",
          { auto_fixed: true, provider_status: status.status },
          payment.tenant_id,
          payment.id,
        );
      }
    } else if (status.status === "expired" || status.status === "failed") {
      await markPaymentStatus(db, payment.id, status.status);
      await record(
        "stale_pending",
        { action: status.status, provider_status: status.status },
        payment.tenant_id,
        payment.id,
      );
    }
  }

  const inReview = await db.all<{ id: string; tenant_id: string }>(
    "SELECT id, tenant_id FROM payments WHERE status = 'review' LIMIT 100",
  );
  for (const payment of inReview) {
    await record("review", { needs_admin: true }, payment.tenant_id, payment.id);
  }

  if (counts.wallet_ledger_mismatch > 0 || counts.granted_not_paid > 0 || counts.review > 0) {
    await alertOperators(env, db, {
      kind: "reconciliation",
      summary: "Reconciliation found billing findings that need an operator.",
      detail: {
        wallet_ledger_mismatch: counts.wallet_ledger_mismatch,
        granted_not_paid: counts.granted_not_paid,
        review: counts.review,
        skipped: skipped.join(",") || "none",
      },
    });
  }

  return { runAt, counts, skipped, providerCalls };
}
