import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpError } from "@templatedesign/platform/http";
import "../src/lib/platform";
import { runAddons } from "../src/lib/addons/summary";
import { cancelJob, completeJob, createJob, failJob, getJob, recordProbe, requeueExpired } from "../src/lib/jobs";
import { PRICING } from "../src/lib/pricing-core";
import { heartbeat, registerWorker, tryLease } from "../src/lib/workers";
import { createTestDb } from "./support/db";
import { createAccount, ledgerOf, minutesUsed, testEnv, walletOf } from "./support/fixtures";

const source = {
  kind: "direct" as const,
  ref: "https://example.com/audio.mp3",
  url: "https://example.com/audio.mp3",
  host: "example.com",
  multi: null,
  ytdlp: false,
  label: "example.com",
};

async function worker(db: Awaited<ReturnType<typeof createTestDb>>["db"], tier: "primary" | "fallback" = "primary") {
  const { worker: row } = await registerWorker(db, { name: `w-${tier}`, tier });
  await heartbeat(db, row, { version: "test", capabilities: { maxAudioSeconds: 7200, canDownloadYoutube: true } });
  return row;
}

const transcript = {
  segments: [
    { start: 0, end: 1.5, text: "Hello" },
    { start: 1.5, end: 3, text: "world" },
  ],
  language: "en",
  model: "large-v3-turbo",
};

test("a free job settles without touching the wallet and counts one free slot", async () => {
  const env = testEnv();
  const { db, close } = createTestDb();
  try {
    const { tenantId } = await createAccount(db);
    const { job } = await createJob(env, db, {
      tenantId,
      guestId: null,
      userId: null,
      viaApi: false,
      source,
      options: {},
      durationSeconds: 120,
    });
    assert.equal(job.status, "queued");
    assert.equal(job.free, 1);
    assert.equal(job.stage, "transcribe");
    const before = await walletOf(db, tenantId);
    assert.equal(before.reserved, 0);

    const leased = await db.run(
      "UPDATE transcription_jobs SET status='leased', leased_by='w1', lease_expires_at=? WHERE id=?",
      [new Date(Date.now() + 60_000).toISOString(), job.id],
    );
    assert.equal(leased.changes, 1);
    const row = await worker(db);
    await db.run("UPDATE transcription_jobs SET leased_by = ? WHERE id = ?", [row.id, job.id]);
    const result = await completeJob(env, db, row.id, job.id, { stage: "transcribe", transcript });
    assert.equal(result.accepted, true);

    const after = await walletOf(db, tenantId);
    assert.equal(after.reserved, 0);
    assert.equal(after.purchased, before.purchased);
    const row2 = await db.first<{ pricing_state: string; status: string }>(
      "SELECT pricing_state, status FROM transcription_jobs WHERE id = ?",
      [job.id],
    );
    assert.equal(row2?.status, "succeeded");
    assert.equal(row2?.pricing_state, "settled");
  } finally {
    close();
  }
});

test("a paid job reserves, settles exactly once, and counts minutes", async () => {
  const env = testEnv();
  const { db, close } = createTestDb();
  try {
    const { tenantId } = await createAccount(db, { credits: 200 });
    const { job } = await createJob(env, db, {
      tenantId,
      guestId: null,
      userId: null,
      viaApi: false,
      source,
      options: {},
      durationSeconds: 1200,
    });
    assert.equal(job.free, 0);
    assert.equal(job.reserved_credits, 60);
    assert.equal((await walletOf(db, tenantId)).reserved, 60);
    assert.equal(await minutesUsed(db, tenantId), 20);

    const row = await worker(db);
    await db.run("UPDATE transcription_jobs SET status='leased', leased_by=?, lease_expires_at=? WHERE id=?", [
      row.id,
      new Date(Date.now() + 60_000).toISOString(),
      job.id,
    ]);
    const first = await completeJob(env, db, row.id, job.id, { stage: "transcribe", transcript });
    assert.equal(first.accepted, true);
    const second = await completeJob(env, db, row.id, job.id, { stage: "transcribe", transcript });
    assert.equal(second.accepted, false);

    const wallet = await walletOf(db, tenantId);
    // Free credits are spent before purchased ones, so 50 free + 10 purchased (of 200).
    assert.equal(wallet.free, 0);
    assert.equal(wallet.purchased, 190);
    assert.equal(wallet.reserved, 0);
    const ledger = await ledgerOf(db, tenantId);
    // One settle row per source (free, then purchased), never two settles for one job.
    assert.equal(
      ledger.filter((entry) => entry.kind === "settle").reduce((sum, entry) => sum + entry.credits, 0),
      -60,
    );
    const stored = await db.first<{ charged_credits: number; pricing_state: string }>(
      "SELECT charged_credits, pricing_state FROM transcription_jobs WHERE id = ?",
      [job.id],
    );
    assert.equal(stored?.charged_credits, 60);
    assert.equal(stored?.pricing_state, "settled");
  } finally {
    close();
  }
});

