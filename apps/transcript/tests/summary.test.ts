import assert from "node:assert/strict";
import { test } from "node:test";
import "../src/lib/platform";
import { chunkSegments, parseFiltered, runAddons, summarise } from "../src/lib/addons/summary";
import { completeJob, createJob, getJob } from "../src/lib/jobs";
import type { NormalizedTranscript } from "../src/lib/transcripts";
import { heartbeat, registerWorker } from "../src/lib/workers";
import { createTestDb } from "./support/db";
import { createAccount, ledgerOf, testEnv, walletOf } from "./support/fixtures";

const source = {
  kind: "direct" as const,
  ref: "https://example.com/a.mp3",
  url: "https://example.com/a.mp3",
  host: "example.com",
  multi: null,
  ytdlp: false,
  label: "example.com",
};

const transcript: NormalizedTranscript = {
  segments: [
    { start: 0, end: 4, text: "We charge three credits per minute." },
    { start: 4, end: 8, text: "The weather was nice." },
    { start: 8, end: 12, text: "Pricing starts at ten dollars." },
  ],
  language: "en",
  model: "large-v3-turbo",
};

function fakeFetch(statuses: number[], body = "Summary text"): typeof fetch {
  let call = 0;
  return (async () => {
    const status = statuses[Math.min(call, statuses.length - 1)];
    call += 1;
    if (status >= 400) return new Response("rate limited", { status });
    return new Response(JSON.stringify({ choices: [{ message: { content: body } }], model: "free-model" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

async function worker(db: Awaited<ReturnType<typeof createTestDb>>["db"]) {
  const { worker: row } = await registerWorker(db, { name: "w", tier: "primary" });
  await heartbeat(db, row, { capabilities: { maxAudioSeconds: 7200 } });
  return row;
}

test("words are chunked to the model window without dropping segments", () => {
  const long: NormalizedTranscript = {
    segments: Array.from({ length: 40 }, (_, index) => ({
      start: index * 2,
      end: index * 2 + 2,
      text: `Sentence ${index} with a reasonable number of words in it.`,
    })),
  };
  const chunks = chunkSegments(long.segments, 300);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.flat().length, long.segments.length);
});

test("a 429 moves to the next model instead of failing", async () => {
  const env = { ...testEnv(), OPENROUTER_API_KEY: "k" };
  const { db, close } = createTestDb();
  try {
    const result = await summarise(env, db, transcript, { preset: "bullets" }, fakeFetch([429, 200]));
    assert.equal(result.text, "Summary text");
  } finally {
    close();
  }
});

test("filter results keep only real timestamped segments", () => {
  const parsed = parseFiltered("[00:00] We charge three credits per minute.\n[09:99] nope", transcript.segments);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].start, 0);
  assert.deepEqual(parseFiltered("NONE", transcript.segments), []);
});

test("all models failing releases the add-on credits and keeps the transcript", async () => {
  const env = { ...testEnv(), OPENROUTER_API_KEY: "k" };
  const { db, close } = createTestDb();
  try {
    const { tenantId } = await createAccount(db, { credits: 100 });
    const { job } = await createJob(env, db, {
      tenantId,
      guestId: null,
      userId: null,
      viaApi: false,
      source,
      options: { summary: { preset: "short" } },
      durationSeconds: 600,
    });
    const row = await worker(db);
    await db.run("UPDATE transcription_jobs SET status='leased', leased_by=?, lease_expires_at=? WHERE id=?", [
      row.id,
      new Date(Date.now() + 60_000).toISOString(),
      job.id,
    ]);
    const done = await completeJob(env, db, row.id, job.id, { stage: "transcribe", transcript });
    assert.equal(done.accepted, true);

    const state = await runAddons(env, db, job.id, fakeFetch([429]));
    assert.equal(state.status, "failed");
    assert.equal(state.error, "all_failed");

    const after = await getJob(db, job.id);
    assert.equal(after?.status, "succeeded");
    assert.equal(after?.pricing_state, "settled");
    assert.equal(after?.charged_credits, 30);
    const wallet = await walletOf(db, tenantId);
    assert.equal(wallet.reserved, 0);
    const settles = (await ledgerOf(db, tenantId)).filter((entry) => entry.kind === "settle");
    assert.equal(
      settles.reduce((sum, entry) => sum + entry.credits, 0),
      -30,
    );
  } finally {
    close();
  }
});

test("a successful summary charges the add-on exactly once", async () => {
  const env = { ...testEnv(), OPENROUTER_API_KEY: "k" };
  const { db, close } = createTestDb();
  try {
    const { tenantId } = await createAccount(db, { credits: 100 });
    const { job } = await createJob(env, db, {
      tenantId,
      guestId: null,
      userId: null,
      viaApi: false,
      source,
      options: { summary: { preset: "bullets" } },
      durationSeconds: 300,
    });
    const row = await worker(db);
    await db.run("UPDATE transcription_jobs SET status='leased', leased_by=?, lease_expires_at=? WHERE id=?", [
      row.id,
      new Date(Date.now() + 60_000).toISOString(),
      job.id,
    ]);
    await completeJob(env, db, row.id, job.id, { stage: "transcribe", transcript });
    const state = await runAddons(env, db, job.id, fakeFetch([200]));
    assert.equal(state.status, "done");
    assert.equal(state.summary, "Summary text");

    const after = await getJob(db, job.id);
    assert.equal(after?.charged_credits, 15 + 5);
    assert.equal(after?.reserved_credits, 0);

    // A second run must not charge again (state is settled and the reservation is gone).
    await runAddons(env, db, job.id, fakeFetch([200]));
    assert.equal((await getJob(db, job.id))?.charged_credits, 20);
  } finally {
    close();
  }
});
