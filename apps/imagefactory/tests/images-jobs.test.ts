import assert from "node:assert/strict";
import { test } from "node:test";
import { getWallet, listLedger } from "@templatedesign/platform/credits";
import type { Db } from "@templatedesign/platform/db";
import { ImageError } from "../src/lib/images/errors";
import {
  failJob,
  finalizeJob,
  getJob,
  handleProviderWebhook,
  type JobContext,
  listJobImages,
  type StartJobInput,
  startJob,
  sweepJobs,
  waitForJob,
} from "../src/lib/images/jobs";
import "../src/lib/platform";
import { createTestDb } from "./support/db";
import { FakeBucket, FakeProvider, fakeImageFetch } from "./support/fakes";

const TENANT = "ten_1";

async function setup(provider = new FakeProvider()) {
  const { db, raw, close } = createTestDb();
  await db.run("INSERT INTO tenants (id, name, created_at) VALUES (?, 'Acme', '2026-01-01T00:00:00Z')", [TENANT]);
  const bucket = new FakeBucket();
  let now = Date.parse("2026-11-06T00:00:00Z");
  const ctx: JobContext = {
    db,
    images: bucket.asBucket(),
    provider,
    publicBase: "https://imagefactory.test/i",
    webhookUrl: "https://imagefactory.test/api/v1/fal-webhook",
    fetchImage: fakeImageFetch,
    sleep: async (ms) => {
      now += ms;
    },
    now: () => now,
  };
  return { db, raw, close, bucket, provider, ctx, advance: (ms: number) => (now += ms) };
}

const input = (overrides: Partial<StartJobInput> = {}): StartJobInput => ({
  tenantId: TENANT,
  userId: "usr_1",
  kind: "generate",
  modelId: "qwen-image",
  numImages: 2,
  params: { prompt: "A tidy desk", width: 816, height: 1224, outputFormat: "png" },
  ...overrides,
});

const pngImage = (blocked = false) => ({
  url: "https://fal.test/out.png",
  width: 816,
  height: 1224,
  contentType: "image/png",
  blocked,
});

async function ledgerNet(db: Db, jobId: string) {
  const rows = await listLedger(db, TENANT, 100);
  const forJob = rows.filter((row) => row.job_id === jobId);
  return {
    byKind: Object.fromEntries(
      ["reserve", "settle", "release"].map((kind) => [
        kind,
        forJob.filter((row) => row.kind === kind).reduce((sum, row) => sum + row.credits, 0),
      ]),
    ),
  };
}

test("startJob reserves the credits for the megapixels billed and stores the job as queued", async () => {
  const { ctx, db, provider, close } = await setup();
  try {
    const job = await startJob(ctx, input());
    // 816x1224 is 0.999 MP, billed as 1 MP at 4 credits per MP for 2 images.
    assert.equal(job.credits_reserved, 8);
    assert.equal(job.state, "queued");
    assert.equal(job.provider_job_id, "req-1");
    assert.equal(provider.submits[0].webhookUrl, ctx.webhookUrl);
    const wallet = await getWallet(db, TENANT);
    assert.equal(wallet.reserved, 8);
  } finally {
    close();
  }
});

test("a provider refusal at submit releases the reservation and fails the job", async () => {
  const provider = new FakeProvider({ submitError: new ImageError("PROVIDER_ERROR", "fal is down", true) });
  const { ctx, db, close } = await setup(provider);
  try {
    await assert.rejects(
      () => startJob(ctx, input()),
      (error: unknown) => error instanceof ImageError && error.code === "PROVIDER_ERROR",
    );
    const wallet = await getWallet(db, TENANT);
    assert.equal(wallet.reserved, 0);
    assert.equal(wallet.available, 50);
    const row = await db.first<{ state: string; error_code: string }>("SELECT state, error_code FROM image_jobs");
    assert.equal(row?.state, "failed");
    assert.equal(row?.error_code, "PROVIDER_ERROR");
  } finally {
    close();
  }
});

test("an oversize image is refused, and a price above the balance is reported before the provider is called", async () => {
  const { ctx, provider, close } = await setup();
  try {
    await assert.rejects(
      () =>
        startJob(
          ctx,
          input({ numImages: 4, params: { prompt: "Big", width: 2048, height: 2048, outputFormat: "png" } }),
        ),
      (error: unknown) => error instanceof ImageError && error.code === "INVALID_INPUT",
    );
    // 3.1 MP bills as 4 MP: 4 x 4 credits x 4 images = 64, more than the 50 free credits.
    await assert.rejects(
      () =>
        startJob(
          ctx,
          input({ numImages: 4, params: { prompt: "Big", width: 2048, height: 1536, outputFormat: "png" } }),
        ),
      (error: unknown) => error instanceof ImageError && error.code === "INSUFFICIENT_CREDITS",
    );
    assert.equal(provider.submits.length, 0);
  } finally {
    close();
  }
});

