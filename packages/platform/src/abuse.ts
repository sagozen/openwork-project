import { alertOperators } from "./alerts";
import { brandUrl } from "./config";
import type { Db } from "./db";
import { nowIso } from "./db";
import { HttpError } from "./http";
import type { PlatformEnv } from "./types";

/**
 * Job abuse detection. Each app reports two signals per subject — a job was created, or a
 * request hit a rate limit — into hourly counters in `rate_limits`. A subject that crosses a
 * threshold is blocked from creating jobs for `blockMinutes`, its queued jobs are cancelled by
 * the app, and operators get one throttled email that links to Admin → Abuse.
 *
 * Subjects: a signed-in tenant is judged on its own (a shared office IP must not block a paying
 * account); a guest is judged by guest id and by IP, so clearing cookies does not reset it.
 * Blocks live in the app-owned `abuse_blocks` table (see packages/platform/sql/abuse_blocks.sql).
 */
export type AbuseSubjectKind = "tenant" | "guest" | "ip";

export interface AbuseSubject {
  kind: AbuseSubjectKind;
  id: string;
}

export type AbuseSignal = "job_created" | "rate_limited";

export interface AbusePolicy {
  /** Jobs one subject may create per clock hour before it is blocked. */
  jobsPerHour: number;
  /** Rate-limit rejections per clock hour before the subject is blocked. */
  rateLimitedPerHour: number;
  /** Length of an automatic block. */
  blockMinutes: number;
}

export const DEFAULT_ABUSE_POLICY: AbusePolicy = { jobsPerHour: 120, rateLimitedPerHour: 30, blockMinutes: 60 };

export interface AbuseBlockRow {
  id: string;
  subject_kind: AbuseSubjectKind;
  subject_id: string;
  reason: string;
  detail_json: string;
  source: "auto" | "admin";
  blocked_until: string | null;
  cancelled_jobs: number;
  created_by: string | null;
  created_at: string;
  released_at: string | null;
  released_by: string | null;
}

export interface AbuseHooks {
  policy?: Partial<AbusePolicy>;
  /** Cancels the subject's queued jobs (releasing holds) and returns how many it cancelled. */
  cancelQueuedJobs?: (subject: AbuseSubject) => Promise<number>;
  /** Admin page the alert links to. */
  adminPath?: string;
}

const WINDOW_SECONDS = 3600;
const DEFAULT_ADMIN_PATH = "/admin/abuse/";

export function abuseSubjects(actor: {
  tenantId?: string | null;
  guestId?: string | null;
  ip?: string | null;
}): AbuseSubject[] {
  if (actor.tenantId) return [{ kind: "tenant", id: actor.tenantId }];
  const subjects: AbuseSubject[] = [];
  if (actor.guestId) subjects.push({ kind: "guest", id: actor.guestId });
  const ip = actor.ip?.trim();
  if (ip) subjects.push({ kind: "ip", id: ip.slice(0, 64) });
  return subjects;
}

/** Absolute link for operator emails, on the same origin the email footer uses. */
export function operatorUrl(env: PlatformEnv, path: string): string {
  const origin = env.APP_ORIGIN || env.BETTER_AUTH_URL;
  return origin ? `${origin.replace(/\/$/, "")}${path}` : brandUrl(path);
}

export function describeSubject(subject: Pick<AbuseSubject, "kind" | "id">): string {
  return `${subject.kind} ${subject.id}`;
}

function isActive(row: AbuseBlockRow, now: number): boolean {
  return !row.released_at && (row.blocked_until === null || Date.parse(row.blocked_until) > now);
}

export async function findActiveBlock(
  db: Db,
  subjects: AbuseSubject[],
  now = Date.now(),
): Promise<AbuseBlockRow | null> {
  for (const subject of subjects) {
    const rows = await db.all<AbuseBlockRow>(
      `SELECT * FROM abuse_blocks
       WHERE subject_kind = ? AND subject_id = ? AND released_at IS NULL
       ORDER BY created_at DESC`,
      [subject.kind, subject.id],
    );
    const active = rows.find((row) => isActive(row, now));
    if (active) return active;
  }
  return null;
}