test("a failure releases credits and minutes", async () => {
  const env = testEnv();
  const { db, close } = createTestDb();
  try {
    const { tenantId } = await createAccount(db, { credits: 100 });
    const { job } = await createJob(env, db, {
      tenantId,
      guestId: null,
      userId: null,
      viaApi: false,
      source,
      options: {},
      durationSeconds: 600,
    });
    assert.equal((await walletOf(db, tenantId)).reserved, 30);
    await failJob(env, db, null, job.id, "source_unavailable", false, true);
    const wallet = await walletOf(db, tenantId);
    assert.equal(wallet.reserved, 0);
    assert.equal(wallet.purchased, 100);
    assert.equal(await minutesUsed(db, tenantId), 0);
    const row = await getJob(db, job.id);
    assert.equal(row?.status, "failed");
    assert.equal(row?.pricing_state, "released");
  } finally {
    close();
  }
});

test("the monthly cap refuses the job and charges nothing", async () => {
  const env = testEnv();
  const { db, close } = createTestDb();
  try {
    const { tenantId } = await createAccount(db, { credits: 5000 });
    await db.run(
      "INSERT INTO admin_settings (key, value_json, updated_at) VALUES ('transcript.monthly_cap_minutes', '10', ?)",
      [new Date().toISOString()],
    );
    await assert.rejects(
      () =>
        createJob(env, db, {
          tenantId,
          guestId: null,
          userId: null,
          viaApi: false,
          source,
          options: {},
          durationSeconds: 1200,
        }),
      (error: unknown) => error instanceof HttpError && error.code === "quota_exceeded",
    );
    const wallet = await walletOf(db, tenantId);
    assert.equal(wallet.reserved, 0);
    assert.equal(wallet.purchased, 5000);
    const failed = await db.first<{ status: string; error_code: string }>(
      "SELECT status, error_code FROM transcription_jobs ORDER BY created_at DESC LIMIT 1",
    );
    assert.equal(failed?.status, "failed");
    assert.equal(failed?.error_code, "monthly_cap_reached");
  } finally {
    close();
  }
});

test("a guest never gets a paid job", async () => {
  const env = testEnv();
  const { db, close } = createTestDb();
  try {
    await assert.rejects(
      () =>
        createJob(env, db, {
          tenantId: null,
          guestId: "gst_1",
          userId: null,
          viaApi: false,
          source,
          options: {},
          durationSeconds: 600,
        }),
      (error: unknown) => error instanceof HttpError && error.status === 401,
    );
  } finally {
    close();
  }
});

