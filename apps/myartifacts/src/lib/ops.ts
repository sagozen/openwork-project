import { alertOperators } from "@templatedesign/platform/alerts";
import type { Db } from "@templatedesign/platform/db";
import { d1Db, id as newId } from "@templatedesign/platform/db";
import { retryFailedEmails } from "@templatedesign/platform/emails/send";
import { PENDING_MAX_AGE_MS } from "./artifacts/service";
import { type Storage, storageFromEnv } from "./storage/s3";
import type { Env } from "./types";

/**
 * Cleanup and reporting that spans every account. The queries here deliberately have no tenant
 * predicate: they remove what has expired or been abandoned, and total the service for its
 * operator. Nothing here reads file content or returns a file name.
 */

/** Rows handled per category in one hourly run; a larger backlog drains over the following runs. */
export const SWEEP_BATCH = 500;
/** Storage calls in flight at once while sweeping. */
const CONCURRENCY = 10;
/** Sweep history is kept this long, for the overview and the digest. */
const SWEEP_HISTORY_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface SweepDeps {
  db: Db;
  storage: Storage;
  now?: () => Date;
  batchSize?: number;
}

export interface SweepResult {
  expired_deleted: number;
  pending_deleted: number;
  bytes_freed: number;
  storage_errors: number;
  /** A category hit the batch size, so more is waiting for the next run. */
  more: boolean;
}

interface DueRow {
  id: string;
  tenant_id: string;
  object_key: string;
  size: number | null;
}

/**
 * Removes the object of each due row, then marks the row deleted and takes it out of every share.
 * A storage failure leaves that row untouched, so the next run tries it again.
 */
async function removeRows(
  db: Db,
  storage: Storage,
  rows: DueRow[],
  status: "ready" | "pending",
  at: string,
): Promise<{ removed: number; bytes: number; errors: number }> {
  let removed = 0;
  let bytes = 0;
  let errors = 0;
  for (let start = 0; start < rows.length; start += CONCURRENCY) {
    const chunk = rows.slice(start, start + CONCURRENCY);
    const outcomes = await Promise.all(
      chunk.map(async (row) => {
        try {
          // Deleting an object that is not there is not an error, so an upload that never arrived is fine.
          await storage.deleteObject(row.object_key);
        } catch (error) {
          console.error(
            JSON.stringify({
              evt: "sweep_storage_error",
              id: row.id,
              error: error instanceof Error ? error.message : "unknown",
            }),
          );
          return false;
        }
        await db.batch([
          {
            sql: "UPDATE artifacts SET status = 'deleted', deleted_at = ? WHERE id = ? AND tenant_id = ? AND status = ?",
            params: [at, row.id, row.tenant_id, status],
          },
          { sql: "DELETE FROM share_items WHERE artifact_id = ? AND tenant_id = ?", params: [row.id, row.tenant_id] },
        ]);
        return true;
      }),
    );
    chunk.forEach((row, index) => {
      if (outcomes[index]) {
        removed += 1;
        bytes += row.size ?? 0;
      } else {
        errors += 1;
      }
    });
  }
  return { removed, bytes, errors };
}

/**
 * The hourly pass: deletes ready files whose expiry has passed, and uploads that were created but
 * never completed within 24 hours (together with their object, if one was ever PUT). At most
 * `batchSize` of each per run. Repeating it is harmless: a finished row is not selected again.
 */
