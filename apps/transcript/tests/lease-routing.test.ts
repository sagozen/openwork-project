import assert from "node:assert/strict";
import { test } from "node:test";
import "../src/lib/platform";
import { createJob, extendLease, requeueExpired } from "../src/lib/jobs";
import {
  authenticateWorker,
  fallbackMayTake,
  leaseJob,
  primaryIsFresh,
  registerWorker,
  rotateWorkerToken,
  tryLease,
  type WorkerRow,
  workerCanTake,
} from "../src/lib/workers";
import { createTestDb } from "./support/db";
import { createAccount, testEnv } from "./support/fixtures";

const source = {
  kind: "direct" as const,
  ref: "https://example.com/a.mp3",
  url: "https://example.com/a.mp3",
  host: "example.com",
  multi: null,
  ytdlp: false,
  label: "example.com",
};

async function seedWorker(
  db: Awaited<ReturnType<typeof createTestDb>>["db"],
  tier: "primary" | "fallback",
  lastHeartbeatSecondsAgo: number | null,
  capabilities: { maxAudioSeconds?: number; canDownloadYoutube?: boolean } = {},
): Promise<WorkerRow> {
  const { worker } = await registerWorker(db, { name: `${tier}-${Math.random().toString(16).slice(2, 6)}`, tier });
  await db.run("UPDATE workers SET capabilities_json = ?, last_heartbeat_at = ? WHERE id = ?", [
    JSON.stringify({ maxAudioSeconds: 7200, canDownloadYoutube: true, ...capabilities }),
    lastHeartbeatSecondsAgo === null ? null : new Date(Date.now() - lastHeartbeatSecondsAgo * 1000).toISOString(),
    worker.id,
  ]);
  return (await db.first<WorkerRow>("SELECT * FROM workers WHERE id = ?", [worker.id])) as WorkerRow;
}

async function queuedJob(
  db: Awaited<ReturnType<typeof createTestDb>>["db"],
  options: { durationSeconds: number; viaApi?: boolean } = { durationSeconds: 300 },
): Promise<string> {
  const env = testEnv();
  const { tenantId } = await createAccount(db, { credits: 1000 });
  const { job } = await createJob(env, db, {
    tenantId,
    guestId: null,
    userId: null,
    viaApi: options.viaApi ?? false,
    source,
    options: {},
    durationSeconds: options.durationSeconds,
  });
  return job.id;
}

test("primaryIsFresh only trusts heartbeats younger than 60 s", () => {
  const now = Date.now();
  assert.equal(primaryIsFresh(new Date(now - 59_000).toISOString(), now), true);
  assert.equal(primaryIsFresh(new Date(now - 61_000).toISOString(), now), false);
  assert.equal(primaryIsFresh(null, now), false);
});

test("fallback rules: probe always, otherwise only when the GPU is silent or backlogged", () => {
  const job = {
    id: "j",
    stage: "transcribe",
    free: 0,
    queued_at: new Date().toISOString(),
    source_kind: "direct",
    duration_seconds: 300,
  };
  assert.equal(fallbackMayTake({ ...job, stage: "probe" }, { primaryFresh: true, fallbackAfterSeconds: 90 }), true);
  assert.equal(fallbackMayTake(job, { primaryFresh: true, fallbackAfterSeconds: 90 }), false);
  assert.equal(fallbackMayTake(job, { primaryFresh: false, fallbackAfterSeconds: 90 }), true);
  const old = { ...job, queued_at: new Date(Date.now() - 120_000).toISOString() };
  assert.equal(fallbackMayTake(old, { primaryFresh: true, fallbackAfterSeconds: 90 }), true);
});

test("a worker never takes media above its max audio length", () => {
  const worker = { id: "w", capabilities_json: JSON.stringify({ maxAudioSeconds: 3600 }) } as WorkerRow;
  const long = { id: "j", stage: "transcribe", free: 0, queued_at: "", source_kind: "direct", duration_seconds: 7200 };
  const short = { ...long, duration_seconds: 1800 };
  const probe = { ...long, stage: "probe", duration_seconds: null };
  assert.equal(workerCanTake(long, worker), false);
  assert.equal(workerCanTake(short, worker), true);
  assert.equal(workerCanTake(probe, worker), true);
});

