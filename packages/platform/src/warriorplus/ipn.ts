import { alertOperators } from "../alerts";
import type { WarriorPlusConfig } from "../config";
import { type Db, d1Db, id, nowIso } from "../db";
import { sendTransactionalEmail } from "../emails/send";
import { HttpError } from "../http";
import type { PlatformEnv } from "../types";
import { attachPurchases } from "./attach";
import { materializeEntitlements, resolveProduct } from "./entitlements";
import { amountCents, constantTimeEqual, parseIpn, pick, stripSecret } from "./parse";
import { nextState } from "./state";
import {
  DUMMY_SECURITY_KEY,
  type IpnEventRow,
  type IpnPayload,
  type PurchaseRow,
  toWarriorPlusPurchase,
} from "./types";

export interface WaitUntilContext {
  waitUntil(promise: Promise<unknown>): void;
}

const TEST_WINDOW_MAX_MINUTES = 15;

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function isTestWindowOpen(db: Db, app: string): Promise<boolean> {
  const row = await db.first<{ until: string }>("SELECT until FROM wp_test_window WHERE app = ?", [app]);
  return Boolean(row && Date.parse(row.until) > Date.now());
}

/**
 * Public IPN endpoint. The security key is checked first; a Send Test request carrying the public
 * dummy key is structurally separated before any other code runs and can only ever write to
 * `wp_ipn_test_events`, which nothing processes.
 */
