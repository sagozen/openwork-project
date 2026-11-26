import { getAdminSettingValue } from "@templatedesign/platform/admin";
import { ensureWallet, planSettlement, releaseCredits, reserveCredits } from "@templatedesign/platform/credits";
import type { Db, Statement } from "@templatedesign/platform/db";
import { id, nowIso } from "@templatedesign/platform/db";
import { HttpError } from "@templatedesign/platform/http";
import {
  freeQueueBudget,
  type JobOptions,
  monthlyCapMinutes,
  PRICING,
  type Quote,
  quoteJob,
  transcriptionPaused,
} from "./pricing";
import {
  freeMinutesAcceptedToday,
  quotaError,
  releaseFreeJob,
  releaseMinutes,
  reserveMinutes,
  takeFreeJob,
} from "./quota";
import { deletePrefix, getJson, putJson, resultKey } from "./r2-presign";
import { type ClassifiedSource, killSwitchKey, type SourceKind } from "./sources";
import {
  type AddonState,
  buildSrt,
  buildVtt,
  type NormalizedTranscript,
  type StoredTranscript,
  transcriptStats,
} from "./transcripts";
import type { Env } from "./types";

export type JobStatus =
  | "queued"
  | "leased"
  | "preview_ready"
  | "awaiting_confirmation"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired";

export type JobStage = "probe" | "transcribe" | "addons";

