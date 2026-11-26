import type { Db } from "./db";
import { sendTransactionalEmail } from "./emails/send";
import type { EmailTemplate } from "./emails/templates";
import { HttpError } from "./http";
import { takeRateLimit } from "./rate-limit";
import type { PlatformEnv } from "./types";

/**
 * Operator alerting. One JSON line for Workers Observability plus a throttled email — one per
 * kind per hour by default, or the budget the caller asks for. Detail must only ever contain
 * ids and amounts — never payloads, secrets or card data.
 */
export interface AlertThrottle {
  /** Emails allowed inside the window. */
  limit: number;
  /** Fixed window in seconds, aligned to epoch multiples like every other rate limit. */
  windowSeconds: number;
  /** Shared budget key; alerts that name the same bucket draw from one budget. Defaults to the kind. */
  bucket?: string;
}

/**
 * A worker outage is one long, self-evident condition however many symptoms it shows (no primary,
 * no worker at all, an ageing queue), so all of them share three emails per twelve hours.
 */
export const WORKER_OFFLINE_THROTTLE: AlertThrottle = {
  limit: 3,
  windowSeconds: 12 * 60 * 60,
  bucket: "worker_offline",
};

export interface BillingAlert {
  kind: string;
  summary: string;
  detail: Record<string, unknown>;
  /** Email budget for this kind; defaults to one per hour. */
  throttle?: AlertThrottle;
  /** Optional template and data for non-billing operator alerts (worker health). */
  template?: EmailTemplate;
  emailData?: Record<string, string | number>;
}

const DEFAULT_THROTTLE: AlertThrottle = { limit: 1, windowSeconds: 3600 };

export async function alertOperators(env: PlatformEnv, db: Db, alert: BillingAlert): Promise<{ emailed: boolean }> {
  console.error(JSON.stringify({ evt: "billing_alert", kind: alert.kind, summary: alert.summary }));
  const recipients = (env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (recipients.length === 0) return { emailed: false };

  const throttle = alert.throttle ?? DEFAULT_THROTTLE;
  try {
    await takeRateLimit(db, `alert:${throttle.bucket ?? alert.kind}`, throttle.limit, throttle.windowSeconds);
  } catch (error) {
    if (error instanceof HttpError && error.status === 429) return { emailed: false };
    throw error;
  }

  const detail = Object.entries(alert.detail)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
  for (const recipient of recipients) {
    try {
      await sendTransactionalEmail(env, db, {
        to: recipient,
        locale: "en",
        template: alert.template ?? "billing_alert",
        data: alert.emailData ?? { kind: alert.kind, summary: alert.summary, detail },
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          evt: "billing_alert_email_failed",
          kind: alert.kind,
          error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
        }),
      );
    }
  }
  return { emailed: true };
}
