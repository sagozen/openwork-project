import assert from "node:assert/strict";
import { test } from "node:test";
import { assertNotBlocked, blockSubject, releaseAbuseBlock } from "@templatedesign/platform/abuse";
import type { Db } from "@templatedesign/platform/db";
import { HttpError } from "@templatedesign/platform/http";
import "../src/lib/platform";
import { countJobsCreated, countRateLimited, jobAbuseHooks, requestAbuseSubjects } from "../src/lib/job-abuse";
import { createJob, getJob } from "../src/lib/jobs";
import { freeJobsUsedToday } from "../src/lib/quota";
import { evaluateWorkerAlerts } from "../src/lib/worker-alerts";
import { heartbeat, recordWorkerMetrics, registerWorker, updateWorkerConfig } from "../src/lib/workers";
import { createTestDb } from "./support/db";
import { createAccount, testEnv, walletOf } from "./support/fixtures";

const source = {
  kind: "direct" as const,
  ref: "https://example.com/audio.mp3",
  url: "https://example.com/audio.mp3",
  host: "example.com",
  multi: null,
  ytdlp: false,
  label: "example.com",
};

const env = testEnv();

function request(ip: string | null): Request {
  return new Request("http://localhost/api/v1/transcriptions", {
    method: "POST",
    headers: ip ? { "cf-connecting-ip": ip } : {},
  });
}

async function job(db: Db, owner: { tenantId?: string; guestId?: string }, durationSeconds: number) {
  const { job: row } = await createJob(env, db, {
    tenantId: owner.tenantId ?? null,
    guestId: owner.guestId ?? null,
    userId: null,
    viaApi: false,
    source,
    options: {},
    durationSeconds,
  });
  return row;
}

async function rejectsBlocked(promise: Promise<unknown>): Promise<void> {
  await assert.rejects(promise, (error) => error instanceof HttpError && error.status === 429);
}

test("a blocked guest id or IP is refused with 429 before any job is created", async () => {
  const { db, close } = createTestDb();
  try {
    await blockSubject(env, db, { kind: "ip", id: "203.0.113.9" }, { reason: "test", source: "admin", minutes: 60 });
    await blockSubject(env, db, { kind: "guest", id: "gst_bad" }, { reason: "test", source: "admin", minutes: 60 });

    // A fresh guest cookie from the blocked IP is still refused, and so is the blocked guest elsewhere.
    await rejectsBlocked(
      assertNotBlocked(db, requestAbuseSubjects({ tenantId: null, guestId: "gst_new" }, request("203.0.113.9"))),
    );
    await rejectsBlocked(
      assertNotBlocked(db, requestAbuseSubjects({ tenantId: null, guestId: "gst_bad" }, request("198.51.100.1"))),
    );
    await assertNotBlocked(db, requestAbuseSubjects({ tenantId: null, guestId: "gst_new" }, request("198.51.100.1")));

    const error = await assertNotBlocked(db, [{ kind: "ip", id: "203.0.113.9" }]).catch((caught: unknown) => caught);
    assert.ok(error instanceof HttpError);
    assert.ok(Number(new Headers(error.headers).get("retry-after")) > 0);
  } finally {
    close();
  }
});

test("crossing the threshold cancels unstarted jobs, releases their holds and spares a leased job", async () => {
  const { db, close } = createTestDb();
  try {
    const { tenantId } = await createAccount(db, { credits: 100 });
    const queued = await job(db, { tenantId }, 600);
    const running = await job(db, { tenantId }, 600);
    await db.run("UPDATE transcription_jobs SET status = 'leased', leased_by = 'w1' WHERE id = ?", [running.id]);
    const held = await walletOf(db, tenantId);
    assert.ok(held.reserved > 0);
    assert.equal(queued.pricing_state, "reserved");

    const subjects = requestAbuseSubjects({ tenantId, guestId: null }, request("192.0.2.1"));
    // A batch big enough to cross the hourly limit in one request answers 429 itself.
    await rejectsBlocked(countJobsCreated(env, db, subjects, 121));

    assert.equal((await getJob(db, queued.id))?.status, "cancelled");
    assert.equal((await getJob(db, running.id))?.status, "leased");
    const after = await walletOf(db, tenantId);
    assert.equal(after.reserved, running.reserved_credits, "only the running job still holds credits");
    assert.equal(after.purchased, 100);

    const block = await db.first<{ id: string; cancelled_jobs: number; source: string }>(
      "SELECT id, cancelled_jobs, source FROM abuse_blocks WHERE subject_kind = 'tenant' AND subject_id = ?",
      [tenantId],
    );
    assert.equal(block?.cancelled_jobs, 1);
    assert.equal(block?.source, "auto");
    const email = await db.first<{ payload_json: string }>(
      "SELECT payload_json FROM email_outbox WHERE template = 'abuse_alert'",
    );
    assert.match(email?.payload_json ?? "", new RegExp(`/admin/abuse/\\?block=${block?.id}`));
  } finally {
    close();
  }
});