export async function sweepArtifacts(deps: SweepDeps): Promise<SweepResult> {
  const now = (deps.now ?? (() => new Date()))();
  const at = now.toISOString();
  const limit = deps.batchSize ?? SWEEP_BATCH;

  const expired = await deps.db.all<DueRow>(
    `SELECT id, tenant_id, object_key, size FROM artifacts
     WHERE status = 'ready' AND expires_at IS NOT NULL AND expires_at <= ? ORDER BY expires_at LIMIT ?`,
    [at, limit],
  );
  const abandoned = await deps.db.all<DueRow>(
    `SELECT id, tenant_id, object_key, size FROM artifacts
     WHERE status = 'pending' AND created_at <= ? ORDER BY created_at LIMIT ?`,
    [new Date(now.getTime() - PENDING_MAX_AGE_MS).toISOString(), limit],
  );

  const first = await removeRows(deps.db, deps.storage, expired, "ready", at);
  const second = await removeRows(deps.db, deps.storage, abandoned, "pending", at);
  const result: SweepResult = {
    expired_deleted: first.removed,
    pending_deleted: second.removed,
    bytes_freed: first.bytes + second.bytes,
    storage_errors: first.errors + second.errors,
    more: expired.length >= limit || abandoned.length >= limit,
  };
  await deps.db.run(
    `INSERT INTO sweep_runs (id, ran_at, expired_deleted, pending_deleted, bytes_freed, storage_errors)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [newId("swp"), at, result.expired_deleted, result.pending_deleted, result.bytes_freed, result.storage_errors],
  );
  return result;
}

/** Every hour. */
export async function runHourlyCron(env: Env, now?: () => Date): Promise<SweepResult> {
  return sweepArtifacts({ db: d1Db(env.DB), storage: storageFromEnv(env), now });
}

/* ------------------------------------------------------------------ reporting */

export interface SweepRow {
  ran_at: string;
  expired_deleted: number;
  pending_deleted: number;
  bytes_freed: number;
  storage_errors: number;
}

export interface Overview {
  files: number;
  bytes: number;
  pending_uploads: number;
  active_shares: number;
  last_sweep: SweepRow | null;
}

/** Service-wide totals for the admin overview. Ready files that have expired are not counted. */
export async function adminOverview(db: Db, now: Date = new Date()): Promise<Overview> {
  const at = now.toISOString();
  const [stored, pending, shares, last] = await Promise.all([
    db.first<{ files: number; bytes: number }>(
      "SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes FROM artifacts WHERE status = 'ready' AND (expires_at IS NULL OR expires_at > ?)",
      [at],
    ),
    db.first<{ n: number }>("SELECT COUNT(*) AS n FROM artifacts WHERE status = 'pending'"),
    db.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM shares WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)",
      [at],
    ),
    db.first<SweepRow>(
      "SELECT ran_at, expired_deleted, pending_deleted, bytes_freed, storage_errors FROM sweep_runs ORDER BY ran_at DESC LIMIT 1",
    ),
  ]);
  return {
    files: stored?.files ?? 0,
    bytes: stored?.bytes ?? 0,
    pending_uploads: pending?.n ?? 0,
    active_shares: shares?.n ?? 0,
    last_sweep: last ?? null,
  };
}

export interface DailyDigest extends Overview {
  /** Uploads finished in the last 24 hours (some may already be deleted again). */
  files_added: number;
  sweeps: number;
  expired_deleted: number;
  pending_deleted: number;
  bytes_freed: number;
  storage_errors: number;
}

export async function buildDigest(db: Db, now: Date = new Date()): Promise<DailyDigest> {
  const since = new Date(now.getTime() - DAY_MS).toISOString();
  const [overview, added, sweep] = await Promise.all([
    adminOverview(db, now),
    db.first<{ n: number }>("SELECT COUNT(*) AS n FROM artifacts WHERE completed_at >= ?", [since]),
    db.first<{
      runs: number;
      expired: number;
      pending: number;
      freed: number;
      errors: number;
    }>(
      `SELECT COUNT(*) AS runs, COALESCE(SUM(expired_deleted), 0) AS expired, COALESCE(SUM(pending_deleted), 0) AS pending,
              COALESCE(SUM(bytes_freed), 0) AS freed, COALESCE(SUM(storage_errors), 0) AS errors
       FROM sweep_runs WHERE ran_at >= ?`,
      [since],
    ),
  ]);
  return {
    ...overview,
    files_added: added?.n ?? 0,
    sweeps: sweep?.runs ?? 0,
    expired_deleted: sweep?.expired ?? 0,
    pending_deleted: sweep?.pending ?? 0,
    bytes_freed: sweep?.freed ?? 0,
    storage_errors: sweep?.errors ?? 0,
  };
}

/** Once a day (03:20 UTC): prune sweep history, retry failed emails and email the operators the totals. */
export async function runDailyCron(env: Env, now: Date = new Date()) {
  const db = d1Db(env.DB);
  await db.run("DELETE FROM sweep_runs WHERE ran_at < ?", [
    new Date(now.getTime() - SWEEP_HISTORY_DAYS * DAY_MS).toISOString(),
  ]);
  const emails = await retryFailedEmails(env, db);
  const digest = await buildDigest(db, now);
  const mb = (bytes: number) => Math.round((bytes / (1024 * 1024)) * 10) / 10;
  const alert = await alertOperators(env, db, {
    kind: "myartifacts_daily_digest",
    summary: `${digest.files} files, ${mb(digest.bytes)} MB stored; ${digest.files_added} added in 24 hours`,
    detail: {
      files: digest.files,
      mb_stored: mb(digest.bytes),
      files_added_24h: digest.files_added,
      active_shares: digest.active_shares,
      pending_uploads: digest.pending_uploads,
      sweeps_24h: digest.sweeps,
      expired_files_deleted_24h: digest.expired_deleted,
      abandoned_uploads_deleted_24h: digest.pending_deleted,
      mb_freed_24h: mb(digest.bytes_freed),
      storage_errors_24h: digest.storage_errors,
    },
  });
  return { digest, emails, emailed: alert.emailed };
}
