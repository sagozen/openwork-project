import { alertOperators } from "@templatedesign/platform/alerts";
import { d1Db } from "@templatedesign/platform/db";
import { purgeDueDeletions } from "@templatedesign/platform/deletion";
import { retryFailedEmails } from "@templatedesign/platform/emails/send";
import { sweepJobs, WORKER_LANE } from "./images/jobs";
import { MODELS, modelSpec } from "./images/models";
import { billedMegapixels } from "./images/pricing";
import { serviceDeps } from "./images/service";
import type { Env } from "./types";

/** An image deleted this long ago has its file removed for good. */
const DELETED_IMAGE_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Every five minutes: finish or fail jobs the provider never reported on. */
export async function runSweep(env: Env) {
  return sweepJobs((await serviceDeps(env)).job);
}

export interface DailyDigest {
  jobs: number;
  failed: number;
  imagesMade: number;
  creditsCharged: number;
  estimatedProviderUsd: number;
  /** Images made by a registered worker, which cost no provider fees. */
  workerImages: number;
  revenueUsd: number;
}

interface DigestRow {
  model: string;
  provider: string;
  state: string;
  num_images: number;
  credits_charged: number | null;
  params_json: string;
}

/** What the last 24 hours cost at the provider against the credits charged for them. */
export async function buildDigest(env: Env, now = Date.now()): Promise<DailyDigest> {
  const rows = await d1Db(env.DB).all<DigestRow>(
    "SELECT model, provider, state, num_images, credits_charged, params_json FROM image_jobs WHERE created_at >= ? AND state IN ('done', 'failed')",
    [new Date(now - DAY_MS).toISOString()],
  );
  const digest: DailyDigest = {
    jobs: rows.length,
    failed: 0,
    imagesMade: 0,
    creditsCharged: 0,
    estimatedProviderUsd: 0,
    workerImages: 0,
    revenueUsd: 0,
  };
  for (const row of rows) {
    if (row.state === "failed") {
      digest.failed += 1;
      continue;
    }
    const spec = modelSpec(row.model) ?? MODELS["qwen-image"];
    const params = JSON.parse(row.params_json) as { width: number; height: number };
    digest.imagesMade += row.num_images;
    digest.creditsCharged += row.credits_charged ?? 0;
    if (row.provider === WORKER_LANE) {
      digest.workerImages += row.num_images;
      continue;
    }
    digest.estimatedProviderUsd +=
      billedMegapixels(params.width, params.height) * spec.providerUsdPerMp * row.num_images;
  }
  digest.revenueUsd = digest.creditsCharged / 100;
  return digest;
}

/**
 * Remove files of images deleted more than 30 days ago, up to 200 rows. The public URL already
 * 404s at delete time; this drops the R2 object and the row. The hourly cron is the regular pass.
 */
export async function purgeExpiredImages(env: Env, now = Date.now()): Promise<number> {
  const db = d1Db(env.DB);
  const cutoff = new Date(now - DELETED_IMAGE_RETENTION_DAYS * DAY_MS).toISOString();
  const expired = await db.all<{ id: string; r2_key: string }>(
    "SELECT id, r2_key FROM images WHERE deleted_at IS NOT NULL AND deleted_at < ? LIMIT 200",
    [cutoff],
  );
  if (expired.length === 0) return 0;
  await env.IMAGES.delete(expired.map((image) => image.r2_key));
  await db.batch(expired.map((image) => ({ sql: "DELETE FROM images WHERE id = ?", params: [image.id] })));
  return expired.length;
}

/**
 * Once a day: remove files of images deleted a month ago, complete due account deletions, retry
 * failed emails and send the operators a spend digest.
 */
export async function runDailyCron(env: Env, now = Date.now()) {
  const db = d1Db(env.DB);
  const imagesPurged = await purgeExpiredImages(env, now);

  const [deletions, emails] = await Promise.all([
    purgeDueDeletions(env, db, { delete: async () => {} }),
    retryFailedEmails(env, db),
  ]);

  const digest = await buildDigest(env, now);
  const failureRate = digest.jobs === 0 ? 0 : Math.round((digest.failed / digest.jobs) * 100);
  await alertOperators(env, db, {
    kind: "imagefactory_daily_digest",
    summary: `${digest.imagesMade} images from ${digest.jobs} jobs in 24 hours`,
    detail: {
      failed_jobs: digest.failed,
      failure_rate_percent: failureRate,
      credits_charged: digest.creditsCharged,
      provider_cost_usd: digest.estimatedProviderUsd.toFixed(2),
      worker_images: digest.workerImages,
      credit_value_usd: digest.revenueUsd.toFixed(2),
    },
  });

  return { imagesPurged, deletions, emails, digest };
}