test("a probe result prices the job and can park it for confirmation", async () => {
  const env = testEnv();
  const { db, close } = createTestDb();
  try {
    const { tenantId } = await createAccount(db, { credits: 500 });
    const { job } = await createJob(env, db, {
      tenantId,
      guestId: null,
      userId: null,
      viaApi: false,
      source,
      options: {},
      preview: true,
    });
    assert.equal(job.stage, "probe");
    const probeJob = await worker(db);
    await db.run("UPDATE transcription_jobs SET status='leased', leased_by=?, lease_expires_at=? WHERE id=?", [
      probeJob.id,
      new Date(Date.now() + 60_000).toISOString(),
      job.id,
    ]);
    const probed = await completeJob(env, db, probeJob.id, job.id, {
      stage: "probe",
      probe: { durationSeconds: 900, title: "Episode 1" },
    });
    assert.equal(probed.accepted, true);
    assert.equal(probed.job?.status, "preview_ready");
    assert.equal(probed.job?.duration_seconds, 900);

    const row = await getJob(db, job.id);
    assert.ok(row);
    const confirmed = await recordProbe(env, db, { ...row, preview: 0 }, { durationSeconds: 900 }, 40);
    assert.equal(confirmed.status, "awaiting_confirmation");
    assert.equal((await walletOf(db, tenantId)).reserved, 0);
  } finally {
    close();
  }
});

test("an expired lease requeues and a late complete is rejected without charging twice", async () => {
  const env = testEnv();
  const { db, close } = createTestDb();
  try {
    const { tenantId } = await createAccount(db, { credits: 100 });
    const { job } = await createJob(env, db, {
      tenantId,
      guestId: null,
      userId: null,
      viaApi: false,
      source,
      options: {},
      durationSeconds: 300,
    });
    const first = await worker(db);
    await db.run("UPDATE transcription_jobs SET status='leased', leased_by=?, lease_expires_at=? WHERE id=?", [
      first.id,
      new Date(Date.now() - 1000).toISOString(),
      job.id,
    ]);
    const requeued = await requeueExpired(db);
    assert.equal(requeued.requeued, 1);
    assert.equal((await getJob(db, job.id))?.status, "queued");

    const late = await completeJob(env, db, first.id, job.id, { stage: "transcribe", transcript });
    assert.equal(late.accepted, false);

    const second = await worker(db, "fallback");
    await db.run("UPDATE transcription_jobs SET status='leased', leased_by=?, lease_expires_at=? WHERE id=?", [
      second.id,
      new Date(Date.now() + 60_000).toISOString(),
      job.id,
    ]);
    const done = await completeJob(env, db, second.id, job.id, { stage: "transcribe", transcript });
    assert.equal(done.accepted, true);
    const ledger = await ledgerOf(db, tenantId);
    assert.equal(
      ledger.filter((entry) => entry.kind === "settle").reduce((sum, entry) => sum + entry.credits, 0),
      -15,
    );
    assert.equal((await walletOf(db, tenantId)).reserved, 0);
    assert.equal((await getJob(db, job.id))?.attempts, 1);
  } finally {
    close();
  }
});

test("cancelling releases the reservation", async () => {
  const env = testEnv();
  const { db, close } = createTestDb();
  try {
    const { tenantId } = await createAccount(db, { credits: 100 });
    const { job } = await createJob(env, db, {
      tenantId,
      guestId: null,
      userId: null,
      viaApi: false,
      source,
      options: {},
      durationSeconds: 600,
    });
    await cancelJob(env, db, job);
    assert.equal((await getJob(db, job.id))?.status, "cancelled");
    const wallet = await walletOf(db, tenantId);
    assert.equal(wallet.reserved, 0);
    assert.equal(wallet.purchased, 100);
  } finally {
    close();
  }
});

test("a failed summary releases only the add-on credits and keeps the transcript", async () => {
  const env = { ...testEnv(), OPENROUTER_API_KEY: "test-key" };
  const { db, close } = createTestDb();
  try {
    const { tenantId } = await createAccount(db, { credits: 200 });
    const { job } = await createJob(env, db, {
      tenantId,
      guestId: null,
      userId: null,
      viaApi: false,
      source,
      options: { summary: { preset: "bullets" } },
      durationSeconds: 600,
    });
    assert.equal(job.reserved_credits, 35);

    const row = await worker(db);
    await db.run("UPDATE transcription_jobs SET status='leased', leased_by=?, lease_expires_at=? WHERE id=?", [
      row.id,
      new Date(Date.now() + 60_000).toISOString(),
      job.id,
    ]);
    const done = await completeJob(env, db, row.id, job.id, { stage: "transcribe", transcript });
    assert.equal(done.accepted, true);
    const pending = await getJob(db, job.id);
    assert.equal(pending?.pricing_state, "addon_pending");
    assert.equal(pending?.reserved_credits, PRICING.summaryCredits);
    assert.equal(pending?.charged_credits, 30);

    const failing = (async () => new Response("nope", { status: 429 })) as unknown as typeof fetch;
    const state = await runAddons(env, db, job.id, failing);
    assert.equal(state.status, "failed");
    const after = await getJob(db, job.id);
    assert.equal(after?.pricing_state, "settled");
    assert.equal(after?.reserved_credits, 0);
    assert.equal(after?.charged_credits, 30);
    const wallet = await walletOf(db, tenantId);
    assert.equal(wallet.reserved, 0);
    // 30 transcription credits, then the 5 add-on credits were released.
    assert.equal(wallet.available, 220);
  } finally {
    close();
  }
});