test("finalizing a finished job stores the images, charges per stored image and nets the ledger", async () => {
  const { ctx, db, bucket, provider, close } = await setup();
  try {
    const job = await startJob(ctx, input());
    provider.status_ = { state: "done" };
    provider.result_ = { images: [pngImage(), pngImage()], seed: 42 };
    const done = await finalizeJob(ctx, job.id);
    assert.equal(done?.state, "done");
    assert.equal(done?.credits_charged, 8);
    const images = await listJobImages(db, TENANT, job.id);
    assert.equal(images.length, 2);
    assert.equal(images[0].seed, 42);
    assert.ok(images.every((image) => bucket.objects.has(image.r2_key) && image.r2_key.startsWith("images/ten_1/")));
    const net = await ledgerNet(db, job.id);
    assert.equal(net.byKind.reserve + net.byKind.release, 0);
    assert.equal(net.byKind.settle, -8);
    const wallet = await getWallet(db, TENANT);
    assert.equal(wallet.reserved, 0);
    assert.equal(wallet.available, 42);
  } finally {
    close();
  }
});

test("a blocked image is not stored and not charged", async () => {
  const { ctx, db, provider, close } = await setup();
  try {
    const job = await startJob(ctx, input());
    provider.result_ = { images: [pngImage(), pngImage(true)], seed: 1 };
    const done = await finalizeJob(ctx, job.id);
    assert.equal(done?.state, "done");
    assert.equal(done?.credits_charged, 4);
    assert.equal(done?.blocked_count, 1);
    assert.equal((await getWallet(db, TENANT)).available, 46);
  } finally {
    close();
  }
});

test("when every image is blocked the job fails with CONTENT_BLOCKED and nothing is charged", async () => {
  const { ctx, db, provider, close } = await setup();
  try {
    const job = await startJob(ctx, input());
    provider.result_ = { images: [pngImage(true), pngImage(true)], seed: 1 };
    const done = await finalizeJob(ctx, job.id);
    assert.equal(done?.state, "failed");
    assert.equal(done?.error_code, "CONTENT_BLOCKED");
    assert.equal(done?.credits_charged, 0);
    assert.equal((await getWallet(db, TENANT)).available, 50);
  } finally {
    close();
  }
});

test("a webhook delivered twice, or racing the wait, settles the job once", async () => {
  const { ctx, db, provider, close } = await setup();
  try {
    const job = await startJob(ctx, input());
    provider.result_ = { images: [pngImage(), pngImage()], seed: 9 };
    const payload = { request_id: "req-1", status: "OK" as const };
    const outcomes = await Promise.all([
      handleProviderWebhook(ctx, payload),
      handleProviderWebhook(ctx, payload),
      finalizeJob(ctx, job.id),
    ]);
    assert.ok(outcomes.length === 3);
    assert.equal(await handleProviderWebhook(ctx, payload), "ignored");
    assert.equal((await listJobImages(db, TENANT, job.id)).length, 2);
    const net = await ledgerNet(db, job.id);
    assert.equal(net.byKind.settle, -8);
    assert.equal((await getWallet(db, TENANT)).available, 42);
  } finally {
    close();
  }
});

test("a webhook for an unknown request id is reported so the provider retries", async () => {
  const { ctx, close } = await setup();
  try {
    assert.equal(await handleProviderWebhook(ctx, { request_id: "nope", status: "OK" }), "unknown_job");
  } finally {
    close();
  }
});

test("a provider error callback fails the job and releases the reservation", async () => {
  const { ctx, db, close } = await setup();
  try {
    const job = await startJob(ctx, input());
    assert.equal(await handleProviderWebhook(ctx, { request_id: "req-1", status: "ERROR", error: "boom" }), "failed");
    const failed = await getJob(db, TENANT, job.id);
    assert.equal(failed?.state, "failed");
    assert.equal((await getWallet(db, TENANT)).available, 50);
    const net = await ledgerNet(db, job.id);
    assert.equal(net.byKind.reserve + net.byKind.release, 0);
  } finally {
    close();
  }
});

test("a retryable result failure leaves the job running for the next attempt", async () => {
  const { ctx, db, provider, close } = await setup();
  try {
    const job = await startJob(ctx, input());
    provider.result_ = async () => {
      throw new ImageError("PROVIDER_ERROR", "result fetch 502", true);
    };
    const pending = await finalizeJob(ctx, job.id);
    assert.equal(pending?.state, "running");
    assert.equal((await getWallet(db, TENANT)).reserved, 8);
    provider.result_ = { images: [pngImage(), pngImage()], seed: 3 };
    assert.equal((await finalizeJob(ctx, job.id))?.state, "done");
  } finally {
    close();
  }
});

test("waitForJob returns the queue position when the budget runs out, and the images when done", async () => {
  const { ctx, provider, close } = await setup();
  try {
    const job = await startJob(ctx, input());
    provider.status_ = { state: "queued", queuePosition: 3 };
    const pending = await waitForJob(ctx, TENANT, job.id, 5000);
    assert.equal(pending?.job.state, "queued");
    assert.equal(pending?.queuePosition, 3);
    assert.equal(pending?.images.length, 0);

    provider.status_ = { state: "done" };
    provider.result_ = { images: [pngImage(), pngImage()], seed: 5 };
    const finished = await waitForJob(ctx, TENANT, job.id, 5000);
    assert.equal(finished?.job.state, "done");
    assert.equal(finished?.images.length, 2);
  } finally {
    close();
  }
});