test("a blocked guest's free slot comes back when its queued job is cancelled", async () => {
  const { db, close } = createTestDb();
  try {
    const free = await job(db, { guestId: "gst_spam" }, 120);
    assert.equal(free.pricing_state, "free");
    assert.equal(await freeJobsUsedToday(db, "gst_spam"), 1);

    const cancelled = await jobAbuseHooks(env, db).cancelQueuedJobs?.({ kind: "guest", id: "gst_spam" });
    assert.equal(cancelled, 1);
    assert.equal((await getJob(db, free.id))?.status, "cancelled");
    assert.equal(await freeJobsUsedToday(db, "gst_spam"), 0);
    assert.equal(await jobAbuseHooks(env, db).cancelQueuedJobs?.({ kind: "ip", id: "192.0.2.1" }), 0);
  } finally {
    close();
  }
});

test("releasing a block lets the subject create jobs again, and one tenant's block never touches another", async () => {
  const { db, close } = createTestDb();
  try {
    const a = await createAccount(db);
    const b = await createAccount(db);
    const bJob = await job(db, { tenantId: b.tenantId }, 120);
    const subjectsA = requestAbuseSubjects({ tenantId: a.tenantId, guestId: null }, request("192.0.2.7"));
    const subjectsB = requestAbuseSubjects({ tenantId: b.tenantId, guestId: null }, request("192.0.2.7"));

    const block = await blockSubject(env, db, subjectsA[0], {
      reason: "test",
      source: "admin",
      minutes: null,
      hooks: jobAbuseHooks(env, db),
    });
    await rejectsBlocked(assertNotBlocked(db, subjectsA));
    // Same office IP, different tenant: B is judged on its own and keeps its queued job.
    await assertNotBlocked(db, subjectsB);
    assert.equal((await getJob(db, bJob.id))?.status, "queued");

    assert.equal(await releaseAbuseBlock(db, block.id, "usr_admin"), true);
    await assertNotBlocked(db, subjectsA);
  } finally {
    close();
  }
});

test("a rate-limit rejection is counted against the subject and rethrown", async () => {
  const { db, close } = createTestDb();
  try {
    const subjects = requestAbuseSubjects({ tenantId: null, guestId: "gst_rl" }, request("192.0.2.30"));
    await rejectsBlocked(
      countRateLimited(env, db, subjects, async () => {
        throw new HttpError("rate_limited", 429, "slow down");
      }),
    );
    const counters = await db.all<{ bucket: string; count: number }>(
      "SELECT bucket, count FROM rate_limits WHERE bucket LIKE 'abuse:rate_limited:%' ORDER BY bucket",
    );
    assert.deepEqual(
      counters.map((row) => [row.bucket, row.count]),
      [
        ["abuse:rate_limited:guest:gst_rl", 1],
        ["abuse:rate_limited:ip:192.0.2.30", 1],
      ],
    );
    // Other errors pass through without counting.
    await assert.rejects(
      countRateLimited(env, db, subjects, async () => {
        throw new HttpError("invalid_input", 400);
      }),
    );
    const total = await db.first<{ total: number }>(
      "SELECT SUM(count) AS total FROM rate_limits WHERE bucket LIKE 'abuse:rate_limited:%'",
    );
    assert.equal(total?.total, 2);
  } finally {
    close();
  }
});

test("a worker warning email links to the disable confirm panel; a recovery links to the worker", async () => {
  const { db, close } = createTestDb();
  try {
    const { worker } = await registerWorker(db, { name: "home-gpu", tier: "primary" });
    await heartbeat(db, worker, { version: "1.9.0" });
    await updateWorkerConfig(db, worker.id, {
      alerts: { enabled: true, cpuPercent: 90, memPercent: 99, diskFreePercent: 5, cpuTempC: 100, gpuTempC: 100 },
    });
    const base = Date.now();
    await recordWorkerMetrics(db, worker.id, { cpuPercent: 96 }, base - 60_000);
    await recordWorkerMetrics(db, worker.id, { cpuPercent: 97 }, base);
    await evaluateWorkerAlerts(env, db, base);

    const warning = await db.first<{ payload_json: string }>(
      "SELECT payload_json FROM email_outbox WHERE template = 'worker_alert'",
    );
    const data = JSON.parse(warning?.payload_json ?? "{}") as { url?: string; action?: string };
    assert.equal(
      data.url,
      `http://localhost:4323/admin/workers/?worker=${encodeURIComponent(worker.id)}&action=disable`,
    );
    assert.equal(data.action, "Stop this worker taking jobs");

    const later = base + 3 * 60_000;
    await db.run("UPDATE workers SET last_heartbeat_at = ? WHERE id = ?", [
      new Date(later + 120_000).toISOString(),
      worker.id,
    ]);
    for (const offset of [0, 60_000, 120_000])
      await recordWorkerMetrics(db, worker.id, { cpuPercent: 50 }, later + offset);
    await evaluateWorkerAlerts(env, db, later + 180_000);
    const emails = await db.all<{ payload_json: string }>(
      "SELECT payload_json FROM email_outbox WHERE template = 'worker_alert' ORDER BY created_at, rowid",
    );
    const recovery = JSON.parse(emails[1]?.payload_json ?? "{}") as { url?: string; action?: string };
    assert.equal(recovery.url, `http://localhost:4323/admin/workers/?worker=${encodeURIComponent(worker.id)}`);
    assert.equal(recovery.action, "Open worker in Admin");
  } finally {
    close();
  }
});
