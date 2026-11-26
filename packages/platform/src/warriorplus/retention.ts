import type { Db } from "../db";

export const IPN_PAYLOAD_RETENTION_DAYS = 400;
export const TEST_EVENT_RETENTION_DAYS = 7;
export const STALE_PENDING_MINUTES = 2;
export const MAX_EVENT_ATTEMPTS = 5;

/**
 * Events the five-minute cron should try again: a failed event, or a pending event that has not
 * finished within two minutes (the Worker was evicted mid-handler). WarriorPlus never retries, so
 * this sweep and a manual resend are the recovery paths.
 */
export async function staleEventIds(db: Db, app: string, limit = 50): Promise<string[]> {
  const cutoff = new Date(Date.now() - STALE_PENDING_MINUTES * 60_000).toISOString();
  const rows = await db.all<{ ipn_id: string }>(
    `SELECT ipn_id FROM wp_ipn_events
      WHERE app = ? AND attempts < ? AND (status = 'failed' OR (status = 'pending' AND received_at < ?))
      ORDER BY received_at LIMIT ?`,
    [app, MAX_EVENT_ATTEMPTS, cutoff, limit],
  );
  return rows.map((row) => row.ipn_id);
}

/** Payload retention: keep the event ids and outcomes, drop the buyer PII after 400 days. */
export async function purgeIpnPayloads(
  db: Db,
  app: string,
  days = IPN_PAYLOAD_RETENTION_DAYS,
): Promise<{ events: number; testEvents: number }> {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const events = await db.run(
    "UPDATE wp_ipn_events SET payload='{}' WHERE app=? AND received_at < ? AND payload <> '{}'",
    [app, cutoff],
  );
  const testCutoff = new Date(Date.now() - TEST_EVENT_RETENTION_DAYS * 86_400_000).toISOString();
  const testEvents = await db.run("DELETE FROM wp_ipn_test_events WHERE app=? AND received_at < ?", [app, testCutoff]);
  await db.run("DELETE FROM wp_resend_log WHERE app=? AND sent_at < ?", [app, cutoff]);
  return { events: events.changes, testEvents: testEvents.changes };
}

/** A Club row past its paid period with no renewal is ended by the daily cron. */
export async function expireCancelledSubscriptions(db: Db, app: string): Promise<string[]> {
  const now = new Date().toISOString();
  const rows = await db.all<{ tenant_id: string | null; id: string }>(
    `SELECT id, tenant_id FROM wp_purchases
      WHERE app=? AND kind='recurring' AND status IN ('cancelled','suspended')
        AND current_period_end IS NOT NULL AND current_period_end < ?`,
    [app, now],
  );
  for (const row of rows) {
    await db.run("UPDATE wp_purchases SET status='ended', updated_at=? WHERE id=?", [now, row.id]);
  }
  return [...new Set(rows.map((row) => row.tenant_id).filter((value): value is string => Boolean(value)))];
}

/** A daily pass that closes stale test windows even if nobody pressed Close. */
export async function closeExpiredTestWindows(db: Db, app: string): Promise<void> {
  await db.run("DELETE FROM wp_test_window WHERE app=? AND until < ?", [app, new Date().toISOString()]);
}
