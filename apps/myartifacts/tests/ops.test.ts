import assert from "node:assert/strict";
import { test } from "node:test";
import { completeUpload, createUpload, getArtifact, putInline } from "../src/lib/artifacts/service";
import { adminOverview, buildDigest, runDailyCron, SWEEP_BATCH, sweepArtifacts } from "../src/lib/ops";
import { createShare, resolveShare, ShareUnavailableError } from "../src/lib/shares/service";
import { setupApi } from "./support/api";
import { A, B, setupArtifacts } from "./support/artifacts";

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

type Setup = Awaited<ReturnType<typeof setupArtifacts>>;

const sweep = (t: Setup, batchSize?: number) =>
  sweepArtifacts({ db: t.db, storage: t.store.storage, now: t.time.now, batchSize });
const status = async (t: Setup, id: string) =>
  (await t.db.first<{ status: string }>("SELECT status FROM artifacts WHERE id = ?", [id]))?.status;

test("the sweep deletes expired files, object first and then the row, and keeps everything else", async () => {
  const t = await setupArtifacts();
  try {
    const keep = await putInline(t.deps, A, { name: "keep.txt", content: "forever" });
    const later = await putInline(t.deps, A, { name: "later.txt", content: "soon", expires_in_days: 10 });
    const due = await putInline(t.deps, A, { name: "due.txt", content: "12345", expires_in_days: 1 });
    const dueKey = (await t.db.first<{ object_key: string }>("SELECT object_key FROM artifacts WHERE id = ?", [due.id]))
      ?.object_key as string;

    const nothing = await sweep(t);
    assert.deepEqual(
      { ...nothing },
      { expired_deleted: 0, pending_deleted: 0, bytes_freed: 0, storage_errors: 0, more: false },
    );

    t.time.advance(2 * DAY);
    const result = await sweep(t);
    assert.deepEqual(
      { ...result },
      { expired_deleted: 1, pending_deleted: 0, bytes_freed: 5, storage_errors: 0, more: false },
    );
    assert.equal(t.store.objects.has(dueKey), false, "the object is gone from storage");
    assert.equal(await status(t, due.id), "deleted");
    const row = await t.db.first<{ deleted_at: string }>("SELECT deleted_at FROM artifacts WHERE id = ?", [due.id]);
    assert.equal(row?.deleted_at, t.time.now().toISOString());
    assert.equal(await status(t, keep.id), "ready");
    assert.equal(await status(t, later.id), "ready");
    assert.equal(t.store.objects.size, 2);
  } finally {
    t.close();
  }
});

test("a share loses an expired file with the sweep, and a share left with nothing is gone", async () => {
  const t = await setupArtifacts();
  try {
    const keep = await putInline(t.deps, A, { name: "keep.txt", content: "k" });
    const short = await putInline(t.deps, A, { name: "short.txt", content: "s", expires_in_days: 1 });
    const bundle = await createShare(t.shareDeps, A, { artifact_ids: [keep.id, short.id] });
    const alone = await createShare(t.shareDeps, A, { artifact_ids: [short.id] });
    t.time.advance(2 * DAY);
    await sweep(t);
    const remaining = await t.db.all<{ share_id: string; artifact_id: string }>(
      "SELECT share_id, artifact_id FROM share_items",
    );
    assert.deepEqual(
      remaining.map((item) => `${item.share_id}:${item.artifact_id}`),
      [`${bundle.share_id}:${keep.id}`],
    );
    assert.equal((await resolveShare(t.shareDeps, bundle.share_id)).items.length, 1);
    await assert.rejects(
      resolveShare(t.shareDeps, alone.share_id),
      (error) => error instanceof ShareUnavailableError && error.status === 410,
    );
  } finally {
    t.close();
  }
});

test("an upload never completed within 24 hours is removed with its object, if one was PUT, and a fresh one is left alone", async () => {
  const t = await setupArtifacts();
  try {
    const stale = await createUpload(t.deps, A, { name: "stale.bin", size: 4 });
    const staleKey = (
      await t.db.first<{ object_key: string }>("SELECT object_key FROM artifacts WHERE id = ?", [stale.artifact_id])
    )?.object_key as string;
    t.store.objects.set(staleKey, { bytes: new Uint8Array(4), contentType: "application/octet-stream" });
    const neverSent = await createUpload(t.deps, A, { name: "never.bin", size: 4 });
    t.time.advance(23 * HOUR);
    const fresh = await createUpload(t.deps, A, { name: "fresh.bin", size: 4 });

    assert.deepEqual(
      { ...(await sweep(t)) },
      { expired_deleted: 0, pending_deleted: 0, bytes_freed: 0, storage_errors: 0, more: false },
    );
    t.time.advance(2 * HOUR);
    const result = await sweep(t);
    assert.equal(result.pending_deleted, 2);
    assert.equal(t.store.objects.has(staleKey), false, "the object that was PUT but never completed is deleted");
    assert.equal(await status(t, stale.artifact_id), "deleted");
    assert.equal(
      await status(t, neverSent.artifact_id),
      "deleted",
      "an upload whose object never arrived is simply closed",
    );
    assert.equal(await status(t, fresh.artifact_id), "pending");
  } finally {
    t.close();
  }
});

