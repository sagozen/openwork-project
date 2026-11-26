import type { Db } from "@templatedesign/platform/db";
import { id, nowIso } from "@templatedesign/platform/db";
import { ImageError, type ImageErrorCode } from "./errors";
import {
  failJob,
  getJobById,
  type ImageRow,
  type JobContext,
  type JobParams,
  type JobRow,
  rerouteToProvider,
  resolveReferenceUrls,
  settle,
  WORKER_LANE,
} from "./jobs";
import { billedMegapixels } from "./pricing";
import { extensionFor, imageKey, newImageId, sniffImageMime } from "./storage";
import { type JobKind, LEASE_SECONDS, MAX_WORKER_ATTEMPTS, slotLimit, type WorkerRow, workerCanTake } from "./workers";

/** What a worker receives when it leases a job: everything it needs to make the images, nothing else. */
export interface LeasedJob {
  job: {
    id: string;
    kind: JobKind;
    prompt: string;
    negative_prompt: string | null;
    width: number;
    height: number;
    num_images: number;
    seed: number | null;
    output_format: string;
    /** Links to download promptly: private brand references expire after ten minutes. */
    references: string[];
    attempt: number;
  };
  lease_token: string;
  lease_expires_at: string;
  lease_seconds: number;
}

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function leaseToken(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `lst_${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

const leaseExpiry = (now: number) => new Date(now + LEASE_SECONDS * 1000).toISOString();

/* ------------------------------------------------------------------ lease */

async function slotsFree(db: Db, worker: WorkerRow, now: number): Promise<boolean> {
  const held = await db.first<{ count: number }>(
    "SELECT COUNT(*) AS count FROM image_jobs WHERE provider = ? AND state = 'running' AND leased_by = ? AND lease_expires_at > ?",
    [WORKER_LANE, worker.id, new Date(now).toISOString()],
  );
  return (held?.count ?? 0) < slotLimit(worker);
}

async function tryLease(db: Db, worker: WorkerRow, now: number): Promise<{ row: JobRow; token: string } | null> {
  if (!(await slotsFree(db, worker, now))) return null;
  const iso = new Date(now).toISOString();
  // Queued jobs, plus running ones whose lease ran out while attempts remain.
  const rows = await db.all<JobRow>(
    `SELECT * FROM image_jobs
     WHERE provider = ? AND attempts < ? AND (state = 'queued' OR (state = 'running' AND lease_expires_at < ?))
     ORDER BY created_at LIMIT 10`,
    [WORKER_LANE, MAX_WORKER_ATTEMPTS, iso],
  );
  for (const row of rows) {
    const params = JSON.parse(row.params_json) as JobParams;
    if (!workerCanTake(worker, row.kind, billedMegapixels(params.width, params.height))) continue;
    const token = leaseToken();
    const claimed = await db.run(
      `UPDATE image_jobs SET state = 'running', leased_by = ?, lease_token = ?, lease_expires_at = ?,
         attempts = attempts + 1, updated_at = ?
       WHERE id = ? AND provider = ? AND attempts < ?
         AND (state = 'queued' OR (state = 'running' AND lease_expires_at < ?))`,
      [worker.id, token, leaseExpiry(now), nowIso(), row.id, WORKER_LANE, MAX_WORKER_ATTEMPTS, iso],
    );
    if (claimed.changes === 1) return { row, token };
  }
  return null;
}

export interface LeaseOptions {
  /** How long to hold the request open, in seconds. 0 means one try. */
  waitSeconds?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Long-polls for one job. The Worker decides who may take what; the worker only asks. */
export async function leaseImageJob(
  ctx: Pick<JobContext, "db" | "signReference">,
  worker: WorkerRow,
  options: LeaseOptions = {},
): Promise<LeasedJob | null> {
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const deadline = now() + Math.max(0, options.waitSeconds ?? 20) * 1000;
  let delay = 700;
  for (;;) {
    const leased = await tryLease(ctx.db, worker, now());
    if (leased) {
      const params = JSON.parse(leased.row.params_json) as JobParams;
      let references: string[];
      try {
        references = await resolveReferenceUrls(ctx, leased.row);
      } catch (error) {
        // Release the claim so another attempt, or the provider, can take the job.
        await ctx.db.run(
          "UPDATE image_jobs SET state = 'queued', leased_by = NULL, lease_token = NULL, lease_expires_at = NULL WHERE id = ? AND lease_token = ?",
          [leased.row.id, leased.token],
        );
        throw error;
      }
      return {
        job: {
          id: leased.row.id,
          kind: leased.row.kind,
          prompt: params.prompt,
          negative_prompt: params.negativePrompt ?? null,
          width: params.width,
          height: params.height,
          num_images: leased.row.num_images,
          seed: params.seed ?? null,
          output_format: params.outputFormat,
          references,
          attempt: leased.row.attempts + 1,
        },
        lease_token: leased.token,
        lease_expires_at: leaseExpiry(now()),
        lease_seconds: LEASE_SECONDS,
      };
    }
    if (now() >= deadline) return null;
    await sleep(delay);
    delay = Math.min(2000, delay + 300);
  }
}

/* ----------------------------------------------------------------- guards */

export type LeaseVerdict = "ok" | "unknown_job" | "lease_lost";

async function ownedJob(
  db: Db,
  worker: WorkerRow,
  jobId: string,
  token: string | null | undefined,
): Promise<{ verdict: LeaseVerdict; job: JobRow | null }> {
  const job = await getJobById(db, jobId);
  if (!job || job.provider !== WORKER_LANE) return { verdict: "unknown_job", job: null };
  const held = job.state === "running" && !!token && job.lease_token === token && job.leased_by === worker.id;
  return { verdict: held ? "ok" : "lease_lost", job };
}

export async function extendLease(
  db: Db,
  worker: WorkerRow,
  jobId: string,
  token: string | null | undefined,
  now = Date.now(),
): Promise<{ verdict: LeaseVerdict; leaseExpiresAt?: string }> {
  const { verdict } = await ownedJob(db, worker, jobId, token);
  if (verdict !== "ok") return { verdict };
  const expiresAt = leaseExpiry(now);
  const result = await db.run(
    "UPDATE image_jobs SET lease_expires_at = ?, updated_at = ? WHERE id = ? AND state = 'running' AND lease_token = ? AND leased_by = ?",
    [expiresAt, nowIso(), jobId, token ?? "", worker.id],
  );
  return result.changes === 1 ? { verdict: "ok", leaseExpiresAt: expiresAt } : { verdict: "lease_lost" };
}

/* --------------------------------------------------------------- complete */

export interface CompletedImage {
  bytes: Uint8Array;
}

export interface CompleteInput {
  leaseToken?: string | null;
  seed?: number | null;
  /** The generator the agent used; stored with the job. */
  model?: string;
  images: CompletedImage[];
}

export type CompleteResult =
  | { accepted: true; job: JobRow }
  | { accepted: false; reason: LeaseVerdict | "invalid_images"; detail?: string };

/** Reads width and height from a PNG, JPEG or WebP header. Null when the header is not understood. */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (offset: number, length: number) => String.fromCharCode(...bytes.subarray(offset, offset + length));
  if (bytes.byteLength >= 24 && bytes[0] === 0x89 && ascii(1, 3) === "PNG") {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (bytes.byteLength >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.byteLength) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1] ?? 0;
      if (marker === 0xff) {
        offset += 1;
        continue;
      }
      const length = view.getUint16(offset + 2);
      const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
      if (isFrame) return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
      offset += 2 + length;
    }
    return null;
  }
  if (bytes.byteLength >= 30 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    const chunk = ascii(12, 4);
    if (chunk === "VP8X") {
      const w = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
      const h = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
      return { width: w, height: h };
    }
    if (chunk === "VP8 ")
      return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
    if (chunk === "VP8L") {
      const bits = view.getUint32(21, true);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
  }
  return null;
}

/**
 * Stores the worker's images, records them and settles the credits. The claim only succeeds for the
 * worker that holds the current lease token, and the settle batch is guarded by that claim, so a late or
 * duplicated completion changes nothing and never charges twice.
 */
export async function completeWorkerJob(
  ctx: JobContext,
  worker: WorkerRow,
  jobId: string,
  input: CompleteInput,
): Promise<CompleteResult> {
  const { verdict, job } = await ownedJob(ctx.db, worker, jobId, input.leaseToken);
  if (verdict !== "ok" || !job) return { accepted: false, reason: verdict };

  if (input.images.length < 1 || input.images.length > job.num_images) {
    return { accepted: false, reason: "invalid_images", detail: `Send between 1 and ${job.num_images} images.` };
  }
  const params = JSON.parse(job.params_json) as JobParams;
  const prepared: Array<{ bytes: Uint8Array; mime: string; width: number; height: number }> = [];
  for (const image of input.images) {
    const mime = sniffImageMime(image.bytes);
    if (!mime)
      return { accepted: false, reason: "invalid_images", detail: "Each file must be a PNG, JPEG or WebP image." };
    if (image.bytes.byteLength > MAX_IMAGE_BYTES) {
      return { accepted: false, reason: "invalid_images", detail: "An image is larger than 25 MB." };
    }
    const size = imageSize(image.bytes);
    prepared.push({
      bytes: image.bytes,
      mime,
      width: size?.width ?? params.width,
      height: size?.height ?? params.height,
    });
  }

  const token = id("fin");
  const claimed = await ctx.db.run(
    `UPDATE image_jobs SET state = 'finalizing', finalize_token = ?, updated_at = ?
     WHERE id = ? AND state = 'running' AND lease_token = ? AND leased_by = ?`,
    [token, nowIso(), jobId, input.leaseToken ?? "", worker.id],
  );
  if (claimed.changes !== 1) return { accepted: false, reason: "lease_lost" };

  const written: string[] = [];
  try {
    const stored: ImageRow[] = [];
    for (const image of prepared) {
      const imageId = newImageId();
      const key = imageKey(job.tenant_id, imageId, extensionFor(image.mime));
      await ctx.images.put(key, image.bytes, { httpMetadata: { contentType: image.mime } });
      written.push(key);
      stored.push({
        id: imageId,
        tenant_id: job.tenant_id,
        job_id: job.id,
        brand_id: job.brand_id,
        r2_key: key,
        width: image.width,
        height: image.height,
        mime: image.mime,
        bytes: image.bytes.byteLength,
        seed: input.seed ?? params.seed ?? null,
        prompt: params.prompt,
        title: params.title ?? null,
        tags: params.tags?.length ? JSON.stringify(params.tags) : null,
        created_at: nowIso(),
        deleted_at: null,
      });
    }
    const perImage = Math.round(job.credits_reserved / job.num_images);
    const settled = await settle(ctx, job, token, {
      state: "done",
      charged: Math.min(job.credits_reserved, perImage * stored.length),
      blocked: 0,
      images: stored,
      renderedBy: input.model ? `worker:${input.model}`.slice(0, 100) : `worker:${worker.name}`.slice(0, 100),
    });
    return { accepted: true, job: settled };
  } catch (error) {
    await Promise.all(written.map((key) => ctx.images.delete(key).catch(() => undefined)));
    // Put the lease back so the worker can send the files again before it expires.
    await ctx.db.run(
      "UPDATE image_jobs SET state = 'running', finalize_token = NULL, updated_at = ? WHERE id = ? AND state = 'finalizing' AND finalize_token = ?",
      [nowIso(), jobId, token],
    );
    throw error instanceof Error ? error : new ImageError("PROVIDER_ERROR", "Storing the images failed.", true);
  }
}

/* ------------------------------------------------------------------- fail */

export interface FailInput {
  leaseToken?: string | null;
  code?: string;
  message?: string;
}

const WORKER_FAIL_CODES: ImageErrorCode[] = ["CONTENT_BLOCKED", "INVALID_INPUT", "PROVIDER_ERROR"];

/**
 * A worker reports it could not make the images. Blocked content ends the job (nothing is charged).
 * Anything else goes back to the queue for another try, and after the last attempt to the fallback provider.
 */
export async function failWorkerJob(
  ctx: JobContext,
  worker: WorkerRow,
  jobId: string,
  input: FailInput,
): Promise<{ accepted: boolean; reason?: LeaseVerdict; outcome?: "failed" | "requeued" | "rerouted" }> {
  const { verdict, job } = await ownedJob(ctx.db, worker, jobId, input.leaseToken);
  if (verdict !== "ok" || !job) return { accepted: false, reason: verdict };

  const code = WORKER_FAIL_CODES.find((candidate) => candidate === input.code) ?? "PROVIDER_ERROR";
  const message = (input.message?.trim() || "The worker could not make the images.").slice(0, 500);
  if (code === "CONTENT_BLOCKED" || code === "INVALID_INPUT") {
    await failJob(ctx, jobId, code, message, ["running"]);
    return { accepted: true, outcome: "failed" };
  }

  const released = await ctx.db.run(
    `UPDATE image_jobs SET state = 'queued', leased_by = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = ?
     WHERE id = ? AND state = 'running' AND lease_token = ? AND leased_by = ?`,
    [nowIso(), jobId, input.leaseToken ?? "", worker.id],
  );
  if (released.changes !== 1) return { accepted: false, reason: "lease_lost" };
  if (job.attempts >= MAX_WORKER_ATTEMPTS) {
    const latest = await getJobById(ctx.db, jobId);
    if (latest && (await rerouteToProvider(ctx, latest))) return { accepted: true, outcome: "rerouted" };
  }
  return { accepted: true, outcome: "requeued" };
}