export interface JobRow {
  id: string;
  tenant_id: string | null;
  guest_id: string | null;
  batch_id: string | null;
  source_kind: string;
  source_ref: string;
  source_meta_json: string;
  stage: JobStage;
  status: JobStatus;
  options_json: string;
  title: string | null;
  preview: number;
  via_api: number;
  confirm_above: number | null;
  duration_seconds: number | null;
  billable_minutes: number | null;
  free: number;
  pricing_state: "pending" | "free" | "reserved" | "settled" | "released";
  reserved_credits: number;
  charged_credits: number;
  attempts: number;
  leased_by: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  queued_at: string;
  started_at: string | null;
  finished_at: string | null;
  result_key: string | null;
  result_formats_json: string | null;
  addons_json: string | null;
  error_code: string | null;
  error_detail: string | null;
  idempotency_key: string | null;
  settlement_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface SourceMeta {
  title?: string;
  thumbnail?: string;
  hasCreatorCaptions?: boolean;
  sizeBytes?: number;
  items?: Array<{ url: string; title?: string; durationSeconds?: number; sizeBytes?: number }>;
  sourceError?: string;
  language?: string;
  model?: string;
}

export interface JobView {
  id: string;
  status: JobStatus;
  stage: JobStage;
  sourceKind: string;
  sourceRef: string;
  title: string | null;
  preview: boolean;
  durationSeconds: number | null;
  billableMinutes: number | null;
  free: boolean;
  credits: number;
  chargedCredits: number;
  breakdown: Quote["breakdown"] | null;
  createdAt: string;
  finishedAt: string | null;
  errorCode: string | null;
  errorDetail: string | null;
  hasResult: boolean;
  formats: string[];
  options: JobOptions;
  meta: SourceMeta;
  attempts: number;
  viaApi: boolean;
  addons: AddonState | null;
}

export function mapJob(row: JobRow): JobView {
  const options = parseJson<JobOptions>(row.options_json, {});
  const duration = row.duration_seconds ?? 0;
  const quote = duration > 0 ? quoteJob({ durationSeconds: duration, options, viaApi: row.via_api === 1 }) : null;
  return {
    id: row.id,
    status: row.status,
    stage: row.stage,
    sourceKind: row.source_kind,
    sourceRef: row.source_ref,
    title: row.title,
    preview: row.preview === 1,
    durationSeconds: row.duration_seconds,
    billableMinutes: row.billable_minutes,
    free: row.free === 1,
    credits: row.reserved_credits || row.charged_credits || quote?.credits || 0,
    chargedCredits: row.charged_credits,
    breakdown: quote?.breakdown ?? null,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    errorCode: row.error_code,
    errorDetail: row.error_detail,
    hasResult: Boolean(row.result_key),
    formats: parseJson<string[]>(row.result_formats_json, []),
    options,
    meta: parseJson<SourceMeta>(row.source_meta_json, {}),
    attempts: row.attempts,
    viaApi: row.via_api === 1,
    addons: parseJson<AddonState | null>(row.addons_json, null),
  };
}

function confirmAbove(value: number | null | undefined): number | null {
  if (value === undefined || value === null) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
}

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export interface CreateJobInput {
  tenantId: string | null;
  guestId: string | null;
  userId: string | null;
  viaApi: boolean;
  source:
    | ClassifiedSource
    | { kind: "upload"; ref: string; url: string; host: ""; multi: null; ytdlp: false; label: "upload" };
  options: JobOptions;
  title?: string | null;
  durationSeconds?: number | null;
  preview?: boolean;
  idempotencyKey?: string | null;
  batchId?: string | null;
  /** Paid jobs wait in `awaiting_confirmation` above this many credits (phase 6, step 5). */
  confirmAbove?: number | null;
}

export async function sourceEnabled(db: Db, kind: SourceKind): Promise<boolean> {
  if (kind === "upload") return true;
  const value = await getAdminSettingValue<boolean>(db, killSwitchKey(kind));
  return value !== false;
}

/**
 * YouTube links use the video's existing captions unless the caller opts out. Fetching them is
 * far cheaper and faster than transcribing; the worker falls back to Whisper when none exist.
 */
function usesCaptions(job: JobRow): boolean {
  return parseJson<JobOptions>(job.options_json, {}).use_creator_captions === true;
}

export function withCaptionDefault(options: JobOptions | undefined, kind: string): JobOptions {
  const base = options ?? {};
  if (kind !== "youtube" || base.use_creator_captions !== undefined) return base;
  return { ...base, use_creator_captions: true };
}

export async function createJob(env: Env, db: Db, input: CreateJobInput): Promise<{ job: JobRow; reused: boolean }> {
  if (await transcriptionPaused(db)) {
    throw new HttpError("dependency_unavailable", 503, "New transcriptions are paused right now.", {
      reason: "paused",
    });
  }
  if (input.idempotencyKey && input.tenantId) {
    const existing = await db.first<JobRow>(
      "SELECT * FROM transcription_jobs WHERE tenant_id = ? AND idempotency_key = ?",
      [input.tenantId, input.idempotencyKey],
    );
    if (existing) return { job: existing, reused: true };
  }
  if (!(await sourceEnabled(db, input.source.kind))) {
    throw new HttpError("invalid_input", 400, "This source is temporarily disabled.", { reason: "source_disabled" });
  }
  if (!input.tenantId && !input.guestId) throw new HttpError("invalid_input", 400, "Missing visitor id.");

  const options = withCaptionDefault(input.options, input.source.kind);
  const timestamp = nowIso();
  const jobId = id("trj");
  const knownDuration = typeof input.durationSeconds === "number" && input.durationSeconds > 0;
  // Whether captions exist decides the price, so a captions job is always probed first.
  const needsProbe = !knownDuration || options.use_creator_captions === true;
  const row: JobRow = {
    id: jobId,
    tenant_id: input.tenantId,
    guest_id: input.guestId,
    batch_id: input.batchId ?? null,
    source_kind: input.source.kind,
    source_ref: input.source.ref,
    source_meta_json: JSON.stringify({
      multi: "multi" in input.source ? input.source.multi : null,
      url: "url" in input.source ? input.source.url : null,
    }),
    stage: needsProbe ? "probe" : "transcribe",
    status: "queued",
    options_json: JSON.stringify(options),
    title: input.title ?? null,
    preview: input.preview ? 1 : 0,
    via_api: input.viaApi ? 1 : 0,
    confirm_above: confirmAbove(input.confirmAbove),
    duration_seconds: knownDuration ? Math.round(input.durationSeconds ?? 0) : null,
    billable_minutes: knownDuration ? Math.max(1, Math.ceil((input.durationSeconds ?? 0) / 60)) : null,
    free: 0,
    pricing_state: "pending",
    reserved_credits: 0,
    charged_credits: 0,
    attempts: 0,
    leased_by: null,
    lease_token: null,
    lease_expires_at: null,
    queued_at: timestamp,
    started_at: null,
    finished_at: null,
    result_key: null,
    result_formats_json: null,
    addons_json: null,
    error_code: null,
    error_detail: null,
    idempotency_key: input.idempotencyKey ?? null,
    settlement_id: null,
    created_at: timestamp,
    updated_at: timestamp,
  };
  await db.run(
    `INSERT INTO transcription_jobs
     (id, tenant_id, guest_id, batch_id, source_kind, source_ref, source_meta_json, stage, status, options_json, title, preview,
      via_api, confirm_above, duration_seconds, billable_minutes, free, pricing_state, reserved_credits, charged_credits, attempts, queued_at,
      idempotency_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'pending', 0, 0, 0, ?, ?, ?, ?)`,
    [
      row.id,
      row.tenant_id,
      row.guest_id,
      row.batch_id,
      row.source_kind,
      row.source_ref,
      row.source_meta_json,
      row.stage,
      row.status,
      row.options_json,
      row.title,
      row.preview,
      row.via_api,
      row.confirm_above,
      row.duration_seconds,
      row.billable_minutes,
      row.queued_at,
      row.idempotency_key,
      row.created_at,
      row.updated_at,
    ],
  );

  if (!needsProbe) {
    const priced = await priceAfterProbe(env, db, row, input.confirmAbove ?? null);
    return { job: priced, reused: false };
  }
  return { job: row, reused: false };
}

/** Result of a probe: duration, title, playlist/folder items and caption availability. */
export interface ProbeResult {
  durationSeconds: number;
  title?: string;
  thumbnail?: string;
  sizeBytes?: number;
  hasCreatorCaptions?: boolean;
  items?: Array<{ url: string; title?: string; durationSeconds?: number; sizeBytes?: number }>;
  language?: string;
}

/**
 * Applies probe output. For a preview job the row stops at `preview_ready`; for a real job
 * it prices the work and moves to `transcribe`, or to `awaiting_confirmation` above the
 * tenant's threshold.
 */
export async function recordProbe(
  env: Env,
  db: Db,
  job: JobRow,
  probe: ProbeResult,
  confirmAbove: number | null = null,
): Promise<JobRow> {
  const meta: SourceMeta = {
    title: probe.title ?? job.title ?? undefined,
    thumbnail: probe.thumbnail,
    sizeBytes: probe.sizeBytes,
    hasCreatorCaptions: probe.hasCreatorCaptions,
    items: probe.items,
  };
  const duration = Math.max(1, Math.round(probe.durationSeconds));
  await db.run(
    `UPDATE transcription_jobs SET duration_seconds = ?, billable_minutes = ?, title = COALESCE(?, title),
       source_meta_json = ?, updated_at = ? WHERE id = ?`,
    [duration, Math.max(1, Math.ceil(duration / 60)), probe.title ?? null, JSON.stringify(meta), nowIso(), job.id],
  );
  const fresh = {
    ...job,
    duration_seconds: duration,
    billable_minutes: Math.max(1, Math.ceil(duration / 60)),
    source_meta_json: JSON.stringify(meta),
  };
  if (job.preview === 1) {
    await db.run("UPDATE transcription_jobs SET status = 'preview_ready', updated_at = ? WHERE id = ?", [
      nowIso(),
      job.id,
    ]);
    return { ...fresh, status: "preview_ready" };
  }
  if (probe.items && probe.items.length > 0) {
    await db.run("UPDATE transcription_jobs SET status = 'preview_ready', updated_at = ? WHERE id = ?", [
      nowIso(),
      job.id,
    ]);
    return { ...fresh, status: "preview_ready" };
  }
  return priceAfterProbe(env, db, fresh, confirmAbove);
}

/**
 * Prices the job and either queues it (free or reserved) or parks it in
 * `awaiting_confirmation`. Free jobs still pay the minute reservation: their minutes count
 * against the monthly cap only when the job is paid, so free jobs skip `minute_usage`.
 */
export async function priceAfterProbe(env: Env, db: Db, job: JobRow, confirmAbove: number | null): Promise<JobRow> {
  const options = parseJson<JobOptions>(job.options_json, {});
  const duration = job.duration_seconds ?? 0;
  if (duration <= 0) throw new Error("priceAfterProbe needs a duration");
  if (options.use_creator_captions && !parseJson<SourceMeta>(job.source_meta_json, {}).hasCreatorCaptions) {
    // No captions to fetch: price and run it as a normal transcription.
    options.use_creator_captions = false;
    job = { ...job, options_json: JSON.stringify(options) };
    await db.run("UPDATE transcription_jobs SET options_json = ?, updated_at = ? WHERE id = ?", [
      job.options_json,
      nowIso(),
      job.id,
    ]);
  }
  const captions = options.use_creator_captions === true;
  const quote = quoteJob({ durationSeconds: duration, options, viaApi: job.via_api === 1 });

  if (!quote.free && confirmAbove !== null && quote.credits > confirmAbove) {
    await db.run(
      "UPDATE transcription_jobs SET status = 'awaiting_confirmation', pricing_state = 'pending', updated_at = ? WHERE id = ?",
      [nowIso(), job.id],
    );
    return { ...job, status: "awaiting_confirmation" };
  }

  if (quote.free) {
    // Caption fetches use no GPU time, so they skip the free-queue guard and have their own quota.
    if (!captions) {
      const guard = await freeQueueCheck(db);
      if (!guard.ok) {
        await failJob(env, db, null, job.id, "free_queue_saturated", false, true);
        throw quotaError("free_queue_saturated", "en");
      }
    }
    const subject = job.tenant_id ?? job.guest_id ?? "";
    const limits = captions ? PRICING.captionFreePerDay : PRICING.freeJobsPerDay;
    const limit = job.tenant_id ? limits.user : limits.guest;
    const taken = await takeFreeJob(db, subject, captions ? "captions" : "transcribe", limit);
    if (!taken.ok) {
      await failJob(env, db, null, job.id, "free_quota_exceeded", false, true);
      throw new HttpError(
        "quota_exceeded",
        429,
        job.tenant_id
          ? "You have used today's free transcriptions. Buy credits to continue."
          : "Guest quota is used up for today. Sign in for more free transcriptions.",
        { limit: "free_daily_jobs", used: taken.used },
      );
    }
    await db.run(
      "UPDATE transcription_jobs SET status = 'queued', stage = 'transcribe', free = 1, pricing_state = 'free', queued_at = ?, updated_at = ? WHERE id = ?",
      [nowIso(), nowIso(), job.id],
    );
    return { ...job, status: "queued", stage: "transcribe", free: 1, pricing_state: "free" };
  }

  if (!job.tenant_id) {
    await failJob(env, db, null, job.id, "sign_in_required", false, true);
    throw new HttpError("unauthenticated", 401, "Sign in to transcribe media longer than 3 minutes.", {
      reason: "sign_in_required",
    });
  }

  const cap = await monthlyCapMinutes(db, job.tenant_id);
  const reservedMinutes = await reserveMinutes(db, job.tenant_id, quote.billableMinutes, cap);
  if (!reservedMinutes) {
    await failJob(env, db, null, job.id, "monthly_cap_reached", false, true);
    throw quotaError("monthly_cap_reached", "en");
  }
  try {
    await reserveCredits(db, job.tenant_id, quote.credits, job.id);
  } catch (error) {
    await releaseMinutes(db, job.tenant_id, quote.billableMinutes);
    await failJob(env, db, null, job.id, error instanceof HttpError ? error.code : "insufficient_credits", false, true);
    throw error;
  }
  await db.run(
    `UPDATE transcription_jobs SET status = 'queued', stage = 'transcribe', billable_minutes = ?, free = 0,
       pricing_state = 'reserved', reserved_credits = ?, queued_at = ?, updated_at = ? WHERE id = ?`,
    [quote.billableMinutes, quote.credits, nowIso(), nowIso(), job.id],
  );
  return {
    ...job,
    status: "queued",
    stage: "transcribe",
    billable_minutes: quote.billableMinutes,
    free: 0,
    pricing_state: "reserved",
    reserved_credits: quote.credits,
  };
}

export async function freeQueueCheck(db: Db): Promise<{ ok: boolean; waitedSeconds: number }> {
  const budget = await freeQueueBudget(db);
  const minutes = await freeMinutesAcceptedToday(db);
  if (minutes >= budget.minutesPerDay) return { ok: false, waitedSeconds: 0 };
  const oldest = await db.first<{ queued_at: string }>(
    "SELECT queued_at FROM transcription_jobs WHERE status = 'queued' AND free = 1 ORDER BY queued_at LIMIT 1",
  );
  const waitedSeconds = oldest ? Math.max(0, (Date.now() - Date.parse(oldest.queued_at)) / 1000) : 0;
  return { ok: waitedSeconds <= budget.maxWaitSeconds, waitedSeconds };
}

/** Confirms a job parked in `awaiting_confirmation` (or a preview the user accepted). */
export async function confirmJob(env: Env, db: Db, job: JobRow, confirmAbove: number | null = null): Promise<JobRow> {
  if (job.status !== "awaiting_confirmation" && job.status !== "preview_ready") {
    throw new HttpError("invalid_input", 409, "This job is not waiting for confirmation.", { status: job.status });
  }
  await db.run("UPDATE transcription_jobs SET preview = 0, confirm_above = NULL, updated_at = ? WHERE id = ?", [
    nowIso(),
    job.id,
  ]);
  return priceAfterProbe(env, db, { ...job, preview: 0, confirm_above: null }, confirmAbove);
}

export async function getJob(db: Db, jobId: string): Promise<JobRow | null> {
  return db.first<JobRow>("SELECT * FROM transcription_jobs WHERE id = ?", [jobId]);
}

export async function listJobs(db: Db, filter: { tenantId?: string | null; guestId?: string | null }, limit = 50) {
  if (filter.tenantId) {
    return db.all<JobRow>("SELECT * FROM transcription_jobs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?", [
      filter.tenantId,
      limit,
    ]);
  }
  return db.all<JobRow>("SELECT * FROM transcription_jobs WHERE guest_id = ? ORDER BY created_at DESC LIMIT ?", [
    filter.guestId ?? "",
    limit,
  ]);
}

export async function cancelJob(env: Env, db: Db, job: JobRow): Promise<void> {
  if (["succeeded", "failed", "cancelled"].includes(job.status)) return;
  const timestamp = nowIso();
  await db.run(
    `UPDATE transcription_jobs SET status = 'cancelled', leased_by = NULL, lease_token = NULL,
       lease_expires_at = NULL, finished_at = ?, updated_at = ?
     WHERE id = ? AND status IN ('queued','preview_ready','awaiting_confirmation','leased')`,
    [timestamp, timestamp, job.id],
  );
  await releaseJobHold(env, db, job, "released");
  await deletePrefix(env, "media", `media/${job.id}/`).catch(() => 0);
}

/** Releases whatever the job holds. Safe to call twice thanks to `pricing_state`. */
async function releaseJobHold(_env: Env, db: Db, job: JobRow, state: "released"): Promise<void> {
  const fresh = await getJob(db, job.id);
  if (!fresh) return;
  if (fresh.pricing_state === "reserved") {
    const updated = await db.run(
      "UPDATE transcription_jobs SET pricing_state = ?, updated_at = ? WHERE id = ? AND pricing_state = 'reserved'",
      [state, nowIso(), job.id],
    );
    if (updated.changes === 1) {
      if (fresh.tenant_id) {
        await releaseCredits(db, fresh.tenant_id, job.id, fresh.reserved_credits);
        await releaseMinutes(db, fresh.tenant_id, fresh.billable_minutes ?? 0);
      }
    }
    return;
  }
  if (fresh.pricing_state === "free") {
    const subject = fresh.tenant_id ?? fresh.guest_id ?? "";
    if (subject) await releaseFreeJob(db, subject, usesCaptions(job) ? "captions" : "transcribe");
    await db.run("UPDATE transcription_jobs SET pricing_state = 'released', updated_at = ? WHERE id = ?", [
      nowIso(),
      job.id,
    ]);
  }
}

export type FailCode = string;

export async function failJob(
  env: Env,
  db: Db,
  workerId: string | null,
  jobId: string,
  code: FailCode,
  retryable: boolean,
  internal = false,
): Promise<{ requeued: boolean }> {
  const job = await getJob(db, jobId);
  if (!job) return { requeued: false };
  if (["succeeded", "failed", "cancelled", "expired"].includes(job.status) && !internal) {
    return { requeued: false };
  }
  const timestamp = nowIso();
  const attempts = job.attempts + (workerId ? 1 : 0);
  const canRetry = retryable && attempts < PRICING.maxAttempts;

  if (canRetry) {
    const result = await db.run(
      `UPDATE transcription_jobs SET status = 'queued', leased_by = NULL, lease_token = NULL,
         lease_expires_at = NULL, attempts = ?, error_code = ?, error_detail = ?, queued_at = ?, updated_at = ?
       WHERE id = ? AND (status = 'leased' OR ? = 1)`,
      [attempts, code, null, timestamp, timestamp, jobId, internal ? 1 : 0],
    );
    if (result.changes > 0) return { requeued: true };
  }

  await db.run(
    `UPDATE transcription_jobs SET status = 'failed', leased_by = NULL, lease_expires_at = NULL, attempts = ?,
       error_code = ?, error_detail = NULL, finished_at = ?, updated_at = ?
     WHERE id = ?`,
    [attempts, code, timestamp, timestamp, jobId],
  );
  await releaseJobHold(env, db, job, "released");
  return { requeued: false };
}

export interface CompleteResult {
  stage: JobStage;
  probe?: ProbeResult;
  /** Inline result, used by tests and small transcripts. */
  transcript?: StoredTranscript;
  /** Object the worker already PUT to R2 through its presigned URL. */
  transcriptKey?: string;
  formats?: string[];
  language?: string;
  model?: string;
}

/**
 * The single winner of the `leased → succeeded` transition settles credits. A worker whose
 * lease expired and whose job was requeued gets `rejected` and must not charge anything.
 */
export async function completeJob(
  env: Env,
  db: Db,
  workerId: string,
  jobId: string,
  result: CompleteResult,
  leaseToken: string | null = null,
): Promise<{ accepted: boolean; reason?: string; job?: JobRow }> {
  const job = await getJob(db, jobId);
  if (!job) return { accepted: false, reason: "not_found" };
  if (job.leased_by !== workerId) return { accepted: false, reason: "not_leased_by_worker" };
  if (job.status !== "leased") return { accepted: false, reason: "not_leased" };
  // The lease token is what makes a late completion from an earlier attempt lose even when the
  // same worker leased the job again after a requeue.
  if (job.lease_token && job.lease_token !== leaseToken) return { accepted: false, reason: "lease_superseded" };
  if (job.lease_expires_at && job.lease_expires_at <= nowIso()) return { accepted: false, reason: "lease_expired" };

  if (result.stage === "probe" && result.probe) {
    const updated = await recordProbe(env, db, job, result.probe, job.confirm_above);
    await db.run(
      "UPDATE transcription_jobs SET leased_by = NULL, lease_token = NULL, lease_expires_at = NULL WHERE id = ?",
      [jobId],
    );
    return { accepted: true, job: updated };
  }

  if (!result.transcript && !result.transcriptKey) return { accepted: false, reason: "missing_transcript" };
  const timestamp = nowIso();
  const formats = result.formats ?? ["json", "txt", "srt", "vtt"];
  const key = result.transcriptKey ?? resultKey(jobId, "transcript.json");
  if (!key.startsWith(`results/${jobId}/`)) return { accepted: false, reason: "invalid_result_key" };
  if (result.transcript) {
    await putJson(env, key, {
      ...result.transcript,
      language: result.language ?? result.transcript.language,
      model: result.model ?? result.transcript.model,
      formats,
    });
  } else {
    const head = await env.OUTPUTS.head(key);
    if (!head) return { accepted: false, reason: "result_missing" };
  }

  const options = parseJson<JobOptions>(job.options_json, {});
  // The summary add-on is charged only when it actually runs, so its share of the reservation
  // stays held until `runAddons` settles or releases it.
  const addonCredits =
    job.pricing_state === "reserved" && options.summary ? Math.min(PRICING.summaryCredits, job.reserved_credits) : 0;
  const base = Math.max(0, job.reserved_credits - addonCredits);
  const settlementId = id("stl");
  const statements: Statement[] = [
    {
      // The only winner of `leased → succeeded`. `settlement_id` is written here and every money
      // statement below is keyed on it, so a retried completion finds no match and does nothing.
      sql: `UPDATE transcription_jobs SET status = 'succeeded', leased_by = NULL, lease_token = NULL,
              lease_expires_at = NULL, result_key = ?, result_formats_json = ?, finished_at = ?,
              settlement_id = ?, updated_at = ?
            WHERE id = ? AND status = 'leased' AND leased_by = ?
              AND (lease_token IS NULL OR lease_token = ?)`,
      params: [key, JSON.stringify(formats), timestamp, settlementId, timestamp, jobId, workerId, leaseToken],
    },
  ];

  if (job.pricing_state === "reserved" && job.tenant_id) {
    statements.push({
      sql: `UPDATE transcription_jobs SET pricing_state = ?, charged_credits = ?, reserved_credits = ?
            WHERE id = ? AND settlement_id = ? AND pricing_state = 'reserved'`,
      params: [addonCredits > 0 ? "addon_pending" : "settled", base, addonCredits, jobId, settlementId],
    });
    const wallet = await ensureWallet(db, job.tenant_id);
    const plan = planSettlement(wallet, job.tenant_id, jobId, base, base, {
      clause: `EXISTS (SELECT 1 FROM transcription_jobs WHERE id = ? AND settlement_id = ? AND pricing_state IN ('settled','addon_pending'))`,
      params: [jobId, settlementId],
    });
    statements.push(...plan.statements);
  } else if (job.pricing_state === "free") {
    statements.push({
      sql: "UPDATE transcription_jobs SET pricing_state = 'settled' WHERE id = ? AND settlement_id = ? AND pricing_state = 'free'",
      params: [jobId, settlementId],
    });
  }

  // One atomic batch: the job transition and the money movement cannot disagree, and a crash
  // between them is impossible. A retry re-reads and finds `settlement_id` already set.
  await db.batch(statements);

  const settledJob = await getJob(db, jobId);
  if (settledJob?.settlement_id !== settlementId) {
    const stored = settledJob?.status === "succeeded";
    return { accepted: stored, reason: stored ? undefined : "raced", job: settledJob ?? undefined };
  }
  return { accepted: true, job: { ...job, status: "succeeded", result_key: key, settlement_id: settlementId } };
}

export type LeaseRefusal = "not_found" | "cancelled" | "lost";

export interface ExtendResult {
  ok: boolean;
  reason?: LeaseRefusal;
}

/**
 * Extension doubles as the worker's cancellation channel: if the job is no longer leased to this
 * worker (cancelled, requeued, or taken by another attempt) the worker must stop and free the GPU.
 */
export async function extendLease(
  db: Db,
  workerId: string,
  jobId: string,
  leaseToken: string | null,
  seconds = PRICING.leaseExtendSeconds,
): Promise<ExtendResult> {
  const expires = new Date(Date.now() + seconds * 1000).toISOString();
  const result = await db.run(
    `UPDATE transcription_jobs SET lease_expires_at = ?, updated_at = ?
     WHERE id = ? AND status = 'leased' AND leased_by = ? AND (lease_token IS NULL OR lease_token = ?)`,
    [expires, nowIso(), jobId, workerId, leaseToken],
  );
  if (result.changes === 1) return { ok: true };
  const row = await db.first<{ status: string }>("SELECT status FROM transcription_jobs WHERE id = ?", [jobId]);
  if (!row) return { ok: false, reason: "not_found" };
  if (row.status === "cancelled") return { ok: false, reason: "cancelled" };
  return { ok: false, reason: "lost" };
}

/**
 * Cron + opportunistic requeue. A job whose lease expired goes back to the queue; after
 * `maxAttempts` it fails and the reservation is released. The reservation is never released
 * on requeue, which is what prevents a double charge.
 */
export async function requeueExpired(db: Db): Promise<{ requeued: number; failed: number }> {
  const now = nowIso();
  const expired = await db.all<JobRow>(
    "SELECT * FROM transcription_jobs WHERE status = 'leased' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?",
    [now],
  );
  let requeued = 0;
  let failed = 0;
  for (const job of expired) {
    const nextAttempts = job.attempts + 1;
    if (nextAttempts >= PRICING.maxAttempts) {
      await db.run(
        `UPDATE transcription_jobs SET status = 'failed', error_code = 'worker_lost', leased_by = NULL,
           lease_token = NULL, lease_expires_at = NULL, attempts = ?, finished_at = ?, updated_at = ?
       WHERE id = ? AND status = 'leased'`,
        [nextAttempts, now, now, job.id],
      );
      failed += 1;
      await releaseHoldOnly(db, job);
    } else {
      const result = await db.run(
        `UPDATE transcription_jobs SET status = 'queued', leased_by = NULL, lease_token = NULL,
           lease_expires_at = NULL, attempts = ?, error_code = 'worker_lost', queued_at = ?, updated_at = ?
         WHERE id = ? AND status = 'leased'`,
        [nextAttempts, now, now, job.id],
      );
      if (result.changes > 0) requeued += 1;
    }
  }
  return { requeued, failed };
}

async function releaseHoldOnly(db: Db, job: JobRow): Promise<void> {
  if (job.pricing_state === "reserved") {
    const updated = await db.run(
      "UPDATE transcription_jobs SET pricing_state = 'released', updated_at = ? WHERE id = ? AND pricing_state = 'reserved'",
      [nowIso(), job.id],
    );
    if (updated.changes === 1 && job.tenant_id) {
      await releaseCredits(db, job.tenant_id, job.id, job.reserved_credits);
      await releaseMinutes(db, job.tenant_id, job.billable_minutes ?? 0);
    }
  } else if (job.pricing_state === "free") {
    const subject = job.tenant_id ?? job.guest_id ?? "";
    if (subject) await releaseFreeJob(db, subject, usesCaptions(job) ? "captions" : "transcribe");
    await db.run("UPDATE transcription_jobs SET pricing_state = 'released' WHERE id = ? AND pricing_state = 'free'", [
      job.id,
    ]);
  }
}

/** Preview jobs that nobody confirmed expire after 15 minutes (cron). */
export async function expireStalePreviews(db: Db): Promise<number> {
  const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const result = await db.run(
    "UPDATE transcription_jobs SET status = 'expired', updated_at = ? WHERE status = 'preview_ready' AND preview = 1 AND updated_at < ?",
    [nowIso(), cutoff],
  );
  return result.changes;
}

export async function loadTranscript(env: Env, job: JobRow): Promise<NormalizedTranscript | null> {
  if (!job.result_key) return null;
  return getJson<NormalizedTranscript>(env, job.result_key);
}

export async function downloadFormat(
  env: Env,
  job: JobRow,
  format: "json" | "txt" | "srt" | "vtt",
): Promise<{ body: string; contentType: string; filename: string } | null> {
  const transcript = await loadTranscript(env, job);
  if (!transcript) return null;
  const base = (job.title ?? job.id).replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80);
  if (format === "json") {
    return {
      body: JSON.stringify(transcript, null, 2),
      contentType: "application/json; charset=utf-8",
      filename: `${base}.json`,
    };
  }
  if (format === "txt") {
    const text = transcript.segments
      .map((segment) => segment.text.trim())
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    return { body: `${text}\n`, contentType: "text/plain; charset=utf-8", filename: `${base}.txt` };
  }
  if (format === "srt") {
    return {
      body: buildSrt(transcript.segments),
      contentType: "application/x-subrip; charset=utf-8",
      filename: `${base}.srt`,
    };
  }
  return { body: buildVtt(transcript.segments), contentType: "text/vtt; charset=utf-8", filename: `${base}.vtt` };
}

export function jobStats(transcript: NormalizedTranscript) {
  return transcriptStats(transcript);
}

export const JOB_SELECT = "SELECT * FROM transcription_jobs";
