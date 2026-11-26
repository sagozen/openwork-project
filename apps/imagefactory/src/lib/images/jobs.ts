import { ensureWallet, planSettlement, releaseCredits, reserveCredits } from "@templatedesign/platform/credits";
import type { Db, Statement } from "@templatedesign/platform/db";
import { id, nowIso } from "@templatedesign/platform/db";
import { HttpError } from "@templatedesign/platform/http";
import { ImageError, type ImageErrorCode } from "./errors";
import { type ModelId, modelSpec } from "./models";
import { assertSize, billedMegapixels, creditsFor, type PriceOverrides } from "./pricing";
import type { ImageProvider } from "./provider";
import { extensionFor, imageKey, newImageId, publicImageUrl } from "./storage";
import { DEFAULT_WORKER_WAIT_SECONDS, hasFreshWorker, MAX_WORKER_ATTEMPTS } from "./workers";

/** Provider column value for jobs handed to a registered worker instead of an external provider. */
export const WORKER_LANE = "worker";

/** A reference image as stored with a worker-lane job: a public URL, or a brand asset signed at lease time. */
export type ReferenceInput = { url: string } | { assetId: string };

/** Everything the job service needs. Built per request from the Worker bindings. */
export interface JobContext {
  db: Db;
  images: R2Bucket;
  /** The external provider: the only lane when no worker is online, the fallback when one is. */
  provider: ImageProvider;
  /** Signs a short-lived link for a private brand asset. Needed to lease or reroute an edit job. */
  signReference?: (assetId: string) => Promise<string>;
  /** Seconds a job may wait for a worker before the provider takes it. */
  workerWaitSeconds?: number;
  /** Public prefix generated images are served from, e.g. `https://host/i`. */
  publicBase: string;
  /** Absolute URL the provider calls when a job finishes. */
  webhookUrl: string;
  pricing?: PriceOverrides;
  /** Downloads provider output. Defaults to global fetch. */
  fetchImage?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export type JobState = "submitting" | "queued" | "running" | "finalizing" | "done" | "failed";

export interface JobRow {
  id: string;
  tenant_id: string;
  user_id: string | null;
  brand_id: string | null;
  kind: "generate" | "edit";
  model: string;
  params_json: string;
  provider: string;
  provider_job_id: string | null;
  status_url: string | null;
  response_url: string | null;
  state: JobState;
  num_images: number;
  credits_reserved: number;
  credits_charged: number | null;
  blocked_count: number;
  finalize_token: string | null;
  refs_json: string | null;
  leased_by: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  attempts: number;
  rendered_by: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

export interface ImageRow {
  id: string;
  tenant_id: string;
  job_id: string;
  brand_id: string | null;
  r2_key: string;
  width: number;
  height: number;
  mime: string;
  bytes: number;
  seed: number | null;
  prompt: string;
  title: string | null;
  tags: string | null;
  created_at: string;
  deleted_at: string | null;
}

/** What is stored in `params_json`: the request as sent, minus anything signed or secret. */
export interface JobParams {
  /** The prompt sent to the model (brand style already composed in). */
  prompt: string;
  /** The caller's own words, before composition. */
  userPrompt?: string;
  negativePrompt?: string;
  width: number;
  height: number;
  seed?: number;
  outputFormat: "png" | "jpeg" | "webp";
  /** Image ids or brand asset ids used as references, for display only. */
  referenceIds?: string[];
  preset?: string;
  text?: string;
  title?: string;
  tags?: string[];
}

export interface StartJobInput {
  tenantId: string;
  userId: string | null;
  brandId?: string | null;
  kind: "generate" | "edit";
  modelId: ModelId;
  numImages: number;
  params: JobParams;
  /** Absolute URLs the provider fetches for an edit. Never persisted. */
  imageUrls?: string[];
  /** The same references as descriptors, kept with a worker-lane job so the links are signed when leased. */
  references?: ReferenceInput[];
}

export interface JobSnapshot {
  job: JobRow;
  images: ImageRow[];
  queuePosition?: number;
}

const TERMINAL: JobState[] = ["done", "failed"];
export const isTerminal = (state: JobState) => TERMINAL.includes(state);

const WAIT_BUDGET_MS = 45_000;
const SUBMIT_STALE_MS = 2 * 60 * 1000;
const POLL_STALE_MS = 2 * 60 * 1000;
const FINALIZING_STALE_MS = 5 * 60 * 1000;
const JOB_DEADLINE_MS = 30 * 60 * 1000;
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;

const clock = (ctx: JobContext) => (ctx.now ? ctx.now() : Date.now());
const pause = (ctx: JobContext, ms: number) =>
  ctx.sleep ? ctx.sleep(ms) : new Promise<void>((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ reads */

export async function getJob(db: Db, tenantId: string, jobId: string): Promise<JobRow | null> {
  return db.first<JobRow>("SELECT * FROM image_jobs WHERE id = ? AND tenant_id = ?", [jobId, tenantId]);
}

/** Internal lookup for the webhook and the cron sweep, which have no tenant yet. */
export async function getJobById(db: Db, jobId: string): Promise<JobRow | null> {
  return db.first<JobRow>("SELECT * FROM image_jobs WHERE id = ?", [jobId]);
}

export async function listJobImages(db: Db, tenantId: string, jobId: string): Promise<ImageRow[]> {
  return db.all<ImageRow>(
    "SELECT * FROM images WHERE job_id = ? AND tenant_id = ? AND deleted_at IS NULL ORDER BY created_at, id",
    [jobId, tenantId],
  );
}

async function snapshot(db: Db, job: JobRow, queuePosition?: number): Promise<JobSnapshot> {
  const images = job.state === "done" ? await listJobImages(db, job.tenant_id, job.id) : [];
  return { job, images, queuePosition };
}

/* ------------------------------------------------------------------ start */

function toImageError(error: unknown): ImageError {
  if (error instanceof ImageError) return error;
  if (error instanceof HttpError && error.code === "insufficient_credits") {
    return new ImageError("INSUFFICIENT_CREDITS", error.message, false, error.details);
  }
  return new ImageError("PROVIDER_ERROR", error instanceof Error ? error.message : "Unexpected error.", true);
}

/**
 * Validate, price, reserve credits, record the job and hand it to the provider. The reservation is
 * released again if the provider refuses the submit, so a failed start never costs credits.
 */
export async function startJob(ctx: JobContext, input: StartJobInput): Promise<JobRow> {
  const model = modelSpec(input.modelId);
  if (!model) throw new ImageError("INVALID_INPUT", `Unknown model "${input.modelId}".`);
  if (model.kind !== input.kind) {
    throw new ImageError("INVALID_INPUT", `${model.label} cannot be used to ${input.kind} images.`);
  }
  const { width, height } = input.params;
  assertSize(model, width, height, input.numImages);
  if (input.kind === "edit") {
    const limits = model.referenceImages ?? { min: 1, max: 3 };
    const count = input.imageUrls?.length ?? 0;
    if (count < limits.min || count > limits.max) {
      throw new ImageError("INVALID_INPUT", `Provide between ${limits.min} and ${limits.max} reference images.`);
    }
  }
  if (!input.params.prompt.trim()) throw new ImageError("INVALID_INPUT", "A prompt is required.");

  const credits = creditsFor(model, width, height, input.numImages, ctx.pricing);
  const jobId = id("job");
  // A registered worker that can take this job gets it; otherwise (or later, if it stalls) the provider does.
  const onWorker = await hasFreshWorker(ctx.db, input.kind, billedMegapixels(width, height), clock(ctx));
  const references = input.references ?? input.imageUrls?.map((url) => ({ url }));
  try {
    await reserveCredits(ctx.db, input.tenantId, credits, jobId);
  } catch (error) {
    throw toImageError(error);
  }

  const timestamp = nowIso();
  try {
    await ctx.db.run(
      `INSERT INTO image_jobs (id, tenant_id, user_id, brand_id, kind, model, params_json, provider, state,
         num_images, credits_reserved, refs_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        jobId,
        input.tenantId,
        input.userId,
        input.brandId ?? null,
        input.kind,
        model.id,
        JSON.stringify(input.params),
        onWorker ? WORKER_LANE : ctx.provider.id,
        onWorker ? "queued" : "submitting",
        input.numImages,
        credits,
        onWorker && references?.length ? JSON.stringify(references) : null,
        timestamp,
        timestamp,
      ],
    );
  } catch (error) {
    await releaseCredits(ctx.db, input.tenantId, jobId, credits);
    throw toImageError(error);
  }

  if (!onWorker) {
    try {
      await submitToProvider(ctx, jobId, input.imageUrls);
    } catch (error) {
      const failure = toImageError(error);
      await failJob(ctx, jobId, failure.code, failure.message, ["submitting"]);
      throw failure;
    }
  }

  const job = await getJobById(ctx.db, jobId);
  if (!job) throw new ImageError("PROVIDER_ERROR", "The job was not stored.", true);
  return job;
}

/** Sends a `submitting` job to the external provider and records its request id. Throws on a refusal. */
async function submitToProvider(ctx: JobContext, jobId: string, imageUrls: string[] | undefined): Promise<void> {
  const job = await getJobById(ctx.db, jobId);
  const model = job ? modelSpec(job.model) : undefined;
  if (!job || !model) throw new ImageError("PROVIDER_ERROR", "The job was not stored.", true);
  const params = JSON.parse(job.params_json) as JobParams;
  const submitted = await ctx.provider.submit({
    model,
    prompt: params.prompt,
    negativePrompt: params.negativePrompt,
    width: params.width,
    height: params.height,
    numImages: job.num_images,
    seed: params.seed,
    imageUrls,
    outputFormat: params.outputFormat,
    webhookUrl: ctx.webhookUrl,
  });
  await ctx.db.run(
    `UPDATE image_jobs SET provider_job_id = ?, status_url = ?, response_url = ?, state = 'queued', updated_at = ?
     WHERE id = ? AND state = 'submitting'`,
    [submitted.providerJobId, submitted.statusUrl, submitted.responseUrl, nowIso(), jobId],
  );
}

/* ------------------------------------------------------- worker lane */

/** Reference links for a worker-lane job. Brand assets are signed now, so the links are fresh. */
export async function resolveReferenceUrls(ctx: Pick<JobContext, "signReference">, job: JobRow): Promise<string[]> {
  if (!job.refs_json) return [];
  const refs = JSON.parse(job.refs_json) as ReferenceInput[];
  const urls: string[] = [];
  for (const ref of refs) {
    if ("url" in ref) urls.push(ref.url);
    else if (ctx.signReference) urls.push(await ctx.signReference(ref.assetId));
    else throw new ImageError("PROVIDER_ERROR", "Brand references cannot be signed here.", false);
  }
  return urls;
}

/** True when the worker lane should stop trying and let the provider take the job. */
async function workerJobNeedsFallback(ctx: JobContext, job: JobRow): Promise<boolean> {
  const now = clock(ctx);
  const waitMs = (ctx.workerWaitSeconds ?? DEFAULT_WORKER_WAIT_SECONDS) * 1000;
  if (job.state === "running") {
    // A live lease means a worker is on it. After an expired lease the job is only re-leased while attempts remain.
    if (job.lease_expires_at && Date.parse(job.lease_expires_at) > now) return false;
    if (job.attempts >= MAX_WORKER_ATTEMPTS) return true;
    return now - Date.parse(job.lease_expires_at ?? job.updated_at) > waitMs;
  }
  if (job.state !== "queued") return false;
  if (job.attempts >= MAX_WORKER_ATTEMPTS) return true;
  if (now - Date.parse(job.updated_at) > waitMs) return true;
  const params = JSON.parse(job.params_json) as JobParams;
  return !(await hasFreshWorker(ctx.db, job.kind, billedMegapixels(params.width, params.height), now));
}

/**
 * Moves a worker-lane job to the external provider with its credits still reserved. Only one caller wins the
 * switch, and a worker that still holds the old lease is refused when it tries to complete.
 */
export async function rerouteToProvider(ctx: JobContext, job: JobRow): Promise<boolean> {
  const switched = await ctx.db.run(
    `UPDATE image_jobs SET provider = ?, state = 'submitting', leased_by = NULL, lease_token = NULL,
       lease_expires_at = NULL, updated_at = ?
     WHERE id = ? AND provider = ? AND (state = 'queued' OR (state = 'running' AND lease_expires_at < ?))`,
    [ctx.provider.id, nowIso(), job.id, WORKER_LANE, nowIso()],
  );
  if (switched.changes !== 1) return false;
  try {
    await submitToProvider(ctx, job.id, await resolveReferenceUrls(ctx, job));
  } catch (error) {
    const failure = toImageError(error);
    await failJob(ctx, job.id, failure.code, failure.message, ["submitting"]);
  }
  return true;
}

/** Called while a caller waits and by the sweep: hands a stalled worker-lane job to the provider. */
export async function rerouteIfStalled(ctx: JobContext, job: JobRow): Promise<boolean> {
  if (job.provider !== WORKER_LANE || !(await workerJobNeedsFallback(ctx, job))) return false;
  return rerouteToProvider(ctx, job);
}

/* ---------------------------------------------------------------- settle */

export async function claim(db: Db, jobId: string, from: JobState[]): Promise<string | null> {
  const token = id("fin");
  const marks = from.map(() => "?").join(", ");
  const result = await db.run(
    `UPDATE image_jobs SET state = 'finalizing', finalize_token = ?, updated_at = ? WHERE id = ? AND state IN (${marks})`,
    [token, nowIso(), jobId, ...from],
  );
  return result.changes === 1 ? token : null;
}

export async function unclaim(db: Db, jobId: string, token: string): Promise<void> {
  await db.run(
    "UPDATE image_jobs SET state = 'running', finalize_token = NULL, updated_at = ? WHERE id = ? AND state = 'finalizing' AND finalize_token = ?",
    [nowIso(), jobId, token],
  );
}

export interface Outcome {
  state: "done" | "failed";
  charged: number;
  blocked: number;
  errorCode?: ImageErrorCode;
  errorMessage?: string;
  images: ImageRow[];
  /** The generator named by a worker, stored with the job. */
  renderedBy?: string;
}

/**
 * The job transition, the image rows and the wallet movement commit in one batch, and every
 * statement after the first is guarded by the claim token. A second attempt that lost the claim
 * changes nothing, so a job can never be charged twice.
 */
export async function settle(ctx: JobContext, job: JobRow, token: string, outcome: Outcome): Promise<JobRow> {
  const wallet = await ensureWallet(ctx.db, job.tenant_id);
  const guardClause = "EXISTS (SELECT 1 FROM image_jobs WHERE id = ? AND state = ? AND finalize_token = ?)";
  const guardParams = [job.id, outcome.state, token];
  const plan = planSettlement(wallet, job.tenant_id, job.id, job.credits_reserved, outcome.charged, {
    clause: guardClause,
    params: guardParams,
  });
  const finishedAt = nowIso();
  const statements: Statement[] = [
    {
      sql: `UPDATE image_jobs SET state = ?, credits_charged = ?, blocked_count = ?, error_code = ?, error_message = ?,
              rendered_by = COALESCE(?, rendered_by), finished_at = ?, updated_at = ?
            WHERE id = ? AND state = 'finalizing' AND finalize_token = ?`,
      params: [
        outcome.state,
        outcome.charged,
        outcome.blocked,
        outcome.errorCode ?? null,
        outcome.errorMessage ?? null,
        outcome.renderedBy ?? null,
        finishedAt,
        finishedAt,
        job.id,
        token,
      ],
    },
  ];
  for (const image of outcome.images) {
    statements.push({
      sql: `INSERT INTO images (id, tenant_id, job_id, brand_id, r2_key, width, height, mime, bytes, seed, prompt,
              title, tags, created_at)
            SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guardClause}`,
      params: [
        image.id,
        image.tenant_id,
        image.job_id,
        image.brand_id,
        image.r2_key,
        image.width,
        image.height,
        image.mime,
        image.bytes,
        image.seed,
        image.prompt,
        image.title,
        image.tags,
        image.created_at,
        ...guardParams,
      ],
    });
  }
  statements.push(...plan.statements);
  await ctx.db.batch(statements);

  const latest = (await getJobById(ctx.db, job.id)) ?? job;
  if (latest.state !== outcome.state || latest.finalize_token !== token) {
    // Another attempt settled this job; the objects written for this attempt are orphans.
    await Promise.all(outcome.images.map((image) => ctx.images.delete(image.r2_key).catch(() => undefined)));
  }
  return latest;
}

/** Marks a job failed and returns every reserved credit. Idempotent: only the claim winner acts. */
export async function failJob(
  ctx: JobContext,
  jobId: string,
  code: ImageErrorCode,
  message: string,
  from: JobState[] = ["submitting", "queued", "running"],
): Promise<JobRow | null> {
  const job = await getJobById(ctx.db, jobId);
  if (!job || isTerminal(job.state)) return job;
  const token = await claim(ctx.db, jobId, from);
  if (!token) return getJobById(ctx.db, jobId);
  return settle(ctx, job, token, {
    state: "failed",
    charged: 0,
    blocked: 0,
    errorCode: code,
    errorMessage: message.slice(0, 500),
    images: [],
  });
}

/* -------------------------------------------------------------- finalize */

async function download(ctx: JobContext, url: string): Promise<Uint8Array> {
  const response = await (ctx.fetchImage ?? fetch)(url);
  if (!response.ok) throw new ImageError("PROVIDER_ERROR", `Downloading the image failed (${response.status}).`, true);
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > MAX_DOWNLOAD_BYTES) throw new ImageError("PROVIDER_ERROR", "The generated image is too large.", false);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_DOWNLOAD_BYTES) {
    throw new ImageError("PROVIDER_ERROR", "The generated image is too large.", false);
  }
  return bytes;
}

/**
 * Copies the provider output into R2, records the images and settles the credits. Safe to call
 * from the webhook, the in-tool wait and the cron at the same time: one caller wins the claim.
 */
export async function finalizeJob(ctx: JobContext, jobId: string): Promise<JobRow | null> {
  const job = await getJobById(ctx.db, jobId);
  if (!job || isTerminal(job.state) || !job.response_url) return job;
  const token = await claim(ctx.db, jobId, ["queued", "running"]);
  if (!token) return getJobById(ctx.db, jobId);

  const params = JSON.parse(job.params_json) as JobParams;
  const written: string[] = [];
  try {
    const result = await ctx.provider.result({ responseUrl: job.response_url });
    const stored: ImageRow[] = [];
    let blocked = 0;
    for (const image of result.images) {
      if (image.blocked) {
        blocked += 1;
        continue;
      }
      const bytes = await download(ctx, image.url);
      const imageId = newImageId();
      const extension = extensionFor(image.contentType);
      const key = imageKey(job.tenant_id, imageId, extension);
      await ctx.images.put(key, bytes, { httpMetadata: { contentType: image.contentType } });
      written.push(key);
      stored.push({
        id: imageId,
        tenant_id: job.tenant_id,
        job_id: job.id,
        brand_id: job.brand_id,
        r2_key: key,
        width: image.width || params.width,
        height: image.height || params.height,
        mime: image.contentType,
        bytes: bytes.byteLength,
        seed: result.seed,
        prompt: params.prompt,
        title: params.title ?? null,
        tags: params.tags?.length ? JSON.stringify(params.tags) : null,
        created_at: nowIso(),
        deleted_at: null,
      });
    }

    if (stored.length === 0) {
      return settle(ctx, job, token, {
        state: "failed",
        charged: 0,
        blocked,
        errorCode: "CONTENT_BLOCKED",
        errorMessage: "The provider's safety check blocked every image. Nothing was charged.",
        images: [],
      });
    }
    const perImage = Math.round(job.credits_reserved / job.num_images);
    return settle(ctx, job, token, {
      state: "done",
      charged: Math.min(job.credits_reserved, perImage * stored.length),
      blocked,
      images: stored,
    });
  } catch (error) {
    await Promise.all(written.map((key) => ctx.images.delete(key).catch(() => undefined)));
    const failure = toImageError(error);
    if (failure.retryable) {
      // Leave the job running so the webhook retry or the cron sweep tries again.
      await unclaim(ctx.db, jobId, token);
      return getJobById(ctx.db, jobId);
    }
    return settle(ctx, job, token, {
      state: "failed",
      charged: 0,
      blocked: 0,
      errorCode: failure.code,
      errorMessage: failure.message.slice(0, 500),
      images: [],
    });
  }
}

/* ------------------------------------------------------------------ wait */

/**
 * Polls the provider for up to `budgetMs`. A job that is still running comes back unfinished with
 * its queue position, so a slow queue returns a job id instead of timing out the client.
 */
export async function waitForJob(
  ctx: JobContext,
  tenantId: string,
  jobId: string,
  budgetMs = WAIT_BUDGET_MS,
): Promise<JobSnapshot | null> {
  const started = clock(ctx);
  let polls = 0;
  let queuePosition: number | undefined;
  for (;;) {
    const job = await getJob(ctx.db, tenantId, jobId);
    if (!job) return null;
    if (isTerminal(job.state)) return snapshot(ctx.db, job);
    if (job.provider === WORKER_LANE) {
      if (await rerouteIfStalled(ctx, job)) continue;
    } else if (job.provider_job_id && job.status_url) {
      try {
        const status = await ctx.provider.status({ statusUrl: job.status_url });
        queuePosition = status.queuePosition;
        if (status.state === "done") {
          const finished = await finalizeJob(ctx, jobId);
          if (finished && isTerminal(finished.state)) return snapshot(ctx.db, finished);
        } else if (status.state === "running" && job.state === "queued") {
          await ctx.db.run(
            "UPDATE image_jobs SET state = 'running', updated_at = ? WHERE id = ? AND state = 'queued'",
            [nowIso(), jobId],
          );
        }
      } catch (error) {
        if (!(error instanceof ImageError) || !error.retryable) throw error;
      }
    }
    const elapsed = clock(ctx) - started;
    if (elapsed >= budgetMs) {
      const latest = (await getJob(ctx.db, tenantId, jobId)) ?? job;
      return snapshot(ctx.db, latest, queuePosition);
    }
    polls += 1;
    await pause(ctx, Math.min(polls <= 3 ? 1000 : 2000, budgetMs - elapsed));
  }
}

/** One status check without waiting, for the `get_job` tool. */
export async function pollJob(ctx: JobContext, tenantId: string, jobId: string): Promise<JobSnapshot | null> {
  return waitForJob(ctx, tenantId, jobId, 0);
}

/* --------------------------------------------------------------- webhook */

export interface WebhookPayload {
  request_id: string;
  status: "OK" | "ERROR";
  error?: string;
}

export type WebhookOutcome = "unknown_job" | "finalized" | "failed" | "ignored";

export async function findJobByProviderId(ctx: JobContext, providerJobId: string): Promise<JobRow | null> {
  return ctx.db.first<JobRow>("SELECT * FROM image_jobs WHERE provider = ? AND provider_job_id = ?", [
    ctx.provider.id,
    providerJobId,
  ]);
}

/** Idempotent per request id: fal retries a delivery up to 31 times. */
export async function handleProviderWebhook(ctx: JobContext, payload: WebhookPayload): Promise<WebhookOutcome> {
  const job = await findJobByProviderId(ctx, payload.request_id);
  if (!job) return "unknown_job";
  if (isTerminal(job.state)) return "ignored";
  if (payload.status === "ERROR") {
    await failJob(ctx, job.id, "PROVIDER_ERROR", payload.error ?? "The provider reported an error.", [
      "queued",
      "running",
    ]);
    return "failed";
  }
  await finalizeJob(ctx, job.id);
  return "finalized";
}

/* ------------------------------------------------------------------ sweep */

export interface SweepResult {
  checked: number;
  finalized: number;
  failed: number;
  recovered: number;
}

/**
 * Cron sweep: finish jobs whose webhook never arrived, fail jobs the provider lost, and release a
 * claim whose holder died. Every credit still reserved after 30 minutes is returned.
 */
export async function sweepJobs(ctx: JobContext): Promise<SweepResult> {
  const result: SweepResult = { checked: 0, finalized: 0, failed: 0, recovered: 0 };
  const now = clock(ctx);
  const cutoff = (ms: number) => new Date(now - ms).toISOString();

  const stuckClaims = await ctx.db.all<JobRow>(
    "SELECT * FROM image_jobs WHERE state = 'finalizing' AND updated_at < ? LIMIT 50",
    [cutoff(FINALIZING_STALE_MS)],
  );
  for (const job of stuckClaims) {
    if (job.finalize_token) await unclaim(ctx.db, job.id, job.finalize_token);
    result.recovered += 1;
  }

  const stuckSubmits = await ctx.db.all<JobRow>(
    "SELECT * FROM image_jobs WHERE state = 'submitting' AND updated_at < ? LIMIT 50",
    [cutoff(SUBMIT_STALE_MS)],
  );
  for (const job of stuckSubmits) {
    result.checked += 1;
    await failJob(ctx, job.id, "PROVIDER_ERROR", "The request never reached the provider.", ["submitting"]);
    result.failed += 1;
  }

  // Worker-lane jobs wait for a lease, not for the provider: hand the stalled ones to the provider, and
  // give up on any that is still open after the deadline.
  const waiting = await ctx.db.all<JobRow>(
    "SELECT * FROM image_jobs WHERE provider = ? AND state IN ('queued', 'running') ORDER BY created_at LIMIT 50",
    [WORKER_LANE],
  );
  for (const job of waiting) {
    result.checked += 1;
    if (await rerouteIfStalled(ctx, job)) {
      result.recovered += 1;
    } else if (now - Date.parse(job.created_at) > JOB_DEADLINE_MS) {
      await failJob(ctx, job.id, "PROVIDER_ERROR", "No worker finished the job within 30 minutes.");
      result.failed += 1;
    }
  }

  const open = await ctx.db.all<JobRow>(
    "SELECT * FROM image_jobs WHERE provider <> ? AND state IN ('queued', 'running') AND updated_at < ? ORDER BY updated_at LIMIT 50",
    [WORKER_LANE, cutoff(POLL_STALE_MS)],
  );
  for (const job of open) {
    result.checked += 1;
    const expired = now - Date.parse(job.created_at) > JOB_DEADLINE_MS;
    try {
      if (job.status_url) {
        const status = await ctx.provider.status({ statusUrl: job.status_url });
        if (status.state === "done") {
          const finished = await finalizeJob(ctx, job.id);
          if (finished?.state === "done") result.finalized += 1;
          if (finished?.state === "failed") result.failed += 1;
          // A job whose result still cannot be read stays open and falls through to the deadline below.
          if (finished && isTerminal(finished.state)) continue;
        }
      }
    } catch (error) {
      if (!(error instanceof ImageError) || !error.retryable) {
        await failJob(ctx, job.id, "PROVIDER_ERROR", error instanceof Error ? error.message : "Provider error.");
        result.failed += 1;
        continue;
      }
    }
    if (expired) {
      await failJob(ctx, job.id, "PROVIDER_ERROR", "The provider did not finish within 30 minutes.");
      result.failed += 1;
    } else {
      await ctx.db.run("UPDATE image_jobs SET updated_at = ? WHERE id = ? AND state IN ('queued', 'running')", [
        nowIso(),
        job.id,
      ]);
    }
  }
  return result;
}

/** Public URL of a stored image row. */
export function imageUrl(ctx: Pick<JobContext, "publicBase">, image: Pick<ImageRow, "id" | "mime">): string {
  return publicImageUrl(ctx.publicBase, image.id, extensionFor(image.mime));
}
