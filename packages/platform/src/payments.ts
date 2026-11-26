import { ensureWallet, ledgerStatement } from "./credits";
import type { Db, Statement } from "./db";
import { id, nowIso } from "./db";

/**
 * Payments, provider events and the credit ledger link.
 *
 * Exactly-once guarantees live in the database, not in this file:
 * - `ledger_payment_grant_uidx` allows one `grant` row per payment.
 * - `ledger_payment_ref_uidx` allows one debit row per (payment, kind, provider reference).
 * A duplicate therefore fails the whole `db.batch`, so the wallet update is rolled back too.
 */

export type ProviderId = "paddle" | "stripe";

export type PaymentStatus =
  | "created"
  | "pending"
  | "paid"
  | "failed"
  | "expired"
  | "refunded"
  | "partially_refunded"
  | "chargeback"
  | "review";

export interface PaymentRow {
  id: string;
  tenant_id: string;
  user_id: string | null;
  provider: string;
  provider_checkout_id: string | null;
  provider_payment_id: string | null;
  checkout_url: string | null;
  pack_id: string;
  credits: number;
  amount_cents: number;
  currency: string;
  tax_cents: number | null;
  total_cents: number | null;
  status: PaymentStatus;
  refunded_cents: number;
  idempotency_key: string | null;
  created_at: string;
  updated_at: string;
  paid_at: string | null;
}

export interface CreatePaymentInput {
  tenantId: string;
  userId: string | null;
  provider: ProviderId;
  packId: string;
  credits: number;
  amountCents: number;
  currency?: string;
  idempotencyKey: string | null;
}

export interface GrantFacts {
  providerCheckoutId: string;
  providerPaymentId?: string | null;
  taxCents?: number | null;
  totalCents?: number | null;
  paidAt: string;
}

export const PAYMENTS_COLUMNS =
  "id, tenant_id, user_id, provider, provider_checkout_id, provider_payment_id, checkout_url, pack_id, credits, amount_cents, currency, tax_cents, total_cents, status, refunded_cents, idempotency_key, created_at, updated_at, paid_at";

export async function getPayment(db: Db, paymentId: string): Promise<PaymentRow | null> {
  return db.first<PaymentRow>(`SELECT ${PAYMENTS_COLUMNS} FROM payments WHERE id = ?`, [paymentId]);
}

export async function findPaymentByCheckoutId(
  db: Db,
  provider: ProviderId,
  providerCheckoutId: string,
): Promise<PaymentRow | null> {
  return db.first<PaymentRow>(
    `SELECT ${PAYMENTS_COLUMNS} FROM payments WHERE provider = ? AND provider_checkout_id = ?`,
    [provider, providerCheckoutId],
  );
}

export async function findPaymentByProviderPaymentId(
  db: Db,
  provider: ProviderId,
  providerPaymentId: string,
): Promise<PaymentRow | null> {
  return db.first<PaymentRow>(
    `SELECT ${PAYMENTS_COLUMNS} FROM payments WHERE provider = ? AND provider_payment_id = ?`,
    [provider, providerPaymentId],
  );
}

export async function listPayments(db: Db, tenantId: string, limit = 50): Promise<PaymentRow[]> {
  return db.all<PaymentRow>(
    `SELECT ${PAYMENTS_COLUMNS} FROM payments WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?`,
    [tenantId, limit],
  );
}

/**
 * Insert a `created` payment. A repeated `(tenant_id, idempotency_key)` returns the stored row so
 * the caller can reuse the original checkout URL instead of charging twice.
 */
export async function createPaymentRow(db: Db, input: CreatePaymentInput): Promise<PaymentRow> {
  const timestamp = nowIso();
  const paymentId = id("pay");
  if (input.idempotencyKey) {
    const existing = await db.first<PaymentRow>(
      `SELECT ${PAYMENTS_COLUMNS} FROM payments WHERE tenant_id = ? AND idempotency_key = ?`,
      [input.tenantId, input.idempotencyKey],
    );
    if (existing) return existing;
  }
  await db.run(
    `INSERT INTO payments (id, tenant_id, user_id, provider, provider_checkout_id, provider_payment_id, checkout_url,
       pack_id, credits, amount_cents, currency, tax_cents, total_cents, status, refunded_cents, idempotency_key,
       created_at, updated_at, paid_at)
     VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, NULL, NULL, 'created', 0, ?, ?, ?, NULL)`,
    [
      paymentId,
      input.tenantId,
      input.userId,
      input.provider,
      input.packId,
      input.credits,
      input.amountCents,
      input.currency ?? "USD",
      input.idempotencyKey,
      timestamp,
      timestamp,
    ],
  );
  const row = await getPayment(db, paymentId);
  if (!row) throw new Error("Payment was not created");
  return row;
}

