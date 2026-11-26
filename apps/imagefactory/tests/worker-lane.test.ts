import assert from "node:assert/strict";
import { test } from "node:test";
import { getWallet } from "@templatedesign/platform/credits";
import type { Db } from "@templatedesign/platform/db";
import { getJob, type JobContext, type StartJobInput, startJob, sweepJobs, waitForJob } from "../src/lib/images/jobs";
import "../src/lib/platform";
import { completeWorkerJob, extendLease, failWorkerJob, imageSize, leaseImageJob } from "../src/lib/images/worker-jobs";
import {
  authenticateWorker,
  hasFreshWorker,
  recordHeartbeat,
  registerWorker,
  rotateWorkerToken,
  setWorkerDisabled,
  type WorkerRow,
} from "../src/lib/images/workers";
import { createTestDb } from "./support/db";
import { FakeBucket, FakeProvider } from "./support/fakes";

const TENANT = "ten_1";

/** A PNG header with the given size: enough for the magic-byte sniff and the size reader. */
function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

async function setup() {
  const { db, close } = createTestDb();
  await db.run("INSERT INTO tenants (id, name, created_at) VALUES (?, 'Acme', '2026-01-01T00:00:00Z')", [TENANT]);
  const bucket = new FakeBucket();
  const provider = new FakeProvider();
  let offset = 0;
  const ctx: JobContext = {
    db,
    images: bucket.asBucket(),
    provider,
    publicBase: "https://imagefactory.test/i",
    webhookUrl: "https://imagefactory.test/api/v1/fal-webhook",
    signReference: async (assetId) => `https://imagefactory.test/i/ref/${assetId}?sig=test`,
    workerWaitSeconds: 45,
    sleep: async (ms) => {
      offset += ms;
    },
    now: () => Date.now() + offset,
  };
  const { worker, token } = await registerWorker(db, "openclaw-1");
  await recordHeartbeat(db, worker, { version: "1.0.0", capabilities: { kinds: ["generate", "edit"] } });
  const fresh = async (): Promise<WorkerRow> =>
    (await db.first<WorkerRow>("SELECT * FROM workers WHERE id = ?", [worker.id])) as WorkerRow;
  return {
    db,
    close,
    bucket,
    provider,
    ctx,
    worker: await fresh(),
    token,
    fresh,
    advance: (ms: number) => (offset += ms),
  };
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

const lease = (ctx: JobContext, worker: WorkerRow) => leaseImageJob(ctx, worker, { waitSeconds: 0 });

async function expireLease(db: Db, jobId: string) {
  await db.run("UPDATE image_jobs SET lease_expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?", [jobId]);
}

test("a job goes to the worker lane only while a worker that can take it is online", async () => {
  const { ctx, db, provider, worker, close } = await setup();
  try {
    const onWorker = await startJob(ctx, input());
    assert.equal(onWorker.provider, "worker");
    assert.equal(onWorker.state, "queued");
    assert.equal(provider.submits.length, 0, "nothing is sent to fal while a worker is online");

    // A worker that only generates does not get an edit job.
    await recordHeartbeat(db, worker, { capabilities: { kinds: ["generate"] } });
    const edit = await startJob(
      ctx,
      input({ kind: "edit", modelId: "qwen-edit", imageUrls: ["https://x.test/a.png"], numImages: 1 }),
    );
    assert.equal(edit.provider, "fal");
    assert.equal(provider.submits.length, 1);

    // A stale heartbeat counts as offline.
    await db.run("UPDATE workers SET last_heartbeat_at = '2020-01-01T00:00:00.000Z'");
    assert.equal(await hasFreshWorker(db, "generate", 1), false);
    const offline = await startJob(ctx, input());
    assert.equal(offline.provider, "fal");
  } finally {
    close();
  }
});

test("lease, extend and complete store the images and charge the credits once", async () => {
  const { ctx, db, bucket, provider, worker, close } = await setup();
  try {
    const started = await startJob(ctx, input({ params: { ...input().params, seed: 42 } }));
    const leased = await lease(ctx, worker);
    assert.ok(leased);
    assert.equal(leased.job.id, started.id);
    assert.equal(leased.job.prompt, "A tidy desk");
    assert.equal(leased.job.width, 816);
    assert.equal(leased.job.num_images, 2);
    assert.equal(leased.job.seed, 42);
    assert.equal(leased.job.attempt, 1);
    assert.equal(await lease(ctx, worker), null, "a leased job is not handed out twice");

    const extended = await extendLease(db, worker, started.id, leased.lease_token);
    assert.equal(extended.verdict, "ok");

    const wrong = await completeWorkerJob(ctx, worker, started.id, {
      leaseToken: "lst_wrong",
      images: [{ bytes: png(816, 1224) }],
    });
    assert.deepEqual(wrong, { accepted: false, reason: "lease_lost" });

    const done = await completeWorkerJob(ctx, worker, started.id, {
      leaseToken: leased.lease_token,
      seed: 7,
      model: "gpt-image-1",
      images: [{ bytes: png(816, 1224) }, { bytes: png(816, 1224) }],
    });
    assert.equal(done.accepted, true);
    const job = await getJob(db, TENANT, started.id);
    assert.equal(job?.state, "done");
    assert.equal(job?.credits_charged, 8);
    assert.equal(job?.rendered_by, "worker:gpt-image-1");
    assert.equal(bucket.objects.size, 2);
    const images = await db.all<{ width: number; height: number; seed: number }>(
      "SELECT width, height, seed FROM images WHERE job_id = ?",
      [started.id],
    );
    assert.deepEqual(
      images.map((row) => ({ ...row })),
      [
        { width: 816, height: 1224, seed: 7 },
        { width: 816, height: 1224, seed: 7 },
      ],
    );

    // A repeat of the same completion changes nothing and charges nothing more.
    const again = await completeWorkerJob(ctx, worker, started.id, {
      leaseToken: leased.lease_token,
      images: [{ bytes: png(816, 1224) }],
    });
    assert.deepEqual(again, { accepted: false, reason: "lease_lost" });
    assert.equal(bucket.objects.size, 2);
    const wallet = await getWallet(db, TENANT);
    assert.equal(wallet.reserved, 0);
    assert.equal(provider.submits.length, 0);
  } finally {
    close();
  }
});

test("files that are not images are refused and the lease stays usable", async () => {
  const { ctx, db, worker, close } = await setup();
  try {
    const started = await startJob(ctx, input({ numImages: 1 }));
    const leased = await lease(ctx, worker);
    assert.ok(leased);
    const bad = await completeWorkerJob(ctx, worker, started.id, {
      leaseToken: leased.lease_token,
      images: [{ bytes: new TextEncoder().encode("not an image at all, just words") }],
    });
    assert.equal(bad.accepted, false);
    assert.equal(bad.accepted === false && bad.reason, "invalid_images");
    const tooMany = await completeWorkerJob(ctx, worker, started.id, {
      leaseToken: leased.lease_token,
      images: [{ bytes: png(10, 10) }, { bytes: png(10, 10) }],
    });
    assert.equal(tooMany.accepted === false && tooMany.reason, "invalid_images");
    const good = await completeWorkerJob(ctx, worker, started.id, {
      leaseToken: leased.lease_token,
      images: [{ bytes: png(816, 1224) }],
    });
    assert.equal(good.accepted, true);
    assert.equal((await getJob(db, TENANT, started.id))?.state, "done");
  } finally {
    close();
  }
});

test("another worker cannot complete, extend or fail a job it does not hold", async () => {
  const { ctx, db, worker, close } = await setup();
  try {
    const started = await startJob(ctx, input({ numImages: 1 }));
    const leased = await lease(ctx, worker);
    assert.ok(leased);
    const { worker: other } = await registerWorker(db, "intruder");
    const stranger = (await db.first<WorkerRow>("SELECT * FROM workers WHERE id = ?", [other.id])) as WorkerRow;
    const done = await completeWorkerJob(ctx, stranger, started.id, {
      leaseToken: leased.lease_token,
      images: [{ bytes: png(1, 1) }],
    });
    assert.deepEqual(done, { accepted: false, reason: "lease_lost" });
    assert.equal((await extendLease(db, stranger, started.id, leased.lease_token)).verdict, "lease_lost");
    const failed = await failWorkerJob(ctx, stranger, started.id, { leaseToken: leased.lease_token });
    assert.equal(failed.accepted, false);
    assert.equal((await getJob(db, TENANT, started.id))?.state, "running");
  } finally {
    close();
  }
});

test("a failed attempt is retried, and the second failure moves the job to fal with its credits intact", async () => {
  const { ctx, db, provider, worker, close } = await setup();
  try {
    const started = await startJob(ctx, input({ numImages: 1 }));
    const first = await lease(ctx, worker);
    assert.ok(first);
    const retry = await failWorkerJob(ctx, worker, started.id, { leaseToken: first.lease_token, message: "boom" });
    assert.deepEqual(retry, { accepted: true, outcome: "requeued" });
    assert.equal((await getJob(db, TENANT, started.id))?.state, "queued");

    const second = await lease(ctx, worker);
    assert.ok(second);
    assert.equal(second.job.attempt, 2);
    const rerouted = await failWorkerJob(ctx, worker, started.id, { leaseToken: second.lease_token });
    assert.deepEqual(rerouted, { accepted: true, outcome: "rerouted" });

    const job = await getJob(db, TENANT, started.id);
    assert.equal(job?.provider, "fal");
    assert.equal(job?.state, "queued");
    assert.equal(job?.provider_job_id, "req-1");
    assert.equal(provider.submits.length, 1);
    assert.equal(provider.submits[0].prompt, "A tidy desk");
    assert.equal((await getWallet(db, TENANT)).reserved, job?.credits_reserved);

    // The worker that lost the job cannot complete it afterwards.
    const late = await completeWorkerJob(ctx, worker, started.id, {
      leaseToken: second.lease_token,
      images: [{ bytes: png(816, 1224) }],
    });
    assert.equal(late.accepted, false);
  } finally {
    close();
  }
});

test("blocked content ends the job and returns the credits", async () => {
  const { ctx, db, worker, close } = await setup();
  try {
    const started = await startJob(ctx, input({ numImages: 1 }));
    const leased = await lease(ctx, worker);
    assert.ok(leased);
    const result = await failWorkerJob(ctx, worker, started.id, {
      leaseToken: leased.lease_token,
      code: "CONTENT_BLOCKED",
      message: "The prompt asks for something the agent refuses.",
    });
    assert.deepEqual(result, { accepted: true, outcome: "failed" });
    const job = await getJob(db, TENANT, started.id);
    assert.equal(job?.state, "failed");
    assert.equal(job?.error_code, "CONTENT_BLOCKED");
    assert.equal((await getWallet(db, TENANT)).reserved, 0);
  } finally {
    close();
  }
});

test("a caller that waits sees a job with no worker moved to fal", async () => {
  const { ctx, db, provider, advance, close } = await setup();
  try {
    const started = await startJob(ctx, input());
    assert.equal(started.provider, "worker");
    // The worker goes offline after the job was queued.
    await db.run("UPDATE workers SET last_heartbeat_at = '2020-01-01T00:00:00.000Z'");
    const snapshot = await waitForJob(ctx, TENANT, started.id, 5_000);
    assert.equal(snapshot?.job.provider, "fal");
    assert.equal(provider.submits.length, 1);

    // A job that waits longer than the setting goes to fal even though a worker is online.
    await db.run("UPDATE workers SET last_heartbeat_at = ?", [new Date(Date.now() + 3_600_000).toISOString()]);
    const second = await startJob(ctx, input());
    assert.equal(second.provider, "worker");
    advance(46_000);
    await waitForJob(ctx, TENANT, second.id, 0);
    assert.equal((await getJob(db, TENANT, second.id))?.provider, "fal");
    assert.equal(provider.submits.length, 2);
  } finally {
    close();
  }
});

test("a lease that runs out is offered again, and after the last attempt the sweep hands the job to fal", async () => {
  const { ctx, db, provider, worker, close } = await setup();
  try {
    const started = await startJob(ctx, input({ numImages: 1 }));
    const first = await lease(ctx, worker);
    assert.ok(first);
    await expireLease(db, started.id);
    const second = await lease(ctx, worker);
    assert.ok(second, "an expired lease is offered again");
    assert.equal(second.job.attempt, 2);
    assert.notEqual(second.lease_token, first.lease_token);

    await expireLease(db, started.id);
    assert.equal(await lease(ctx, worker), null, "no attempts are left");
    const result = await sweepJobs(ctx);
    assert.equal(result.recovered, 1);
    const job = await getJob(db, TENANT, started.id);
    assert.equal(job?.provider, "fal");
    assert.equal(provider.submits.length, 1);
  } finally {
    close();
  }
});

test("edit references are signed when the job is leased", async () => {
  const { ctx, worker, close } = await setup();
  try {
    await startJob(
      ctx,
      input({
        kind: "edit",
        modelId: "qwen-edit",
        numImages: 1,
        imageUrls: ["https://imagefactory.test/i/abc.png", "https://imagefactory.test/i/ref/ast_1?sig=old"],
        references: [{ url: "https://imagefactory.test/i/abc.png" }, { assetId: "ast_1" }],
      }),
    );
    const leased = await lease(ctx, worker);
    assert.deepEqual(leased?.job.references, [
      "https://imagefactory.test/i/abc.png",
      "https://imagefactory.test/i/ref/ast_1?sig=test",
    ]);
  } finally {
    close();
  }
});

test("worker tokens: only the hash is stored, a disabled worker is refused and a rotated token overlaps", async () => {
  const { db, worker, token, close } = await setup();
  try {
    const request = (value: string) => new Request("https://x.test", { headers: { authorization: `Bearer ${value}` } });
    assert.match(token, /^wkr_[A-Za-z0-9]{32}$/);
    const stored = await db.first<{ token_hash: string }>("SELECT token_hash FROM workers WHERE id = ?", [worker.id]);
    assert.notEqual(stored?.token_hash, token);
    assert.equal((await authenticateWorker(db, request(token)))?.id, worker.id);
    assert.equal(await authenticateWorker(db, request("wkr_nope")), null);
    assert.equal(await authenticateWorker(db, request("if_live_x")), null);

    const next = await rotateWorkerToken(db, worker.id);
    assert.ok(next);
    assert.equal((await authenticateWorker(db, request(next)))?.id, worker.id);
    assert.equal((await authenticateWorker(db, request(token)))?.id, worker.id, "the old token overlaps for a day");

    await setWorkerDisabled(db, worker.id, true);
    assert.equal(await authenticateWorker(db, request(next)), null);
  } finally {
    close();
  }
});

test("image sizes are read from PNG, JPEG and WebP headers", () => {
  assert.deepEqual(imageSize(png(816, 1224)), { width: 816, height: 1224 });
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0x04, 0xc8, 0x03, 0x30, 3, 1, 0x22, 0, 2, 0x11, 1]);
  assert.deepEqual(imageSize(jpeg), { width: 816, height: 1224 });
  const webp = new Uint8Array(30);
  webp.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58]);
  webp.set([0x2f, 0x03, 0x00], 24); // width - 1 = 815
  webp.set([0xc7, 0x04, 0x00], 27); // height - 1 = 1223
  assert.deepEqual(imageSize(webp), { width: 816, height: 1224 });
  assert.equal(imageSize(new Uint8Array([1, 2, 3])), null);
});