test("an abandoned upload can no longer be completed, so completion and cleanup cannot race", async () => {
  const t = await setupArtifacts();
  try {
    const upload = await createUpload(t.deps, A, { name: "late.bin", size: 2 });
    const key = (
      await t.db.first<{ object_key: string }>("SELECT object_key FROM artifacts WHERE id = ?", [upload.artifact_id])
    )?.object_key as string;
    t.store.objects.set(key, { bytes: new Uint8Array(2), contentType: "application/octet-stream" });
    t.time.advance(DAY - 1000);
    assert.equal((await completeUpload(t.deps, A, upload.artifact_id)).status, "ready", "just inside the day");
    const second = await createUpload(t.deps, A, { name: "later.bin", size: 2 });
    t.store.objects.set(
      (await t.db.first<{ object_key: string }>("SELECT object_key FROM artifacts WHERE id = ?", [second.artifact_id]))
        ?.object_key as string,
      {
        bytes: new Uint8Array(2),
        contentType: "application/octet-stream",
      },
    );
    t.time.advance(DAY + 1000);
    await assert.rejects(completeUpload(t.deps, A, second.artifact_id), { code: "NOT_FOUND" });
    await assert.rejects(getArtifact(t.deps, A, second.artifact_id), { code: "NOT_FOUND" });
  } finally {
    t.close();
  }
});