/** Throws a 429 with `retry-after` while any of the subjects is blocked. */
export async function assertNotBlocked(db: Db, subjects: AbuseSubject[], now = Date.now()): Promise<void> {
  const block = await findActiveBlock(db, subjects, now);
  if (!block) return;
  const retry = block.blocked_until ? Math.max(1, Math.ceil((Date.parse(block.blocked_until) - now) / 1000)) : null;
  throw new HttpError(
    "rate_limited",
    429,
    retry
      ? `Job creation is paused for this account because of unusual activity. Try again in ${Math.ceil(retry / 60)} minutes, or contact support if this is a mistake. / Tạm dừng tạo job do hoạt động bất thường. Thử lại sau ${Math.ceil(retry / 60)} phút, hoặc liên hệ hỗ trợ nếu đây là nhầm lẫn.`
      : "Job creation is paused for this account because of unusual activity. Contact support to restore it. / Tạm dừng tạo job do hoạt động bất thường. Liên hệ hỗ trợ để mở lại.",
    { blocked: true },
    retry ? { "retry-after": String(retry) } : undefined,
  );
}

async function bumpCounter(db: Db, bucket: string, cost: number, now: number): Promise<number> {
  const windowStart = Math.floor(now / 1000 / WINDOW_SECONDS) * WINDOW_SECONDS;
  await db.run("INSERT OR IGNORE INTO rate_limits (bucket, window_start, count) VALUES (?, ?, 0)", [
    bucket,
    windowStart,
  ]);
  await db.run("UPDATE rate_limits SET count = count + ? WHERE bucket = ? AND window_start = ?", [
    cost,
    bucket,
    windowStart,
  ]);
  const row = await db.first<{ count: number }>("SELECT count FROM rate_limits WHERE bucket = ? AND window_start = ?", [
    bucket,
    windowStart,
  ]);
  return row?.count ?? 0;
}

const counterBucket = (signal: AbuseSignal, subject: AbuseSubject) => `abuse:${signal}:${subject.kind}:${subject.id}`;

/**
 * Counts one signal for every subject and blocks the first subject that is over its threshold.
 * Returns the new block, or null. Call it after `assertNotBlocked`, so blocked requests are not
 * counted again.
 */
export async function recordAbuseSignal(
  env: PlatformEnv,
  db: Db,
  subjects: AbuseSubject[],
  signal: AbuseSignal,
  hooks: AbuseHooks = {},
  cost = 1,
  now = Date.now(),
): Promise<AbuseBlockRow | null> {
  const policy = { ...DEFAULT_ABUSE_POLICY, ...hooks.policy };
  const limit = signal === "job_created" ? policy.jobsPerHour : policy.rateLimitedPerHour;
  for (const subject of subjects) {
    const count = await bumpCounter(db, counterBucket(signal, subject), Math.max(1, cost), now);
    if (count <= limit) continue;
    if (await findActiveBlock(db, [subject], now)) continue;
    return blockSubject(env, db, subject, {
      reason: signal === "job_created" ? "too_many_jobs" : "too_many_rate_limited",
      detail: { signal, count, limit, windowSeconds: WINDOW_SECONDS },
      source: "auto",
      minutes: policy.blockMinutes,
      hooks,
      now,
    });
  }
  return null;
}

export interface BlockOptions {
  reason: string;
  detail?: Record<string, string | number>;
  source: "auto" | "admin";
  /** null blocks until an admin releases it. */
  minutes: number | null;
  createdBy?: string | null;
  hooks?: AbuseHooks;
  now?: number;
}

