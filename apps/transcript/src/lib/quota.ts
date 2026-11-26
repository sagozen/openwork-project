import type { Db } from "@templatedesign/platform/db";
import { HttpError } from "@templatedesign/platform/http";
import { PRICING } from "./pricing";

/** `YYYY-MM` in UTC, the month bucket the cap is counted in. */
export function monthKey(date = new Date()): string {
  return date.toISOString().slice(0, 7);
}

export function dayKey(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export interface CapState {
  month: string;
  used: number;
  cap: number;
  remaining: number;
}

export async function capState(db: Db, tenantId: string, cap: number): Promise<CapState> {
  const month = monthKey();
  const row = await db.first<{ minutes_used: number }>(
    "SELECT minutes_used FROM minute_usage WHERE tenant_id = ? AND month = ?",
    [tenantId, month],
  );
  const used = row?.minutes_used ?? 0;
  return { month, used, cap, remaining: Math.max(0, cap - used) };
}

/**
 * Reserves covered minutes before the job is queued. The conditional UPDATE is the cap
 * enforcement: two concurrent reservations can never push `minutes_used` above `cap`.
 * Returns false instead of throwing so the caller can fail the job with a typed error.
 */
export async function reserveMinutes(db: Db, tenantId: string, minutes: number, cap: number): Promise<boolean> {
  if (minutes <= 0) return true;
  const month = monthKey();
  await db.run("INSERT OR IGNORE INTO minute_usage (tenant_id, month, minutes_used) VALUES (?, ?, 0)", [
    tenantId,
    month,
  ]);
  const result = await db.run(
    "UPDATE minute_usage SET minutes_used = minutes_used + ? WHERE tenant_id = ? AND month = ? AND minutes_used + ? <= ?",
    [minutes, tenantId, month, minutes, cap],
  );
  return result.changes === 1;
}

export async function releaseMinutes(db: Db, tenantId: string, minutes: number): Promise<void> {
  if (minutes <= 0) return;
  await db.run("UPDATE minute_usage SET minutes_used = MAX(0, minutes_used - ?) WHERE tenant_id = ? AND month = ?", [
    minutes,
    tenantId,
    monthKey(),
  ]);
}

export type FreeScope = "transcribe" | "captions";

/**
 * Counts one free job against the daily allowance. Scope `captions` is separate so fetching
 * existing captions never consumes the free-transcription quota (phase 6).
 */
export async function takeFreeJob(
  db: Db,
  subjectId: string,
  scope: FreeScope,
  limit: number,
): Promise<{ ok: true; used: number } | { ok: false; used: number; limit: number }> {
  const day = dayKey();
  await db.run("INSERT OR IGNORE INTO free_job_usage (subject_id, day, scope, jobs_used) VALUES (?, ?, ?, 0)", [
    subjectId,
    day,
    scope,
  ]);
  const result = await db.run(
    "UPDATE free_job_usage SET jobs_used = jobs_used + 1 WHERE subject_id = ? AND day = ? AND scope = ? AND jobs_used + 1 <= ?",
    [subjectId, day, scope, limit],
  );
  const row = await db.first<{ jobs_used: number }>(
    "SELECT jobs_used FROM free_job_usage WHERE subject_id = ? AND day = ? AND scope = ?",
    [subjectId, day, scope],
  );
  const used = row?.jobs_used ?? 0;
  if (result.changes === 0) return { ok: false, used, limit };
  return { ok: true, used };
}

export async function releaseFreeJob(db: Db, subjectId: string, scope: FreeScope): Promise<void> {
  await db.run(
    "UPDATE free_job_usage SET jobs_used = MAX(0, jobs_used - 1) WHERE subject_id = ? AND day = ? AND scope = ?",
    [subjectId, dayKey(), scope],
  );
}

export async function freeJobsUsedToday(db: Db, subjectId: string): Promise<number> {
  const row = await db.first<{ jobs_used: number }>(
    "SELECT jobs_used FROM free_job_usage WHERE subject_id = ? AND day = ? AND scope = 'transcribe'",
    [subjectId, dayKey()],
  );
  return row?.jobs_used ?? 0;
}

/** Minutes of free work already accepted today, used by the free-queue guard. */
export async function freeMinutesAcceptedToday(db: Db): Promise<number> {
  const row = await db.first<{ minutes: number }>(
    `SELECT COALESCE(SUM(billable_minutes), 0) AS minutes FROM transcription_jobs
     WHERE free = 1 AND options_json NOT LIKE '%"use_creator_captions":true%' AND created_at >= ? AND status NOT IN ('cancelled', 'failed', 'expired')`,
    [`${dayKey()}T00:00:00.000Z`],
  );
  return row?.minutes ?? 0;
}

export function quotaError(code: "monthly_cap_reached" | "free_queue_saturated", locale: "en" | "vi"): HttpError {
  if (code === "monthly_cap_reached") {
    return new HttpError(
      "quota_exceeded",
      402,
      locale === "vi"
        ? "Đã đạt hạn mức phút hàng tháng của tài khoản."
        : "This account has reached its monthly minute cap.",
      { limit: "monthly_minutes" },
    );
  }
  return new HttpError(
    "quota_exceeded",
    429,
    locale === "vi"
      ? "Hàng đợi miễn phí đang đầy. Thử lại sau hoặc mua credit để ưu tiên."
      : "The free queue is busy. Try again later, or buy credits to skip the queue.",
    { limit: "free_queue" },
  );
}

export const DEFAULT_FREE_LIMITS = PRICING.freeJobsPerDay;
