import { alertOperators, WORKER_OFFLINE_THROTTLE } from "@templatedesign/platform/alerts";
import { d1Db } from "@templatedesign/platform/db";
import { purgeDueDeletions } from "@templatedesign/platform/deletion";
import { retryFailedEmails } from "@templatedesign/platform/emails/send";
import { runReconciliation } from "@templatedesign/platform/reconcile";
import { retryDueWebhookDeliveries } from "@templatedesign/platform/webhooks";
import { expireStalePreviews, requeueExpired } from "./jobs";
import { PRICING } from "./pricing";
import { deletePrefix } from "./r2-presign";
import type { Env } from "./types";
import { evaluateWorkerAlerts } from "./worker-alerts";
import { workerHealth } from "./workers";

/**
 * Cron bodies. The minute tick keeps the queue honest; the daily tick enforces retention,
 * retries deliveries and reconciles payments. Alerts reuse the platform email channel with a
 * rate limit of one per kind per hour, except worker-offline notices which share one budget of
 * three per twelve hours: an outage that lasts overnight should not mail the operator every hour.
 */

export interface MinuteCronResult {
  requeued: number;
  failed: number;
  expiredPreviews: number;
  alerts: string[];
}

export async function runMinuteCron(env: Env, now = Date.now()): Promise<MinuteCronResult> {
  const db = d1Db(env.DB);
  const requeue = await requeueExpired(db);
  const expiredPreviews = await expireStalePreviews(db);
  const health = await workerHealth(db);
  const alerts: string[] = [];

  // One outage, one message stream: with no worker at all the primary is missing too, and the
  // queue only ages because nobody is serving it, so only the most specific notice is sent.
  const lastPrimary = health.lastPrimaryAt ? Date.parse(health.lastPrimaryAt) : 0;
  const lastAny = health.lastAnyAt ? Date.parse(health.lastAnyAt) : 0;
  const noWorkers = now - lastAny > 2 * 60 * 1000;
  if (noWorkers) {
    await alertOperators(env, db, {
      kind: "transcript_no_workers",
      summary: "No worker of any tier has sent a heartbeat for 2 minutes.",
      detail: { last_heartbeat_at: health.lastAnyAt ?? "never" },
      throttle: WORKER_OFFLINE_THROTTLE,
    });
    alerts.push("no_workers");
  } else if (now - lastPrimary > 10 * 60 * 1000) {
    await alertOperators(env, db, {
      kind: "transcript_no_primary",
      summary: "No primary (home GPU) worker heartbeat for 10 minutes.",
      detail: { last_heartbeat_at: health.lastPrimaryAt ?? "never" },
      throttle: WORKER_OFFLINE_THROTTLE,
    });
    alerts.push("no_primary");
  }
  if (!noWorkers && health.queueAgeSeconds !== null && health.queueAgeSeconds > 15 * 60) {
    await alertOperators(env, db, {
      kind: "transcript_queue_age",
      summary: "The oldest queued transcription is older than 15 minutes.",
      detail: { queue_age_seconds: Math.round(health.queueAgeSeconds) },
    });
    alerts.push("queue_age");
  }
  const failures = await db.first<{ failures: number; total: number }>(
    `SELECT
       (SELECT COUNT(*) FROM transcription_jobs WHERE status = 'failed' AND created_at >= ?) AS failures,
       (SELECT COUNT(*) FROM transcription_jobs WHERE created_at >= ?) AS total`,
    [new Date(now - 60 * 60 * 1000).toISOString(), new Date(now - 60 * 60 * 1000).toISOString()],
  );
  if ((failures?.total ?? 0) >= 5 && (failures?.failures ?? 0) / (failures?.total ?? 1) > 0.2) {
    await alertOperators(env, db, {
      kind: "transcript_failure_rate",
      summary: "More than 20% of transcriptions in the last hour failed.",
      detail: { failures: failures?.failures ?? 0, total: failures?.total ?? 0 },
    });
    alerts.push("failure_rate");
  }

  // Host thresholds are evaluated last: a bug in alerting must not stop the requeue path.
  try {
    alerts.push(...(await evaluateWorkerAlerts(env, db, now)));
  } catch (error) {
    console.error(
      JSON.stringify({
        evt: "worker_alerts_failed",
        error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
      }),
    );
  }

  return { requeued: requeue.requeued, failed: requeue.failed, expiredPreviews, alerts };
}

export interface DailyCronResult {
  mediaDeleted: number;
  resultsDeleted: number;
  deletions: number;
  emails: number;
  webhooks: number;
  uploadedSessions: number;
  workerMetrics: number;
  reconciliation: { counts: Record<string, number>; skipped: string[] };
}

export async function runDailyCron(env: Env, now = Date.now()): Promise<DailyCronResult> {
  const db = d1Db(env.DB);
  const mediaCutoff = new Date(now - PRICING.mediaRetentionHours * 60 * 60 * 1000).toISOString();
  const resultCutoff = new Date(now - PRICING.resultRetentionDays * 24 * 60 * 60 * 1000).toISOString();

  const staleMedia = await db.all<{ id: string }>(
    "SELECT id FROM transcription_jobs WHERE created_at < ? AND (result_key IS NOT NULL OR status IN ('failed','cancelled','expired')) LIMIT 200",
    [mediaCutoff],
  );
  let mediaDeleted = 0;
  for (const job of staleMedia) mediaDeleted += await deletePrefix(env, "media", `media/${job.id}/`);

  const staleResults = await db.all<{ id: string }>(
    "SELECT id FROM transcription_jobs WHERE finished_at IS NOT NULL AND finished_at < ? AND result_key IS NOT NULL LIMIT 200",
    [resultCutoff],
  );
  let resultsDeleted = 0;
  for (const job of staleResults) resultsDeleted += await deletePrefix(env, "outputs", `results/${job.id}/`);
  if (staleResults.length > 0) {
    await db.batch(
      staleResults.map((job) => ({
        sql: "UPDATE transcription_jobs SET result_key = NULL, addons_json = NULL, updated_at = ? WHERE id = ?",
        params: [new Date().toISOString(), job.id],
      })),
    );
  }

  const uploadedSessions = await db.run(
    "UPDATE upload_sessions SET status = 'aborted' WHERE status = 'pending' AND expires_at < ?",
    [new Date().toISOString()],
  );

  // Minute metrics for 14 days are enough to explain a warning after the fact.
  const workerMetrics = await db.run("DELETE FROM worker_metrics WHERE sampled_at < ?", [
    new Date(now - 14 * 24 * 60 * 60 * 1000).toISOString(),
  ]);

  const [deletions, emails, webhooks, reconciliation] = await Promise.all([
    purgeDueDeletions(env, db, { delete: async () => {} }),
    retryFailedEmails(env, db),
    retryDueWebhookDeliveries(env, db),
    runReconciliation(env, db, new Date(now)),
  ]);

  return {
    mediaDeleted,
    resultsDeleted,
    deletions,
    emails,
    webhooks,
    uploadedSessions: uploadedSessions.changes,
    workerMetrics: workerMetrics.changes,
    reconciliation: { counts: reconciliation.counts, skipped: reconciliation.skipped },
  };
}