export async function blockSubject(
  env: PlatformEnv,
  db: Db,
  subject: AbuseSubject,
  options: BlockOptions,
): Promise<AbuseBlockRow> {
  const now = options.now ?? Date.now();
  const at = nowIso();
  const until = options.minutes === null ? null : new Date(now + options.minutes * 60 * 1000).toISOString();
  const id = `abuse_${crypto.randomUUID().replaceAll("-", "")}`;
  await db.run(
    `INSERT INTO abuse_blocks (id, subject_kind, subject_id, reason, detail_json, source, blocked_until,
       cancelled_jobs, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    [
      id,
      subject.kind,
      subject.id,
      options.reason,
      JSON.stringify(options.detail ?? {}),
      options.source,
      until,
      options.createdBy ?? null,
      at,
    ],
  );

  let cancelled = 0;
  if (options.hooks?.cancelQueuedJobs) {
    try {
      cancelled = await options.hooks.cancelQueuedJobs(subject);
      await db.run("UPDATE abuse_blocks SET cancelled_jobs = ? WHERE id = ?", [cancelled, id]);
    } catch (error) {
      console.error(
        JSON.stringify({
          evt: "abuse_cancel_failed",
          blockId: id,
          error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
        }),
      );
    }
  }

  if (options.source === "auto") {
    const detail = options.detail ?? {};
    await alertOperators(env, db, {
      kind: "job_abuse_blocked",
      summary: `Blocked ${describeSubject(subject)} from creating jobs (${options.reason}).`,
      detail: { blockId: id, subject: subject.kind, reason: options.reason, count: detail.count ?? "" },
      template: "abuse_alert",
      emailData: {
        subject: describeSubject(subject),
        reason: options.reason === "too_many_jobs" ? "too many jobs" : "too many rate-limited requests",
        count: detail.count ?? "",
        limit: detail.limit ?? "",
        until: until ?? "until released",
        cancelled,
        url: operatorUrl(env, `${options.hooks?.adminPath ?? DEFAULT_ADMIN_PATH}?block=${encodeURIComponent(id)}`),
      },
      throttle: { limit: 10, windowSeconds: 3600 },
    });
  }

  const row = await db.first<AbuseBlockRow>("SELECT * FROM abuse_blocks WHERE id = ?", [id]);
  if (!row) throw new Error("abuse block insert failed");
  return row;
}

export async function getAbuseBlock(db: Db, id: string): Promise<AbuseBlockRow | null> {
  return db.first<AbuseBlockRow>("SELECT * FROM abuse_blocks WHERE id = ?", [id]);
}

export async function releaseAbuseBlock(db: Db, id: string, actorId: string): Promise<boolean> {
  const result = await db.run(
    "UPDATE abuse_blocks SET released_at = ?, released_by = ? WHERE id = ? AND released_at IS NULL",
    [nowIso(), actorId, id],
  );
  return result.changes === 1;
}

/** Sets a new end for an unreleased block; `minutes: null` keeps it until released. */
export async function extendAbuseBlock(db: Db, id: string, minutes: number | null, now = Date.now()): Promise<boolean> {
  const until = minutes === null ? null : new Date(now + minutes * 60 * 1000).toISOString();
  const result = await db.run("UPDATE abuse_blocks SET blocked_until = ? WHERE id = ? AND released_at IS NULL", [
    until,
    id,
  ]);
  return result.changes === 1;
}

export interface AbuseOverview {
  active: AbuseBlockRow[];
  recent: AbuseBlockRow[];
  /** Subjects with the most jobs in the current clock hour. */
  topCreators: Array<{ kind: AbuseSubjectKind; id: string; jobs: number }>;
}

export async function abuseOverview(db: Db, now = Date.now()): Promise<AbuseOverview> {
  const recent = await db.all<AbuseBlockRow>("SELECT * FROM abuse_blocks ORDER BY created_at DESC LIMIT 50");
  const open = await db.all<AbuseBlockRow>(
    "SELECT * FROM abuse_blocks WHERE released_at IS NULL ORDER BY created_at DESC LIMIT 200",
  );
  const windowStart = Math.floor(now / 1000 / WINDOW_SECONDS) * WINDOW_SECONDS;
  const counters = await db.all<{ bucket: string; count: number }>(
    `SELECT bucket, count FROM rate_limits
     WHERE window_start = ? AND bucket LIKE 'abuse:job_created:%'
     ORDER BY count DESC LIMIT 20`,
    [windowStart],
  );
  const topCreators = counters.flatMap((row) => {
    const [, , kind, ...rest] = row.bucket.split(":");
    if (kind !== "tenant" && kind !== "guest" && kind !== "ip") return [];
    return [{ kind: kind as AbuseSubjectKind, id: rest.join(":"), jobs: row.count }];
  });
  return { active: open.filter((row) => isActive(row, now)), recent, topCreators };
}

export function isAbuseSubjectKind(value: unknown): value is AbuseSubjectKind {
  return value === "tenant" || value === "guest" || value === "ip";
}
