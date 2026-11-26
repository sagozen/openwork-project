import {
  type AbuseHooks,
  type AbuseSubject,
  abuseSubjects,
  assertNotBlocked,
  recordAbuseSignal,
} from "@templatedesign/platform/abuse";
import type { Db } from "@templatedesign/platform/db";
import { HttpError } from "@templatedesign/platform/http";
import type { Actor } from "./api";
import { cancelJob, type JobRow } from "./jobs";
import type { Env } from "./types";

/**
 * TranscriptAnything's wiring for the shared job-abuse module. Every handler that creates jobs
 * (or hands out uploads and probes for them) resolves the subjects once, refuses blocked ones
 * before Turnstile and rate limits, reports rate-limit rejections, and reports each job it
 * actually created. Policy is the platform default (120 jobs or 30 rate-limit hits per hour).
 */

/** Jobs a worker has not started yet. `leased` is excluded: a worker is already running it. */
const UNSTARTED = ["queued", "preview_ready", "awaiting_confirmation"] as const;

export function requestAbuseSubjects(actor: Pick<Actor, "tenantId" | "guestId">, request: Request): AbuseSubject[] {
  return abuseSubjects({
    tenantId: actor.tenantId,
    guestId: actor.guestId,
    ip: request.headers.get("cf-connecting-ip"),
  });
}

export function jobAbuseHooks(env: Env, db: Db): AbuseHooks {
  return {
    adminPath: "/admin/abuse/",
    cancelQueuedJobs: (subject) => cancelUnstartedJobs(env, db, subject),
  };
}

/**
 * Cancels the subject's jobs that no worker has picked up, through `cancelJob` so credit holds,
 * minutes and free-quota slots are released. Jobs do not store the creator's IP, so an IP block
 * only stops new jobs.
 */
export async function cancelUnstartedJobs(env: Env, db: Db, subject: AbuseSubject): Promise<number> {
  if (subject.kind === "ip") return 0;
  const column = subject.kind === "tenant" ? "tenant_id" : "guest_id";
  const jobs = await db.all<JobRow>(
    `SELECT * FROM transcription_jobs WHERE ${column} = ? AND status IN (${UNSTARTED.map(() => "?").join(", ")})`,
    [subject.id, ...UNSTARTED],
  );
  for (const job of jobs) await cancelJob(env, db, job);
  return jobs.length;
}

export { assertNotBlocked };

/** Runs a rate-limit check and counts a 429 against the subjects before rethrowing it. */
export async function countRateLimited<T>(
  env: Env,
  db: Db,
  subjects: AbuseSubject[],
  check: () => Promise<T>,
): Promise<T> {
  try {
    return await check();
  } catch (error) {
    if (error instanceof HttpError && error.status === 429) {
      await recordAbuseSignal(env, db, subjects, "rate_limited", jobAbuseHooks(env, db));
    }
    throw error;
  }
}

/**
 * Counts newly created jobs. When this request pushes a subject over the threshold, the block
 * has already cancelled the subject's unstarted jobs (including these), so the request answers
 * with the same 429 a blocked subject gets instead of returning jobs that no longer run.
 */
export async function countJobsCreated(env: Env, db: Db, subjects: AbuseSubject[], count: number): Promise<void> {
  if (count <= 0) return;
  const block = await recordAbuseSignal(env, db, subjects, "job_created", jobAbuseHooks(env, db), count);
  if (block) await assertNotBlocked(db, subjects);
}