test("a crashed worker freezes nothing: credits stay reserved across requeues and are released only on the final failure", async () => {
  const env = testEnv();
  const { db, close } = createTestDb();
  try {
    const { tenantId } = await createAccount(db, { credits: 100 });
    const { job } = await createJob(env, db, {
      tenantId,
      guestId: null,
      userId: null,
      viaApi: false,
      source,
      options: {},
      durationSeconds: 600,
    });
    const row = await worker(db);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const leased = await tryLease(db, row, { fallbackAfter: 90, now: Date.now });
      assert.equal(leased?.id, job.id);
      await db.run("UPDATE transcription_jobs SET lease_expires_at = ? WHERE id = ?", [
        new Date(Date.now() - 1000).toISOString(),
        job.id,
      ]);
      const requeued = await requeueExpired(db);
      assert.equal(requeued.requeued, 1);
      const wallet = await walletOf(db, tenantId);
      assert.equal(wallet.reserved, 30, "the reservation must survive requeues");
      assert.equal(wallet.purchased, 100, "nothing is charged for a job that never finished");
      assert.equal(await minutesUsed(db, tenantId), 10, "minutes stay held across requeues");
    }
    const leased = await tryLease(db, row, { fallbackAfter: 90, now: Date.now });
    assert.equal(leased?.id, job.id);
    await db.run("UPDATE transcription_jobs SET lease_expires_at = ? WHERE id = ?", [
      new Date(Date.now() - 1000).toISOString(),
      job.id,
    ]);
    const final = await requeueExpired(db);
    assert.equal(final.failed, 1);
    const after = await walletOf(db, tenantId);
    assert.equal(after.reserved, 0);
    assert.equal(after.purchased, 100);
    assert.equal(await minutesUsed(db, tenantId), 0);
    assert.equal((await getJob(db, job.id))?.status, "failed");
  } finally {
    close();
  }
});

test("three retryable worker failures fail the job and release the reservation", async () => {
  const env = testEnv();
  const { db, close } = createTestDb();
  try {
    const { tenantId } = await createAccount(db, { credits: 100 });
    const { job } = await createJob(env, db, {
      tenantId,
      guestId: null,
      userId: null,
      viaApi: false,
      source,
      options: {},
      durationSeconds: 300,
    });
    const row = await worker(db);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const leased = await tryLease(db, row, { fallbackAfter: 90, now: Date.now });
      assert.equal(leased?.id, job.id);
      const result = await failJob(env, db, row.id, job.id, "source_unavailable", true);
      assert.equal(result.requeued, attempt < 3);
      if (attempt < 3) assert.equal((await getJob(db, job.id))?.status, "queued");
    }
    const failed = await getJob(db, job.id);
    assert.equal(failed?.status, "failed");
    assert.equal(failed?.attempts, 3);
    const wallet = await walletOf(db, tenantId);
    assert.equal(wallet.reserved, 0);
    assert.equal(wallet.purchased, 100);
    assert.equal(await minutesUsed(db, tenantId), 0);
  } finally {
    close();
  }
});