test("two concurrent lease calls never receive the same job", async () => {
  const { db, close } = createTestDb();
  try {
    await queuedJob(db);
    const worker = await seedWorker(db, "primary", 1);
    const [first, second] = await Promise.all([
      leaseJob(db, worker, { waitSeconds: 0 }),
      leaseJob(db, worker, { waitSeconds: 0 }),
    ]);
    const granted = [first, second].filter(Boolean);
    assert.equal(granted.length, 1);
  } finally {
    close();
  }
});

test("a fallback worker gets nothing while the primary is fresh and the queue is young", async () => {
  const { db, close } = createTestDb();
  try {
    await queuedJob(db);
    await seedWorker(db, "primary", 1);
    const fallback = await seedWorker(db, "fallback", 1);
    assert.equal(await leaseJob(db, fallback, { waitSeconds: 0 }), null);
  } finally {
    close();
  }
});

test("a fallback worker takes the job once the primary goes silent", async () => {
  const { db, close } = createTestDb();
  try {
    const jobId = await queuedJob(db);
    await seedWorker(db, "primary", 120);
    const fallback = await seedWorker(db, "fallback", 1);
    const leased = await leaseJob(db, fallback, { waitSeconds: 0 });
    assert.equal(leased?.id, jobId);
  } finally {
    close();
  }
});

test("a fallback worker takes a backlogged job even while the primary is fresh", async () => {
  const { db, close } = createTestDb();
  try {
    const jobId = await queuedJob(db);
    await db.run("UPDATE transcription_jobs SET queued_at = ? WHERE id = ?", [
      new Date(Date.now() - 300_000).toISOString(),
      jobId,
    ]);
    await seedWorker(db, "primary", 1);
    const fallback = await seedWorker(db, "fallback", 1);
    const leased = await leaseJob(db, fallback, { waitSeconds: 0 });
    assert.equal(leased?.id, jobId);
  } finally {
    close();
  }
});

test("an over-length job is never leased to the fallback worker", async () => {
  const { db, close } = createTestDb();
  try {
    const jobId = await queuedJob(db, { durationSeconds: 7200 });
    await seedWorker(db, "primary", 300);
    const fallback = await seedWorker(db, "fallback", 1, { maxAudioSeconds: 3600 });
    assert.equal(await leaseJob(db, fallback, { waitSeconds: 0 }), null);

    const primary = await seedWorker(db, "primary", 1, { maxAudioSeconds: 10800 });
    const leased = await leaseJob(db, primary, { waitSeconds: 0 });
    assert.equal(leased?.id, jobId);
  } finally {
    close();
  }
});

test("paid jobs are leased before free jobs", async () => {
  const { db, close } = createTestDb();
  try {
    const env = testEnv();
    const { tenantId } = await createAccount(db, { credits: 100 });
    const free = await createJob(env, db, {
      tenantId: null,
      guestId: "gst_order",
      userId: null,
      viaApi: false,
      source,
      options: {},
      durationSeconds: 100,
    });
    const paid = await createJob(env, db, {
      tenantId,
      guestId: null,
      userId: null,
      viaApi: false,
      source,
      options: {},
      durationSeconds: 600,
    });
    const worker = await seedWorker(db, "primary", 1);
    const leased = await leaseJob(db, worker, { waitSeconds: 0 });
    assert.equal(leased?.id, paid.job.id);
    assert.notEqual(leased?.id, free.job.id);
  } finally {
    close();
  }
});