test("waitForJob does not return another tenant's job", async () => {
  const { ctx, db, close } = await setup();
  try {
    const job = await startJob(ctx, input());
    await db.run("INSERT INTO tenants (id, name, created_at) VALUES ('ten_2', 'Other', '2026-01-01T00:00:00Z')");
    assert.equal(await waitForJob(ctx, "ten_2", job.id, 0), null);
  } finally {
    close();
  }
});

test("the sweep finishes a job whose webhook never arrived and fails one the provider lost", async () => {
  const { ctx, db, provider, advance, close } = await setup();
  try {
    const finishing = await startJob(ctx, input());
    const lost = await startJob(ctx, input());
    await db.run("UPDATE image_jobs SET updated_at = '2020-01-01T00:00:00Z' WHERE id = ?", [finishing.id]);
    await db.run(
      "UPDATE image_jobs SET updated_at = '2020-01-01T00:00:00Z', created_at = '2020-01-01T00:00:00Z' WHERE id = ?",
      [lost.id],
    );
    provider.status_ = { state: "done" };
    provider.result_ = async () => {
      throw new ImageError("INVALID_INPUT", "gone", false);
    };
    // The first job is finalizing against a result that no longer exists; the second is past its deadline.
    advance(0);
    const result = await sweepJobs(ctx);
    assert.equal(result.checked, 2);
    for (const id of [finishing.id, lost.id]) assert.equal((await getJob(db, TENANT, id))?.state, "failed");
    assert.equal((await getWallet(db, TENANT)).available, 50);
  } finally {
    close();
  }
});

test("the sweep returns a stale submitting reservation", async () => {
  const { ctx, db, close } = await setup();
  try {
    const job = await startJob(ctx, input());
    await db.run(
      "UPDATE image_jobs SET state = 'submitting', provider_job_id = NULL, updated_at = '2020-01-01T00:00:00Z' WHERE id = ?",
      [job.id],
    );
    const result = await sweepJobs(ctx);
    assert.equal(result.failed, 1);
    assert.equal((await getWallet(db, TENANT)).reserved, 0);
  } finally {
    close();
  }
});

test("failing a settled job does nothing", async () => {
  const { ctx, db, provider, close } = await setup();
  try {
    const job = await startJob(ctx, input());
    provider.result_ = { images: [pngImage(), pngImage()], seed: 1 };
    await finalizeJob(ctx, job.id);
    const after = await failJob(ctx, job.id, "PROVIDER_ERROR", "late error");
    assert.equal(after?.state, "done");
    assert.equal((await getWallet(db, TENANT)).available, 42);
  } finally {
    close();
  }
});

test("a job the provider reports done but whose result can never be read is failed at the deadline and refunded", async () => {
  const { ctx, db, provider, close } = await setup();
  try {
    const job = await startJob(ctx, input());
    provider.status_ = { state: "done" };
    provider.result_ = async () => {
      throw new ImageError("PROVIDER_ERROR", "result fetch 404", true);
    };
    await db.run("UPDATE image_jobs SET updated_at = '2020-01-01T00:00:00Z' WHERE id = ?", [job.id]);

    // Within the deadline the job stays open and keeps its reservation.
    let result = await sweepJobs(ctx);
    assert.equal(result.failed, 0);
    assert.equal((await getJob(db, TENANT, job.id))?.state, "running");
    assert.equal((await getWallet(db, TENANT)).reserved, 8);

    // Past the 30-minute deadline the sweep gives up and returns the credits.
    await db.run(
      "UPDATE image_jobs SET updated_at = '2020-01-01T00:00:00Z', created_at = '2020-01-01T00:00:00Z' WHERE id = ?",
      [job.id],
    );
    result = await sweepJobs(ctx);
    assert.equal(result.failed, 1);
    const failed = await getJob(db, TENANT, job.id);
    assert.equal(failed?.state, "failed");
    assert.equal(failed?.error_code, "PROVIDER_ERROR");
    const wallet = await getWallet(db, TENANT);
    assert.equal(wallet.reserved, 0);
    assert.equal(wallet.available, 50);
  } finally {
    close();
  }
});

test("a new account starts with no credits until an admin grants some", async () => {
  const { db, close } = createTestDb({ freeCredits: null });
  try {
    await db.run("INSERT INTO tenants (id, name, created_at) VALUES ('t_new', 'New', '2026-01-01T00:00:00Z')");
    const wallet = await getWallet(db, "t_new");
    assert.equal(wallet.available, 0);
    assert.equal(wallet.free, 0);
    assert.equal((await listLedger(db, "t_new")).length, 0, "no grant is recorded");
  } finally {
    close();
  }
});