test("repeating the sweep changes nothing and does not touch storage again", async () => {
  const t = await setupArtifacts();
  try {
    await putInline(t.deps, A, { name: "a.txt", content: "a", expires_in_days: 1 });
    await createUpload(t.deps, A, { name: "b.bin", size: 1 });
    t.time.advance(2 * DAY);
    const first = await sweep(t);
    assert.equal(first.expired_deleted + first.pending_deleted, 2);
    const deletes = t.store.log.deletes.length;
    const again = await sweep(t);
    assert.deepEqual(
      { ...again },
      { expired_deleted: 0, pending_deleted: 0, bytes_freed: 0, storage_errors: 0, more: false },
    );
    assert.equal(t.store.log.deletes.length, deletes);
    assert.equal(
      (await t.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM artifacts WHERE status = 'deleted'"))?.n,
      2,
    );
  } finally {
    t.close();
  }
});

test("a run handles 500 rows of each kind at most, and the rest drain over the next runs", async () => {
  const t = await setupArtifacts();
  try {
    assert.equal(SWEEP_BATCH, 500);
    const insert = (index: number) =>
      t.db.run(
        `INSERT INTO artifacts (id, tenant_id, object_key, name, mime, declared_size, size, status, source, expires_at, created_at, completed_at)
         VALUES (?, 'ten_a', ?, 'f.txt', 'text/plain', 1, 1, 'ready', 'inline', '2026-11-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
        [`id${String(index).padStart(24, "0")}`, `ma/ten_a/id${index}/f.txt`],
      );
    for (let index = 0; index < 1203; index += 1) await insert(index);
    const runs = [await sweep(t), await sweep(t), await sweep(t), await sweep(t)];
    assert.deepEqual(
      runs.map((run) => run.expired_deleted),
      [500, 500, 203, 0],
    );
    assert.deepEqual(
      runs.map((run) => run.more),
      [true, true, false, false],
    );
    assert.equal(runs[0].bytes_freed, 500);
    assert.equal((await t.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM artifacts WHERE status = 'ready'"))?.n, 0);
    assert.equal((await t.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM sweep_runs"))?.n, 4);

    // The pending category has its own batch.
    for (let index = 0; index < 7; index += 1) await createUpload(t.deps, A, { name: `p${index}.bin`, size: 1 });
    t.time.advance(2 * DAY);
    const small = await sweep(t, 3);
    assert.equal(small.pending_deleted, 3);
    assert.equal(small.more, true);
  } finally {
    t.close();
  }
});

test("a storage failure leaves the file in place, is counted, and is retried by the next run", async () => {
  const t = await setupArtifacts();
  try {
    const ok = await putInline(t.deps, A, { name: "ok.txt", content: "o", expires_in_days: 1 });
    const stuck = await putInline(t.deps, A, { name: "stuck.txt", content: "s", expires_in_days: 1 });
    const stuckKey = (
      await t.db.first<{ object_key: string }>("SELECT object_key FROM artifacts WHERE id = ?", [stuck.id])
    )?.object_key as string;
    const realDelete = t.store.storage.deleteObject;
    t.store.storage.deleteObject = async (key) => {
      if (key === stuckKey) throw new Error("Object storage DELETE failed (HTTP 503).");
      return realDelete(key);
    };
    t.time.advance(2 * DAY);
    const failed = await sweep(t);
    assert.equal(failed.expired_deleted, 1);
    assert.equal(failed.storage_errors, 1);
    assert.equal(await status(t, ok.id), "deleted");
    assert.equal(await status(t, stuck.id), "ready", "its row is untouched, so it is tried again");
    assert.equal(t.store.objects.has(stuckKey), true);

    t.store.storage.deleteObject = realDelete;
    const retried = await sweep(t);
    assert.equal(retried.expired_deleted, 1);
    assert.equal(retried.storage_errors, 0);
    assert.equal(await status(t, stuck.id), "deleted");
    assert.equal(t.store.objects.size, 0);
  } finally {
    t.close();
  }
});

test("a sweep never touches a file that is not due, whoever owns it", async () => {
  const t = await setupArtifacts();
  try {
    const mine = await putInline(t.deps, A, { name: "mine.txt", content: "m", expires_in_days: 5 });
    const theirs = await putInline(t.deps, B, { name: "theirs.txt", content: "t", expires_in_days: 1 });
    t.time.advance(2 * DAY);
    const result = await sweep(t);
    assert.equal(result.expired_deleted, 1, "the sweep spans accounts");
    assert.equal(await status(t, mine.id), "ready");
    assert.equal(await status(t, theirs.id), "deleted");
  } finally {
    t.close();
  }
});

test("the overview and the digest total the service from the data and the sweep history", async () => {
  const t = await setupArtifacts();
  try {
    assert.deepEqual(
      { ...(await adminOverview(t.db, t.time.now())) },
      { files: 0, bytes: 0, pending_uploads: 0, active_shares: 0, last_sweep: null },
    );

    const a = await putInline(t.deps, A, { name: "a.txt", content: "12345" });
    await putInline(t.deps, B, { name: "b.txt", content: "123", expires_in_days: 1 });
    await createUpload(t.deps, A, { name: "p.bin", size: 9 });
    await createShare(t.shareDeps, A, { artifact_ids: [a.id] });
    const revoked = await createShare(t.shareDeps, A, { artifact_ids: [a.id] });
    await t.db.run("UPDATE shares SET revoked_at = ? WHERE id = ?", [t.time.now().toISOString(), revoked.share_id]);

    const overview = await adminOverview(t.db, t.time.now());
    assert.deepEqual({ ...overview }, { files: 2, bytes: 8, pending_uploads: 1, active_shares: 1, last_sweep: null });

    t.time.advance(2 * DAY);
    await sweep(t);
    const after = await adminOverview(t.db, t.time.now());
    assert.equal(after.files, 1);
    assert.equal(after.bytes, 5);
    assert.equal(after.pending_uploads, 0, "the abandoned upload was closed");
    assert.equal(after.last_sweep?.expired_deleted, 1);
    assert.equal(after.last_sweep?.pending_deleted, 1);
    assert.equal(after.last_sweep?.bytes_freed, 3);

    const digest = await buildDigest(t.db, t.time.now());
    assert.equal(digest.sweeps, 1);
    assert.equal(digest.expired_deleted, 1);
    assert.equal(digest.pending_deleted, 1);
    assert.equal(digest.bytes_freed, 3);
    assert.equal(digest.storage_errors, 0);
    assert.equal(digest.files_added, 0, "the uploads were two days ago");
    const recent = await putInline(t.deps, A, { name: "recent.txt", content: "r" });
    assert.ok(recent.id);
    assert.equal((await buildDigest(t.db, t.time.now())).files_added, 1);
  } finally {
    t.close();
  }
});

test("the daily run prunes old sweep history, emails the operator the totals and makes no file-level detail public", async () => {
  const t = await setupApi();
  try {
    await putInline(t.deps, A, { name: "SECRET-NAME.txt", content: "12345" });
    const old = new Date(t.time.now().getTime() - 40 * DAY).toISOString();
    await t.db.run("INSERT INTO sweep_runs (id, ran_at, expired_deleted) VALUES ('old', ?, 9)", [old]);
    await sweepArtifacts({ db: t.db, storage: t.store.storage, now: t.time.now });

    const lines: string[] = [];
    const log = console.log;
    const error = console.error;
    console.log = (...args: unknown[]) => void lines.push(args.join(" "));
    console.error = (...args: unknown[]) => void lines.push(args.join(" "));
    let outcome: Awaited<ReturnType<typeof runDailyCron>>;
    try {
      outcome = await runDailyCron(t.env, t.time.now());
    } finally {
      console.log = log;
      console.error = error;
    }
    assert.equal(outcome.digest.files, 1);
    assert.equal(outcome.digest.bytes, 5);
    assert.equal(outcome.emailed, true, "the digest went to ADMIN_EMAILS");
    assert.ok(
      lines.some((line) => line.includes("owner-a@example.com")),
      "addressed to the admin",
    );
    assert.equal(
      (await t.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM sweep_runs WHERE id = 'old'"))?.n,
      0,
      "history older than 30 days is pruned",
    );
    assert.equal((await t.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM sweep_runs"))?.n, 1);
    assert.ok(!lines.join("\n").includes("SECRET-NAME"), "no file name in the digest");

    // The digest email is throttled to one an hour, so a repeat in the same hour is not sent again.
    const repeat = await runDailyCron(t.env, t.time.now());
    assert.equal(repeat.emailed, false);
  } finally {
    t.close();
  }
});
