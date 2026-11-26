import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDigest, purgeExpiredImages } from "../src/lib/ops";
import "../src/lib/platform";
import type { Env } from "../src/lib/types";
import { d1FromSqlite } from "./support/d1";
import { createTestDb } from "./support/db";
import { FakeBucket } from "./support/fakes";

test("the digest adds up provider cost from started megapixels and the credits charged", async () => {
  const { db, raw, close } = createTestDb();
  try {
    await db.run("INSERT INTO tenants (id, name, created_at) VALUES ('ten_1', 'A', '2026-01-01T00:00:00Z')");
    const now = Date.parse("2026-11-06T12:00:00Z");
    const insert = (
      id: string,
      model: string,
      state: string,
      images: number,
      charged: number | null,
      size: [number, number],
      at: string,
    ) =>
      db.run(
        `INSERT INTO image_jobs (id, tenant_id, kind, model, params_json, provider, state, num_images, credits_reserved, credits_charged, created_at, updated_at)
         VALUES (?, 'ten_1', 'generate', ?, ?, 'fal', ?, ?, ?, ?, ?, ?)`,
        [
          id,
          model,
          JSON.stringify({ prompt: "p", width: size[0], height: size[1] }),
          state,
          images,
          charged ?? 0,
          charged,
          at,
          at,
        ],
      );
    // 2 images of 0.999 MP on the text model: 2 x 1 MP x $0.02, charged 8 credits.
    await insert("j1", "qwen-image", "done", 2, 8, [816, 1224], "2026-11-06T10:00:00Z");
    // 1 image of 1.99 MP on the edit model: 1 x 2 MP x $0.03, charged 12 credits.
    await insert("j2", "qwen-edit", "done", 1, 12, [1152, 1728], "2026-11-06T11:00:00Z");
    await insert("j3", "qwen-image", "failed", 1, 0, [816, 1224], "2026-11-06T11:30:00Z");
    // Made by a registered worker: credits count, provider cost does not.
    await db.run(
      `INSERT INTO image_jobs (id, tenant_id, kind, model, params_json, provider, state, num_images, credits_reserved, credits_charged, created_at, updated_at)
       VALUES ('j5', 'ten_1', 'generate', 'qwen-image', ?, 'worker', 'done', 2, 8, 8, '2026-11-06T11:45:00Z', '2026-11-06T11:45:00Z')`,
      [JSON.stringify({ prompt: "p", width: 816, height: 1224 })],
    );
    // Older than 24 hours: not counted.
    await insert("j4", "qwen-image", "done", 4, 16, [816, 1224], "2026-11-04T10:00:00Z");

    const digest = await buildDigest({ DB: d1FromSqlite(raw) } as unknown as Env, now);
    assert.equal(digest.jobs, 4);
    assert.equal(digest.failed, 1);
    assert.equal(digest.imagesMade, 5);
    assert.equal(digest.workerImages, 2);
    assert.equal(digest.creditsCharged, 28);
    assert.equal(digest.estimatedProviderUsd.toFixed(2), "0.10");
    assert.equal(digest.revenueUsd.toFixed(2), "0.28");
  } finally {
    close();
  }
});

test("the hourly purge removes only images deleted more than 30 days ago", async () => {
  const { db, raw, close } = createTestDb();
  try {
    await db.run("INSERT INTO tenants (id, name, created_at) VALUES ('ten_1', 'A', '2026-01-01T00:00:00Z')");
    await db.run(
      `INSERT INTO image_jobs (id, tenant_id, kind, model, params_json, provider, state, num_images, credits_reserved, created_at, updated_at)
       VALUES ('job_1', 'ten_1', 'generate', 'qwen-image', '{}', 'fal', 'done', 3, 4, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`,
    );
    const insert = (id: string, deletedAt: string | null) =>
      db.run(
        `INSERT INTO images (id, tenant_id, job_id, r2_key, width, height, mime, bytes, prompt, created_at, deleted_at)
         VALUES (?, 'ten_1', 'job_1', ?, 832, 1248, 'image/jpeg', 10, 'p', '2026-09-01T00:00:00.000Z', ?)`,
        [id, `images/ten_1/${id}.jpg`, deletedAt],
      );
    await insert("old", "2026-10-08T11:59:59.000Z");
    await insert("recent", "2026-10-09T12:00:00.000Z");
    await insert("live", null);

    const bucket = new FakeBucket();
    for (const id of ["old", "recent", "live"]) {
      await bucket.put(`images/ten_1/${id}.jpg`, new Uint8Array([1]));
    }
    const env = { DB: d1FromSqlite(raw), IMAGES: bucket.asBucket() } as unknown as Env;
    const now = Date.parse("2026-11-08T12:00:00.000Z");

    assert.equal(await purgeExpiredImages(env, now), 1);
    assert.equal(bucket.objects.has("images/ten_1/old.jpg"), false);
    assert.equal(bucket.objects.has("images/ten_1/recent.jpg"), true);
    assert.equal(bucket.objects.has("images/ten_1/live.jpg"), true);
    assert.equal(await db.first("SELECT id FROM images WHERE id = 'old'"), null);
    assert.equal((await db.first<{ id: string }>("SELECT id FROM images WHERE id = 'recent'"))?.id, "recent");
    assert.equal((await db.first<{ id: string }>("SELECT id FROM images WHERE id = 'live'"))?.id, "live");
    assert.equal(await purgeExpiredImages(env, now), 0);
  } finally {
    close();
  }
});