test("a lease token from an earlier attempt cannot extend, complete or fail after a requeue", async () => {
  const { db, close } = createTestDb();
  try {
    const jobId = await queuedJob(db);
    const worker = await seedWorker(db, "primary", 1);
    const first = await tryLease(db, worker, { fallbackAfter: 90, now: Date.now });
    assert.ok(first?.lease_token);
    await db.run("UPDATE transcription_jobs SET lease_expires_at = ? WHERE id = ?", [
      new Date(Date.now() - 1000).toISOString(),
      jobId,
    ]);
    await requeueExpired(db);
    const second = await tryLease(db, worker, { fallbackAfter: 90, now: Date.now });
    assert.ok(second?.lease_token);
    assert.notEqual(second?.lease_token, first?.lease_token);

    const staleExtend = await extendLease(db, worker.id, jobId, first?.lease_token ?? null);
    assert.equal(staleExtend.ok, false);
    assert.equal(staleExtend.reason, "lost");

    const currentExtend = await extendLease(db, worker.id, jobId, second?.lease_token ?? null);
    assert.equal(currentExtend.ok, true);
  } finally {
    close();
  }
});

test("a cancelled job tells the worker to stop extending", async () => {
  const { db, close } = createTestDb();
  try {
    const jobId = await queuedJob(db);
    const worker = await seedWorker(db, "primary", 1);
    const leased = await tryLease(db, worker, { fallbackAfter: 90, now: Date.now });
    await db.run("UPDATE transcription_jobs SET status = 'cancelled' WHERE id = ?", [jobId]);
    const result = await extendLease(db, worker.id, jobId, leased?.lease_token ?? null);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "cancelled");
  } finally {
    close();
  }
});

test("a worker cannot hold more leases than its advertised concurrency", async () => {
  const { db, close } = createTestDb();
  try {
    await queuedJob(db);
    await queuedJob(db);
    const worker = await seedWorker(db, "primary", 1);
    await db.run("UPDATE workers SET capabilities_json = ? WHERE id = ?", [
      JSON.stringify({ concurrency: 1, maxAudioSeconds: 7200 }),
      worker.id,
    ]);
    const fresh = (await db.first<WorkerRow>("SELECT * FROM workers WHERE id = ?", [worker.id])) as WorkerRow;
    const first = await tryLease(db, fresh, { fallbackAfter: 90, now: Date.now });
    assert.ok(first);
    const second = await tryLease(db, fresh, { fallbackAfter: 90, now: Date.now });
    assert.equal(second, null);
  } finally {
    close();
  }
});

test("an aged free job outranks a fresh paid job instead of starving", async () => {
  const { db, close } = createTestDb();
  try {
    const env = testEnv();
    const { tenantId } = await createAccount(db, { credits: 100 });
    const free = await createJob(env, db, {
      tenantId: null,
      guestId: "gst_aged",
      userId: null,
      viaApi: false,
      source,
      options: {},
      durationSeconds: 100,
    });
    const paid = await createJob(env, db, {
      tenantId,
      guestId: null,
      userId: null,
      viaApi: false,
      source,
      options: {},
      durationSeconds: 600,
    });
    await db.run("UPDATE transcription_jobs SET queued_at = ? WHERE id = ?", [
      new Date(Date.now() - 3600_000).toISOString(),
      free.job.id,
    ]);
    const worker = await seedWorker(db, "primary", 1);
    const leased = await tryLease(db, worker, { fallbackAfter: 90, now: Date.now });
    assert.equal(leased?.id, free.job.id);
    assert.notEqual(leased?.id, paid.job.id);
  } finally {
    close();
  }
});

test("rotating a worker token keeps the previous token valid for the overlap window", async () => {
  const { db, close } = createTestDb();
  try {
    const { worker, token } = await registerWorker(db, { name: "rotate", tier: "primary" });
    const next = await rotateWorkerToken(db, worker.id);
    assert.ok(next);
    const withOld = await authenticateWorker(
      db,
      new Request("https://example.com", { headers: { authorization: `Bearer ${token}` } }),
    );
    const withNew = await authenticateWorker(
      db,
      new Request("https://example.com", { headers: { authorization: `Bearer ${next}` } }),
    );
    assert.equal(withOld?.id, worker.id);
    assert.equal(withNew?.id, worker.id);
    await db.run("UPDATE workers SET previous_token_expires_at = ? WHERE id = ?", [
      new Date(Date.now() - 1000).toISOString(),
      worker.id,
    ]);
    const expired = await authenticateWorker(
      db,
      new Request("https://example.com", { headers: { authorization: `Bearer ${token}` } }),
    );
    assert.equal(expired, null);
  } finally {
    close();
  }
});