export async function handleWarriorPlusIpn(
  request: Request,
  env: PlatformEnv,
  ctx: WaitUntilContext,
  config: WarriorPlusConfig,
  dbOverride?: Db,
): Promise<Response> {
  const db = dbOverride ?? d1Db(env.DB);
  let payload: IpnPayload;
  try {
    payload = await parseIpn(request);
  } catch (error) {
    if (error instanceof HttpError) return json(error.status, { error: error.code });
    return json(400, { error: "invalid_input" });
  }

  const key = pick(payload, "WP_SECURITYKEY");
  const now = nowIso();

  if (constantTimeEqual(key, DUMMY_SECURITY_KEY)) {
    if (!(await isTestWindowOpen(db, config.app))) {
      return json(401, { error: "unauthenticated" });
    }
    const clean = stripSecret(payload);
    await db.run("INSERT INTO wp_ipn_test_events (id, app, action, payload, received_at) VALUES (?, ?, ?, ?, ?)", [
      id("wpt"),
      config.app,
      pick(payload, "WP_ACTION") || null,
      JSON.stringify(clean),
      now,
    ]);
    return json(200, { ok: true, test: true });
  }

  const current = env.WARRIORPLUS_IPN_KEY ?? "";
  const next = env.WARRIORPLUS_IPN_KEY_NEXT ?? "";
  const keyMatches = Boolean((current && constantTimeEqual(key, current)) || (next && constantTimeEqual(key, next)));
  if (!keyMatches) return json(401, { error: "unauthenticated" });

  const ipnId = pick(payload, "IPN_ID");
  const action = pick(payload, "WP_ACTION");
  if (!ipnId || !action) return json(400, { error: "invalid_input" });

  const recipient = pick(payload, "IPN_RCPT_TYPE");
  const obfuscated = pick(payload, "WP_PII_OBFUSCATED") === "1";
  const ignored = recipient !== "vend" || obfuscated;
  const sale = pick(payload, "WP_SALE") || null;
  const itemNumber = pick(payload, "WP_ITEM_NUMBER") || null;
  const subscrId = pick(payload, "WP_SUBSCR_ID") || null;
  const paymentNum = pick(payload, "WP_SUBSCR_PAYMENT_NUM") || null;

  const inserted = await db.run(
    `INSERT OR IGNORE INTO wp_ipn_events
      (ipn_id, app, action, sale, item_number, subscr_id, payment_num, payload, status, attempts, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    [
      ipnId,
      config.app,
      action,
      sale,
      itemNumber,
      subscrId,
      paymentNum,
      JSON.stringify(stripSecret(payload)),
      ignored ? "ignored" : "pending",
      now,
    ],
  );

  if (inserted.changes === 0) {
    const existing = await db.first<{ status: IpnEventRow["status"] }>(
      "SELECT status FROM wp_ipn_events WHERE app = ? AND ipn_id = ?",
      [config.app, ipnId],
    );
    if (!existing || existing.status === "processed" || existing.status === "ignored") {
      return json(200, { ok: true, duplicate: true });
    }
    if (existing.status === "needs_review") {
      return json(200, { ok: true, review: true });
    }
    // A manual resend of an unfinished event recovers a lost delivery.
    await db.run(
      "UPDATE wp_ipn_events SET status='pending', error=NULL, attempts=attempts+1 WHERE app=? AND ipn_id=?",
      [config.app, ipnId],
    );
  }

  if (!ignored) {
    ctx.waitUntil(processIpnEvent(env, db, config, ipnId));
  }
  return json(200, { ok: true });
}

/** Process one stored event. Exported so the cron, admin reprocess and tests can call it. */
export async function processIpnEvent(
  env: PlatformEnv,
  db: Db,
  config: WarriorPlusConfig,
  ipnId: string,
): Promise<void> {
  const event = await db.first<IpnEventRow>("SELECT * FROM wp_ipn_events WHERE app = ? AND ipn_id = ?", [
    config.app,
    ipnId,
  ]);
  if (!event || event.status === "processed" || event.status === "ignored") return;
  try {
    const completed = await applyEvent(env, db, config, event);
    if (!completed) return;
    await db.run("UPDATE wp_ipn_events SET status='processed', processed_at=?, error=NULL WHERE app=? AND ipn_id=?", [
      nowIso(),
      config.app,
      ipnId,
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : "unknown error";
    const attempts = event.attempts + 1;
    await db.run("UPDATE wp_ipn_events SET status=?, error=?, attempts=?, processed_at=? WHERE app=? AND ipn_id=?", [
      attempts >= 5 ? "needs_review" : "failed",
      message,
      attempts,
      nowIso(),
      config.app,
      ipnId,
    ]);
    await alertOperators(env, db, {
      kind: "warriorplus_ipn_failed",
      summary: "A WarriorPlus IPN could not be processed",
      detail: { ipn: ipnId, action: event.action, attempts },
    });
  }
}

async function applyEvent(env: PlatformEnv, db: Db, config: WarriorPlusConfig, event: IpnEventRow): Promise<boolean> {
  const payload = JSON.parse(event.payload) as IpnPayload;
  if (pick(payload, "IPN_RCPT_TYPE") !== "vend" || pick(payload, "WP_PII_OBFUSCATED") === "1") {
    return true;
  }
  const buyerEmail = pick(payload, "WP_BUYER_EMAIL").trim().toLowerCase();
  const sale = pick(payload, "WP_SALE");
  const itemNumber = pick(payload, "WP_ITEM_NUMBER");
  if (!buyerEmail || !sale || !itemNumber) {
    await reviewEvent(env, db, config, event, "missing buyer email, sale or item number");
    return false;
  }
  const resolved = resolveProduct(config, itemNumber);
  if (!resolved) {
    await reviewEvent(env, db, config, event, `unknown product ${itemNumber}`);
    return false;
  }

  const existing = await db.first<PurchaseRow>(
    "SELECT * FROM wp_purchases WHERE app = ? AND sale = ? AND item_number = ?",
    [config.app, sale, itemNumber],
  );
  const timestamp = nowIso();
  const eventPayment = Number.parseInt(pick(payload, "WP_SUBSCR_PAYMENT_NUM"), 10);
  const state = nextState(
    {
      status: existing?.status ?? "active",
      lastPaymentNum: existing?.last_payment_num ?? null,
      lastGrantedPaymentNum: existing?.last_granted_payment_num ?? null,
      currentPeriodEnd: existing?.current_period_end ?? null,
      revokedAt: existing?.revoked_at ?? null,
      reviewReason: existing?.review_reason ?? null,
    },
    {
      action: event.action,
      kind: resolved.product.kind,
      paymentNum: Number.isFinite(eventPayment) ? eventPayment : null,
      nextPaymentDate: pick(payload, "WP_SUBSCR_NEXT_PAYMENT_DATE") || null,
      paymentStatus: pick(payload, "WP_SUBSCR_PAYMENT_STATUS") || null,
      now: timestamp,
    },
  );
  if (state.ignoredReason) {
    return true;
  }

  const purchaseId = existing?.id ?? id("wpu");
  const cents = amountCents(pick(payload, "WP_SALE_AMOUNT"));
  if (!existing) {
    await db.run(
      `INSERT INTO wp_purchases
        (id, app, sale, item_number, product_code, kind, buyer_email, status, subscr_id,
         last_payment_num, current_period_end, amount_cents, source, granted_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ipn', ?, ?)`,
      [
        purchaseId,
        config.app,
        sale,
        itemNumber,
        resolved.product.code,
        resolved.product.kind,
        buyerEmail,
        state.state.status,
        pick(payload, "WP_SUBSCR_ID") || null,
        state.state.lastPaymentNum,
        state.state.currentPeriodEnd,
        cents,
        timestamp,
        timestamp,
      ],
    );
  } else {
    await db.run(
      `UPDATE wp_purchases
          SET status=?, subscr_id=COALESCE(subscr_id, ?), last_payment_num=?,
              current_period_end=COALESCE(?, current_period_end),
              revoked_at=?, review_reason=COALESCE(?, review_reason),
              amount_cents=COALESCE(?, amount_cents), updated_at=?
        WHERE id=?`,
      [
        state.state.status,
        pick(payload, "WP_SUBSCR_ID") || null,
        state.state.lastPaymentNum,
        state.state.currentPeriodEnd,
        state.state.revokedAt,
        state.state.reviewReason,
        cents,
        timestamp,
        purchaseId,
      ],
    );
  }

  if (resolved.product.kind === "recurring" && Number.isFinite(eventPayment) && eventPayment > 0) {
    const paymentInsert = await db.run(
      `INSERT OR IGNORE INTO wp_subscription_payments (app, sale, payment_num, action, ipn_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [config.app, sale, eventPayment, event.action, event.ipn_id, timestamp],
    );
    // A replayed payment event changes nothing else.
    if (paymentInsert.changes === 0) return true;
  }

  const attached = await attachPurchases(db, config, buyerEmail);
  if (!existing && (!attached || attached.claimed === 0)) {
    await sendWelcomeEmail(env, db, config, buyerEmail);
  }

  const isFrontEndRefund = resolved.product.code === "fe" && (event.action === "refund" || event.action === "dispute");
  if (isFrontEndRefund) {
    await db.run(
      `UPDATE wp_purchases
          SET status='needs_review', review_reason='fe_refunded_refund_addon', updated_at=?
        WHERE app=? AND lower(buyer_email)=? AND product_code <> 'fe' AND status='active'`,
      [timestamp, config.app, buyerEmail],
    );
    await alertOperators(env, db, {
      kind: "warriorplus_fe_refund",
      summary: "A Front End refund needs its add-ons refunded",
      detail: { sale, email: buyerEmail },
    });
    if (attached?.tenantId) {
      await materializeEntitlements(db, config, attached.tenantId);
    }
  }

  // The failure notice is not value-bearing: the row is written even before verification, and
  // the app keeps it to one email per payment cycle.
  if (state.effects.includes("payment_failed_email")) {
    const failed = await db.first<PurchaseRow>("SELECT * FROM wp_purchases WHERE id = ?", [purchaseId]);
    if (failed) await config.onPaymentFailed?.(env, db, toWarriorPlusPurchase(failed));
  }
  // A refund removes credits; it can never mint them, so it is safe to queue at ingest too.
  if (state.effects.includes("revoke_credits") && existing) {
    const paymentNum = state.state.lastPaymentNum ?? existing.last_payment_num ?? 1;
    await config.onPaymentRefunded?.(db, toWarriorPlusPurchase(existing), paymentNum);
  }

  // Value-bearing side effects (credits, Club grants) run only after REST verification, never
  // here. See verify.ts and the app's onVerified/onPaymentCompleted hooks.
  return true;
}

async function reviewEvent(
  env: PlatformEnv,
  db: Db,
  config: WarriorPlusConfig,
  event: IpnEventRow,
  reason: string,
): Promise<void> {
  await db.run("UPDATE wp_ipn_events SET status='needs_review', error=?, processed_at=? WHERE app=? AND ipn_id=?", [
    reason,
    nowIso(),
    config.app,
    event.ipn_id,
  ]);
  await alertOperators(env, db, {
    kind: "warriorplus_needs_review",
    summary: "A WarriorPlus IPN needs review",
    detail: { ipn: event.ipn_id, action: event.action, reason },
  });
}

export async function sendWelcomeEmail(
  env: PlatformEnv,
  db: Db,
  config: WarriorPlusConfig,
  email: string,
  force = false,
): Promise<void> {
  const recent = force
    ? null
    : await db.first<{ count: number }>(
        `SELECT COUNT(*) AS count FROM email_outbox
      WHERE to_email = ? AND template = 'product_notice' AND created_at > ?`,
        [email, new Date(Date.now() - 86_400_000).toISOString()],
      );
  if ((recent?.count ?? 0) > 0) return;
  const copy = config.welcome ?? {
    subject: "Your purchase is ready",
    heading: "Your purchase is ready",
    lines: ["Sign in with this email address to open what you bought."],
  };
  try {
    await sendTransactionalEmail(env, db, {
      to: email,
      locale: "en",
      template: "product_notice",
      data: {
        subject: copy.subject,
        heading: copy.heading,
        lines: copy.lines.join("\n"),
        ...(copy.actionUrl ? { actionUrl: copy.actionUrl, actionLabel: copy.actionLabel ?? "Open" } : {}),
      },
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        evt: "warriorplus_welcome_failed",
        error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
      }),
    );
  }
}

export async function openTestWindow(
  db: Db,
  app: string,
  openedBy: string,
  minutes = TEST_WINDOW_MAX_MINUTES,
): Promise<{ until: string }> {
  const bounded = Math.min(Math.max(minutes, 1), TEST_WINDOW_MAX_MINUTES);
  const now = nowIso();
  const until = new Date(Date.now() + bounded * 60_000).toISOString();
  await db.run(
    `INSERT INTO wp_test_window (app, opened_by, until, opened_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (app) DO UPDATE SET opened_by = excluded.opened_by, until = excluded.until, opened_at = excluded.opened_at`,
    [app, openedBy, until, now],
  );
  return { until };
}

export async function closeTestWindow(db: Db, app: string): Promise<void> {
  await db.run("DELETE FROM wp_test_window WHERE app = ?", [app]);
}

export async function readTestWindow(db: Db, app: string): Promise<{ until: string; openedBy: string } | null> {
  const row = await db.first<{ until: string; opened_by: string }>(
    "SELECT until, opened_by FROM wp_test_window WHERE app = ?",
    [app],
  );
  return row ? { until: row.until, openedBy: row.opened_by } : null;
}