test("a non-retryable failure stops after one attempt instead of burning three GPU runs", async () => {
  const env = testEnv();
  const { db, close } = createTestDb();
  try {
    const { tenantId } = await createAccount(db, { credits: 100 });
    const { job } = await createJob(env, db, {
      tenantId,
      guestId: null,
      userId: null,
      viaApi: false,
      source,
      options: {},
      durationSeconds: 300,
    });
    const row = await worker(db);
    await tryLease(db, row, { fallbackAfter: 90, now: Date.now });
    const result = await failJob(env, db, row.id, job.id, "no_media", false);
    assert.equal(result.requeued, false);
    const failed = await getJob(db, job.id);
    assert.equal(failed?.status, "failed");
    assert.equal(failed?.attempts, 1);
    assert.equal((await walletOf(db, tenantId)).reserved, 0);
  } finally {
    close();
  }
});

test("cancelling a leased job releases the reservation and clears the lease", async () => {
  const env = testEnv();
  const { db, close } = createTestDb();
  try {
    const { tenantId } = await createAccount(db, { credits: 100 });
    const { job } = await createJob(env, db, {
      tenantId,
      guestId: null,
      userId: null,
      viaApi: false,
      source,
      options: {},
      durationSeconds: 600,
    });
    const row = await worker(db);
    const leased = await tryLease(db, row, { fallbackAfter: 90, now: Date.now });
    assert.ok(leased?.lease_token);
    await cancelJob(env, db, job);
    const cancelled = await getJob(db, job.id);
    assert.equal(cancelled?.status, "cancelled");
    assert.equal(cancelled?.leased_by, null);
    assert.equal(cancelled?.lease_token, null);
    assert.equal((await walletOf(db, tenantId)).reserved, 0);
    assert.equal(await minutesUsed(db, tenantId), 0);

    // A completion from the cancelled lease must not resurrect the job.
    const late = await completeJob(env, db, row.id, job.id, { stage: "transcribe", transcript }, leased?.lease_token);
    assert.equal(late.accepted, false);
  } finally {
    close();
  }
});

const youtube = {
  kind: "youtube" as const,
  ref: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  host: "www.youtube.com",
  multi: null,
  ytdlp: true,
  label: "YouTube",
};

test("a YouTube link asks for captions by default and is free when the probe finds them", async () => {
  const env = testEnv();
  const { db, close } = createTestDb();
  try {
    const { tenantId } = await createAccount(db);
    const { job } = await createJob(env, db, {
      tenantId,
      guestId: null,
      userId: null,
      viaApi: false,
      source: youtube,
      options: {},
    });
    assert.equal(job.stage, "probe");
    assert.equal(JSON.parse(job.options_json).use_creator_captions, true);

    const priced = await recordProbe(env, db, job, { durationSeconds: 3600, hasCreatorCaptions: true });
    assert.equal(priced.status, "queued");
    assert.equal(priced.free, 1);
    assert.equal((await walletOf(db, tenantId)).reserved, 0);
  } finally {
    close();
  }
});

test("a YouTube link without captions is priced as a normal transcription", async () => {
  const env = testEnv();
  const { db, close } = createTestDb();
  try {
    const { tenantId } = await createAccount(db);
    const { job } = await createJob(env, db, {
      tenantId,
      guestId: null,
      userId: null,
      viaApi: false,
      source: youtube,
      options: {},
    });
    const priced = await recordProbe(env, db, job, { durationSeconds: 600, hasCreatorCaptions: false });
    assert.equal(priced.free, 0);
    assert.equal(priced.reserved_credits, 10 * PRICING.creditsPerMinute);
    const stored = await getJob(db, job.id);
    assert.equal(JSON.parse(stored?.options_json ?? "{}").use_creator_captions, false);
  } finally {
    close();
  }
});

test("opting out of captions on YouTube is respected", async () => {
  const env = testEnv();
  const { db, close } = createTestDb();
  try {
    const { tenantId } = await createAccount(db);
    const { job } = await createJob(env, db, {
      tenantId,
      guestId: null,
      userId: null,
      viaApi: false,
      source: youtube,
      options: { use_creator_captions: false },
      durationSeconds: 120,
    });
    assert.equal(job.stage, "transcribe");
    assert.equal(job.free, 1);
  } finally {
    close();
  }
});
