import { type CrmProductUsage, packById, platformConfig } from "./config";
import type { Db } from "./db";
import { sendTransactionalEmail } from "./emails/send";
import type { PaymentRow } from "./payments";
import type { PlatformEnv } from "./types";

/**
 * Mini CRM for the operator: the customer journey, the stuck-customer list, and the three
 * operator emails (customer pressed buy, customer bought, usage over the last 6 hours). Shared by
 * every app that sets `crm` in its platform config and ships the `crm_events`/`crm_notices` tables.
 *
 * Journey events are derived from records the product already keeps, so no request path writes
 * to the CRM and a CRM failure can never break a customer action. Only ids, step names and
 * minimal detail are stored. Emails are claimed in `crm_notices` before they are sent, so a
 * webhook replay or a repeated cron tick cannot mail the same event twice.
 */
export const crmStages = ["signed_up", "first_success", "checkout_started", "paid"] as const;
export type CrmStage = (typeof crmStages)[number];

export const stepLabels: Record<string, string> = {
  signed_up: "Signed up",
  first_success: "First successful job",
  api_key_created: "Created an API key",
  checkout_started: "Pressed buy",
  paid: "Paid",
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ABANDONED_AFTER_MS = HOUR;
const STUCK_AFTER_MS = DAY;
const STALE_AFTER_MS = 30 * DAY;
const MAX_CUSTOMERS = 5000;
function crmConfig() {
  const crm = platformConfig().crm;
  if (!crm) throw new Error("CRM is not configured: set `crm` in createPlatform()");
  return crm;
}

export const USAGE_WINDOW_MS = 6 * HOUR;

/** ISO text from either an ISO text column or an epoch-millisecond one (Better Auth `date`). */
const iso = (column: string) =>
  `(CASE WHEN typeof(${column}) IN ('integer','real') THEN strftime('%Y-%m-%dT%H:%M:%fZ', ${column} / 1000.0, 'unixepoch') ELSE ${column} END)`;

/** Each source selects (tenant_id, user_id, step, source_id, detail, occurred_at). */
const sources = (): string[] => [
  `SELECT m.tenant_id, m.user_id, 'signed_up', '', '{}', ${iso("u.createdAt")}
   FROM memberships m JOIN "user" u ON u.id = m.user_id`,
  crmConfig().firstSuccessSql,
  `SELECT tenant_id, user_id, 'api_key_created', '', '{}', created_at FROM (
     SELECT tenant_id, user_id, created_at,
       ROW_NUMBER() OVER (PARTITION BY tenant_id ORDER BY created_at, id) AS rn
     FROM api_keys) WHERE rn = 1`,
  `SELECT tenant_id, user_id, 'checkout_started', id,
     json_object('pack', pack_id, 'amount_cents', amount_cents, 'currency', currency, 'provider', provider),
     created_at FROM payments`,
  `SELECT tenant_id, user_id, 'paid', id,
     json_object('pack', pack_id, 'amount_cents', amount_cents, 'currency', currency, 'provider', provider),
     paid_at FROM payments WHERE paid_at IS NOT NULL`,
];

/** Writes any journey event the records imply but the CRM has not seen yet. Safe to repeat. */
export async function reconcileCrm(db: Db): Promise<void> {
  await db.batch(
    sources().map((source) => ({
      sql: `INSERT OR IGNORE INTO crm_events (id, tenant_id, user_id, step, source_id, detail, occurred_at)
            SELECT lower(hex(randomblob(16))), q.* FROM (${source}) q WHERE q.tenant_id IS NOT NULL`,
    })),
  );
}

export interface CustomerRow {
  tenantId: string;
  name: string;
  email: string;
  stage: CrmStage;
  stageEnteredAt: string;
  hoursInStage: number;
  lastEventAt: string;
  signedUpAt: string | null;
  firstPaidAt: string | null;
  paidCents: number;
  checkouts: number;
  stuck: boolean;
  abandonedCheckout: boolean;
}

interface AggregateRow {
  tenant_id: string;
  name: string | null;
  email: string | null;
  signed_up_at: string | null;
  first_success_at: string | null;
  last_checkout_at: string | null;
  first_paid_at: string | null;
  last_event_at: string;
  checkouts: number;
  paid_cents: number;
}

function toCustomer(row: AggregateRow, now: number): CustomerRow {
  const stage: CrmStage = row.first_paid_at
    ? "paid"
    : row.last_checkout_at
      ? "checkout_started"
      : row.first_success_at
        ? "first_success"
        : "signed_up";
  const entered =
    (stage === "paid"
      ? row.first_paid_at
      : stage === "checkout_started"
        ? row.last_checkout_at
        : stage === "first_success"
          ? row.first_success_at
          : row.signed_up_at) ?? row.last_event_at;
  const age = Math.max(0, now - Date.parse(entered));
  const unpaid = stage !== "paid";
  const abandonedCheckout = unpaid && stage === "checkout_started" && age > ABANDONED_AFTER_MS;
  return {
    tenantId: row.tenant_id,
    name: row.name ?? "",
    email: row.email ?? "",
    stage,
    stageEnteredAt: entered,
    hoursInStage: Math.floor(age / HOUR),
    lastEventAt: row.last_event_at,
    signedUpAt: row.signed_up_at,
    firstPaidAt: row.first_paid_at,
    paidCents: row.paid_cents,
    checkouts: row.checkouts,
    // An abandoned checkout is stuck sooner than any other stage; very old accounts are just inactive.
    stuck: unpaid && age < STALE_AFTER_MS && (abandonedCheckout || age > STUCK_AFTER_MS),
    abandonedCheckout,
  };
}

export interface CustomerFilter {
  stage?: string;
  stuck?: boolean;
  abandoned?: boolean;
  q?: string;
}

export interface CustomerList {
  items: CustomerRow[];
  total: number;
  /** Customers who signed up in the last 30 days, counted at every stage they reached. */
  funnel: Array<{ stage: CrmStage; count: number }>;
  stuckTotal: number;
  abandonedTotal: number;
  capped: boolean;
}

export async function listCustomers(
  db: Db,
  filter: CustomerFilter = {},
  now = Date.now(),
): Promise<CustomerList> {
  const rows = await db.all<AggregateRow>(
    `SELECT e.tenant_id,
       COALESCE(NULLIF(p.display_name, ''), u.name) AS name, u.email AS email,
       MIN(CASE WHEN e.step = 'signed_up' THEN e.occurred_at END) AS signed_up_at,
       MIN(CASE WHEN e.step = 'first_success' THEN e.occurred_at END) AS first_success_at,
       MAX(CASE WHEN e.step = 'checkout_started' THEN e.occurred_at END) AS last_checkout_at,
       MIN(CASE WHEN e.step = 'paid' THEN e.occurred_at END) AS first_paid_at,
       MAX(e.occurred_at) AS last_event_at,
       SUM(e.step = 'checkout_started') AS checkouts,
       COALESCE((SELECT SUM(amount_cents) FROM payments y WHERE y.tenant_id = e.tenant_id AND y.paid_at IS NOT NULL), 0) AS paid_cents
     FROM crm_events e
     JOIN memberships m ON m.tenant_id = e.tenant_id AND m.role = 'owner'
     JOIN "user" u ON u.id = m.user_id
     LEFT JOIN profiles p ON p.user_id = u.id
     GROUP BY e.tenant_id
     ORDER BY last_event_at DESC LIMIT ?`,
    [MAX_CUSTOMERS],
  );
  const all = rows.map((row) => toCustomer(row, now));

  const since = new Date(now - 30 * DAY).toISOString();
  const cohort = rows.filter((row) => row.signed_up_at && row.signed_up_at >= since);
  const reached: Record<CrmStage, (row: AggregateRow) => boolean> = {
    signed_up: () => true,
    first_success: (row) => Boolean(row.first_success_at),
    checkout_started: (row) => Boolean(row.last_checkout_at),
    paid: (row) => Boolean(row.first_paid_at),
  };
  const funnel = crmStages.map((stage) => ({ stage, count: cohort.filter(reached[stage]).length }));

  const needle = filter.q?.trim().toLowerCase();
  const items = all.filter(
    (row) =>
      (!filter.stage || row.stage === filter.stage) &&
      (!filter.stuck || row.stuck) &&
      (!filter.abandoned || row.abandonedCheckout) &&
      (!needle || row.email.toLowerCase().includes(needle) || row.name.toLowerCase().includes(needle)),
  );
  return {
    items,
    total: items.length,
    funnel,
    stuckTotal: all.filter((row) => row.stuck).length,
    abandonedTotal: all.filter((row) => row.abandonedCheckout).length,
    capped: rows.length >= MAX_CUSTOMERS,
  };
}

export interface CustomerTimeline {
  customer: CustomerRow;
  events: Array<{ step: string; label: string; detail: Record<string, unknown>; occurredAt: string }>;
}

export async function customerTimeline(db: Db, tenantId: string, now = Date.now()): Promise<CustomerTimeline | null> {
  const { items } = await listCustomers(db, {}, now);
  const customer = items.find((row) => row.tenantId === tenantId);
  if (!customer) return null;
  const events = await db.all<{ step: string; detail: string; occurred_at: string }>(
    "SELECT step, detail, occurred_at FROM crm_events WHERE tenant_id = ? ORDER BY occurred_at DESC, rowid DESC LIMIT 200",
    [tenantId],
  );
  return {
    customer,
    events: events.map((event) => ({
      step: event.step,
      label: stepLabels[event.step] ?? event.step,
      detail: JSON.parse(event.detail) as Record<string, unknown>,
      occurredAt: event.occurred_at,
    })),
  };
}

export interface UsageStats {
  from: string;
  to: string;
  signups: number;
  checkouts: number;
  purchases: number;
  revenueCents: number;
}

export interface UsageReport {
  stats: UsageStats;
  /** What the product itself reports for the same window (jobs, minutes, pages, errors). */
  product: CrmProductUsage;
}

/** Sign-ups and money inside `[fromMs, toMs)` plus the product's own usage. Counts only, never content. */
export async function usageReport(db: Db, fromMs: number, toMs: number): Promise<UsageReport> {
  const from = new Date(fromMs).toISOString();
  const to = new Date(toMs).toISOString();
  const range = [from, to];
  const [signups, checkouts, purchases, product] = await Promise.all([
    db.first<{ n: number }>("SELECT COUNT(*) AS n FROM memberships WHERE created_at >= ? AND created_at < ?", range),
    db.first<{ n: number }>("SELECT COUNT(*) AS n FROM payments WHERE created_at >= ? AND created_at < ?", range),
    db.first<{ n: number; cents: number | null }>(
      "SELECT COUNT(*) AS n, SUM(amount_cents) AS cents FROM payments WHERE paid_at >= ? AND paid_at < ?",
      range,
    ),
    crmConfig().usage(db, fromMs, toMs),
  ]);
  return {
    stats: {
      from,
      to,
      signups: signups?.n ?? 0,
      checkouts: checkouts?.n ?? 0,
      purchases: purchases?.n ?? 0,
      revenueCents: purchases?.cents ?? 0,
    },
    product,
  };
}

// ---- Operator emails -------------------------------------------------------------------------

const recipients = (env: PlatformEnv): string[] =>
  (env.SALES_ALERT_EMAIL || env.ADMIN_EMAILS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

export function formatMoney(cents: number, currency = "USD"): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

/** `dd/mm HH:mm` in Asia/Ho_Chi_Minh, the operator's clock. */
export function ictTime(ms: number): string {
  const shifted = new Date(ms + 7 * HOUR).toISOString();
  return `${shifted.slice(8, 10)}/${shifted.slice(5, 7)} ${shifted.slice(11, 16)}`;
}

/** Claims `key` once; false when an earlier run (or a webhook replay) already did. */
async function claim(db: Db, key: string, now: number): Promise<boolean> {
  const result = await db.run("INSERT OR IGNORE INTO crm_notices (key, sent_at) VALUES (?, ?)", [
    key,
    new Date(now).toISOString(),
  ]);
  return result.changes === 1;
}

interface Notice {
  subject: string;
  heading: string;
  lines: string[];
  url?: string;
  action?: string;
}

/**
 * The outbox row is written before delivery, so a provider outage leaves a failed row that the
 * daily sweep retries; the claim is therefore never released after a failed send.
 */
async function mailOperators(env: PlatformEnv, db: Db, to: string[], notice: Notice): Promise<void> {
  for (const address of to) {
    await sendTransactionalEmail(env, db, {
      to: address,
      locale: "vi",
      template: "ops_notice",
      data: {
        subject: notice.subject,
        heading: notice.heading,
        lines: notice.lines.join("\n"),
        ...(notice.url ? { url: notice.url, action: notice.action ?? "Xem trong Admin" } : {}),
        footnote: "Thông báo cho quản trị viên. Mỗi sự kiện chỉ gửi một lần.",
      },
    }).catch((error) => {
      console.error(
        JSON.stringify({ evt: "crm_email_failed", error: error instanceof Error ? error.message.slice(0, 200) : "?" }),
      );
    });
  }
}

const customerUrl = (env: PlatformEnv, tenantId: string) =>
  `${env.APP_ORIGIN}/admin/customers/?customer=${encodeURIComponent(tenantId)}`;

async function describePayment(env: PlatformEnv, db: Db, payment: PaymentRow) {
  const customer = await db.first<{ email: string; name: string }>(
    `SELECT u.email AS email, COALESCE(NULLIF(p.display_name, ''), u.name) AS name
     FROM memberships m JOIN "user" u ON u.id = m.user_id LEFT JOIN profiles p ON p.user_id = u.id
     WHERE m.tenant_id = ? LIMIT 1`,
    [payment.tenant_id],
  );
  const paidBefore = await db.first<{ n: number }>(
    "SELECT COUNT(*) AS n FROM payments WHERE tenant_id = ? AND paid_at IS NOT NULL AND id != ?",
    [payment.tenant_id, payment.id],
  );
  const pack = packById(payment.pack_id);
  return {
    who: customer ? `${customer.name} (${customer.email})` : `tenant ${payment.tenant_id}`,
    packLabel: pack ? `${pack.name.vi} · ${pack.credits} credit` : `${payment.pack_id} · ${payment.credits} credit`,
    amount: formatMoney(payment.amount_cents, payment.currency),
    paidBefore: paidBefore?.n ?? 0,
    url: customerUrl(env, payment.tenant_id),
  };
}

/** The customer pressed buy: a checkout session now exists for `payment`. */
export async function notifyCheckoutStarted(env: PlatformEnv, db: Db, payment: PaymentRow): Promise<void> {
  const to = recipients(env);
  if (to.length === 0 || !(await claim(db, `checkout:${payment.id}`, Date.now()))) return;
  const info = await describePayment(env, db, payment);
  await mailOperators(env, db, to, {
    subject: `Khách bấm mua ${info.amount} · ${info.packLabel}`,
    heading: "Có khách vừa bấm mua",
    lines: [
      `Khách hàng: ${info.who}`,
      `Gói: ${info.packLabel}`,
      `Số tiền: ${info.amount}`,
      `Cổng thanh toán: ${payment.provider}`,
      info.paidBefore > 0 ? `Khách này đã mua ${info.paidBefore} lần trước đó.` : "Khách này chưa từng mua.",
      "Đơn chưa thanh toán. Nếu khách hoàn tất, bạn sẽ nhận thêm một email Khách đã mua.",
    ],
    url: info.url,
    action: "Xem hành trình khách hàng",
  });
}

/** The payment was granted: credits were added and the money is confirmed. */
export async function notifyPurchase(env: PlatformEnv, db: Db, payment: PaymentRow): Promise<void> {
  const to = recipients(env);
  if (to.length === 0 || !(await claim(db, `purchase:${payment.id}`, Date.now()))) return;
  const info = await describePayment(env, db, payment);
  const first = info.paidBefore === 0;
  await mailOperators(env, db, to, {
    subject: `${first ? "Khách mới mua" : "Khách đã mua"} ${info.amount} · ${info.packLabel}`,
    heading: first ? "Khách vừa thanh toán lần đầu" : "Khách vừa mua thêm",
    lines: [
      `Khách hàng: ${info.who}`,
      `Gói: ${info.packLabel}`,
      `Số tiền: ${info.amount}`,
      `Cổng thanh toán: ${payment.provider}`,
      first ? "Đây là lần mua đầu tiên của khách." : `Đây là lần mua thứ ${info.paidBefore + 1}.`,
    ],
    url: info.url,
    action: "Xem hành trình khách hàng",
  });
}

/** `label count, label count` for a top-N list, in the operator's language. */
export const rank = (rows: Array<{ label: string; count: number }>) =>
  rows.length ? rows.map((row) => `${row.label} ${row.count}`).join(", ") : "không có";

/** Report lines for one usage window, in the operator's language. */
export function usageLines(report: UsageReport, stuck: number, abandoned: number): string[] {
  const { stats } = report;
  const from = ictTime(Date.parse(stats.from));
  const to = ictTime(Date.parse(stats.to));
  return [
    `Khung giờ: ${from} đến ${to} (giờ Việt Nam).`,
    ...report.product.lines,
    `Đăng ký mới: ${stats.signups}.`,
    `Bấm mua: ${stats.checkouts}. Đã mua: ${stats.purchases} (${formatMoney(stats.revenueCents)}).`,
    `Khách đang kẹt trước khi mua: ${stuck}, trong đó bỏ dở thanh toán: ${abandoned}.`,
  ];
}

/**
 * Emails the usage of the last full 6-hour block (aligned to 00/06/12/18 UTC). The block's end
 * is the claim key, so any extra cron tick or retry for the same block is a no-op.
 */
export async function runUsageDigest(env: PlatformEnv, db: Db, scheduledMs = Date.now()): Promise<boolean> {
  const to = recipients(env);
  if (to.length === 0) return false;
  const end = Math.floor(scheduledMs / USAGE_WINDOW_MS) * USAGE_WINDOW_MS;
  if (!(await claim(db, `usage:${new Date(end).toISOString()}`, scheduledMs))) return false;
  await reconcileCrm(db);
  const [report, customers] = await Promise.all([
    usageReport(db, end - USAGE_WINDOW_MS, end),
    listCustomers(db, {}, scheduledMs),
  ]);
  await mailOperators(env, db, to, {
    subject: `Lượt dùng 6 giờ qua: ${report.product.headline}, ${report.stats.purchases} đơn mua`,
    heading: "Thống kê lượt dùng 6 giờ qua",
    lines: usageLines(report, customers.stuckTotal, customers.abandonedTotal),
    url: `${env.APP_ORIGIN}/admin/customers/`,
    action: "Mở danh sách khách hàng",
  });
  return true;
}