/** Persist the provider checkout handle after a successful `createCheckout`. */
export async function attachCheckout(
  db: Db,
  paymentId: string,
  checkout: { providerCheckoutId: string; url: string },
): Promise<void> {
  await db.run(
    "UPDATE payments SET provider_checkout_id = ?, checkout_url = ?, status = 'pending', updated_at = ? WHERE id = ?",
    [checkout.providerCheckoutId, checkout.url, nowIso(), paymentId],
  );
}

/**
 * Grant a pack exactly once: the ledger row, the wallet credit and the payment status change
 * commit together. A second call for the same payment changes nothing and returns `duplicate`.
 */
export async function grantPurchase(db: Db, paymentId: string, facts: GrantFacts): Promise<"granted" | "duplicate"> {
  const payment = await getPayment(db, paymentId);
  if (!payment) throw new Error(`Unknown payment ${paymentId}`);
  await ensureWallet(db, payment.tenant_id);
  const timestamp = nowIso();
  const statements: Statement[] = [
    ledgerStatement({
      tenantId: payment.tenant_id,
      userId: payment.user_id,
      credits: payment.credits,
      source: "purchased",
      kind: "grant",
      paymentId: payment.id,
    }),
    {
      sql: "UPDATE wallets SET purchased_balance = purchased_balance + ?, updated_at = ? WHERE tenant_id = ?",
      params: [payment.credits, timestamp, payment.tenant_id],
    },
    {
      sql: `UPDATE payments SET status = 'paid', paid_at = COALESCE(paid_at, ?), tax_cents = COALESCE(?, tax_cents),
              total_cents = COALESCE(?, total_cents), provider_checkout_id = COALESCE(provider_checkout_id, ?),
              provider_payment_id = COALESCE(?, provider_payment_id), updated_at = ?
            WHERE id = ?`,
      params: [
        facts.paidAt,
        facts.taxCents ?? null,
        facts.totalCents ?? null,
        facts.providerCheckoutId,
        facts.providerPaymentId ?? null,
        timestamp,
        payment.id,
      ],
    },
  ];
  try {
    await db.batch(statements);
    return "granted";
  } catch (error) {
    if (isUniqueViolation(error)) return "duplicate";
    throw error;
  }
}

export interface DebitInput {
  kind: "refund" | "chargeback";
  ref: string;
  /** Credits to remove. May take `purchased_balance` below zero after the credits were spent. */
  credits: number;
  /** Cumulative amount refunded for this payment, gross of tax. */
  refundedCents: number;
}

/**
 * Debit credits for a refund or chargeback at most once per provider reference.
 *
 * The whole operation is one `db.batch`: the ledger insert is the *claim* (it only happens while
 * the payment still matches the state the caller observed), and the wallet/status updates are gated
 * on that ledger row existing. A lost claim therefore writes nothing at all — no rollback dance and
 * no window where `refunded_cents` advanced without a matching debit.
 */
export async function debitPayment(
  db: Db,
  paymentId: string,
  input: DebitInput,
): Promise<"debited" | "duplicate" | "conflict"> {
  const payment = await getPayment(db, paymentId);
  if (!payment) throw new Error(`Unknown payment ${paymentId}`);
  const timestamp = nowIso();
  const basis = payment.total_cents ?? payment.amount_cents;
  const cumulative = Math.max(input.refundedCents, payment.refunded_cents);
  const status: PaymentStatus =
    input.kind === "chargeback" ? "chargeback" : cumulative >= basis ? "refunded" : "partially_refunded";
  const isRefund = input.kind === "refund";
  const claimCondition = isRefund
    ? "refunded_cents = ? AND status <> 'chargeback'"
    : "status <> 'chargeback' AND refunded_cents = ?";

  if (input.credits <= 0) {
    const result = isRefund
      ? await db.run(
          `UPDATE payments SET refunded_cents = ?, status = ?, updated_at = ? WHERE id = ? AND ${claimCondition}`,
          [cumulative, status, timestamp, payment.id, payment.refunded_cents],
        )
      : await db.run(`UPDATE payments SET status = 'chargeback', updated_at = ? WHERE id = ? AND ${claimCondition}`, [
          timestamp,
          payment.id,
          payment.refunded_cents,
        ]);
    if (result.changes === 0) {
      const fresh = await getPayment(db, payment.id);
      return fresh?.status === "chargeback" ? "duplicate" : "conflict";
    }
    // Nothing left to claw back; the status change is the whole effect.
    return "duplicate";
  }

  const ledgerId = id("led");
  const statements: Statement[] = [
    {
      sql: `INSERT INTO ledger_entries (id, tenant_id, user_id, kind, credits, source, job_id, payment_id, ref, created_at)
            SELECT ?, ?, ?, ?, ?, 'purchased', NULL, ?, ?, ?
            WHERE EXISTS (SELECT 1 FROM payments WHERE id = ? AND ${claimCondition})`,
      params: [
        ledgerId,
        payment.tenant_id,
        payment.user_id,
        input.kind,
        -input.credits,
        payment.id,
        input.ref,
        timestamp,
        payment.id,
        payment.refunded_cents,
      ],
    },
    {
      sql: "UPDATE wallets SET purchased_balance = purchased_balance - ?, updated_at = ? WHERE tenant_id = ? AND EXISTS (SELECT 1 FROM ledger_entries WHERE id = ?)",
      params: [input.credits, timestamp, payment.tenant_id, ledgerId],
    },
    isRefund
      ? {
          sql: "UPDATE payments SET refunded_cents = ?, status = ?, updated_at = ? WHERE id = ? AND EXISTS (SELECT 1 FROM ledger_entries WHERE id = ?)",
          params: [cumulative, status, timestamp, payment.id, ledgerId],
        }
      : {
          sql: "UPDATE payments SET status = 'chargeback', updated_at = ? WHERE id = ? AND EXISTS (SELECT 1 FROM ledger_entries WHERE id = ?)",
          params: [timestamp, payment.id, ledgerId],
        },
  ];

  try {
    await db.batch(statements);
  } catch (error) {
    if (isUniqueViolation(error)) return "duplicate";
    throw error;
  }

  const claimed = await db.first<{ id: string }>("SELECT id FROM ledger_entries WHERE id = ?", [ledgerId]);
  if (claimed) return "debited";
  // Another event changed the payment between our read and the claim. A chargeback already took
  // the whole pack, so there is nothing left for a late refund either.
  const fresh = await getPayment(db, payment.id);
  return fresh?.status === "chargeback" ? "duplicate" : "conflict";
}

export async function markPaymentStatus(db: Db, paymentId: string, status: PaymentStatus): Promise<void> {
  await db.run("UPDATE payments SET status = ?, updated_at = ? WHERE id = ?", [status, nowIso(), paymentId]);
}

/** Audit trail only — dedupe correctness comes from the ledger indexes. */
export async function recordEvent(
  db: Db,
  provider: ProviderId,
  eventId: string,
  eventType: string,
  paymentId: string | null,
  outcome: string,
): Promise<boolean> {
  const result = await db.run(
    `INSERT OR IGNORE INTO payment_events (provider, event_id, event_type, payment_id, outcome, received_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [provider, eventId, eventType, paymentId, outcome, nowIso()],
  );
  return result.changes > 0;
}

export async function getProviderCustomer(db: Db, tenantId: string, provider: ProviderId): Promise<string | null> {
  const row = await db.first<{ customer_id: string }>(
    "SELECT customer_id FROM provider_customers WHERE tenant_id = ? AND provider = ?",
    [tenantId, provider],
  );
  return row?.customer_id ?? null;
}

export async function saveProviderCustomer(
  db: Db,
  tenantId: string,
  provider: ProviderId,
  customerId: string,
): Promise<void> {
  await db.run(
    `INSERT INTO provider_customers (tenant_id, provider, customer_id, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (tenant_id, provider) DO UPDATE SET customer_id = excluded.customer_id`,
    [tenantId, provider, customerId, nowIso()],
  );
}

/**
 * Credits to debit for a refund delta, proportional to the credits the pack granted.
 * The caller passes `remaining` for the final refund so rounding never leaves a stray credit.
 */
export function refundCredits(payment: PaymentRow, grossDeltaCents: number, remaining: number): number {
  const basis = payment.total_cents ?? payment.amount_cents;
  if (basis <= 0) return remaining;
  const proportional = Math.floor((payment.credits * grossDeltaCents) / basis);
  return Math.max(0, Math.min(proportional, remaining));
}

function isUniqueViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("UNIQUE constraint failed") || message.includes("constraint failed: UNIQUE");
}
