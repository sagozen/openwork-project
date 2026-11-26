import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpError } from "@templatedesign/platform/http";
import {
  capState,
  freeJobsUsedToday,
  releaseFreeJob,
  releaseMinutes,
  reserveMinutes,
  takeFreeJob,
} from "../src/lib/quota";
import { createTestDb } from "./support/db";
import { createAccount, minutesUsed, testEnv } from "./support/fixtures";
import "../src/lib/platform";

test("guest free jobs stop at the fifth and a failure gives the slot back", async () => {
  const { db, close } = createTestDb();
  try {
    for (let index = 0; index < 5; index += 1) {
      const result = await takeFreeJob(db, "gst_1", "transcribe", 5);
      assert.equal(result.ok, true);
    }
    const sixth = await takeFreeJob(db, "gst_1", "transcribe", 5);
    assert.equal(sixth.ok, false);
    assert.equal(sixth.used, 5);
    await releaseFreeJob(db, "gst_1", "transcribe");
    const again = await takeFreeJob(db, "gst_1", "transcribe", 5);
    assert.equal(again.ok, true);
    assert.equal(await freeJobsUsedToday(db, "gst_1"), 5);
  } finally {
    close();
  }
});

test("signed-in free jobs stop at the twenty-fifth", async () => {
  const { db, close } = createTestDb();
  try {
    const { tenantId } = await createAccount(db);
    for (let index = 0; index < 25; index += 1) {
      assert.equal((await takeFreeJob(db, tenantId, "transcribe", 25)).ok, true);
    }
    assert.equal((await takeFreeJob(db, tenantId, "transcribe", 25)).ok, false);
  } finally {
    close();
  }
});

test("creator captions have their own allowance and never eat the free-transcription quota", async () => {
  const { db, close } = createTestDb();
  try {
    for (let index = 0; index < 20; index += 1) {
      assert.equal((await takeFreeJob(db, "gst_2", "captions", 20)).ok, true);
    }
    assert.equal((await takeFreeJob(db, "gst_2", "captions", 20)).ok, false);
    assert.equal(await freeJobsUsedToday(db, "gst_2"), 0);
  } finally {
    close();
  }
});

test("the monthly cap is exact and concurrent reservations cannot overshoot", async () => {
  const { db, close } = createTestDb();
  try {
    const { tenantId } = await createAccount(db);
    assert.equal(await reserveMinutes(db, tenantId, 599, 600), true);
    assert.equal(await reserveMinutes(db, tenantId, 2, 600), false);
    assert.equal(await reserveMinutes(db, tenantId, 1, 600), true);

    const parallel = await Promise.all(Array.from({ length: 8 }, () => reserveMinutes(db, tenantId, 10, 610)));
    assert.equal(parallel.filter(Boolean).length, 1);
    assert.equal(await minutesUsed(db, tenantId), 610);
    const state = await capState(db, tenantId, 610);
    assert.equal(state.used, 610);
    assert.equal(state.remaining, 0);
  } finally {
    close();
  }
});

test("releasing minutes restores the cap", async () => {
  const { db, close } = createTestDb();
  try {
    const { tenantId } = await createAccount(db);
    await reserveMinutes(db, tenantId, 20, 600);
    await releaseMinutes(db, tenantId, 20);
    assert.equal(await minutesUsed(db, tenantId), 0);
    await releaseMinutes(db, tenantId, 20);
    assert.equal(await minutesUsed(db, tenantId), 0);
  } finally {
    close();
  }
});

test("the env helper is available for tests that need bindings", () => {
  assert.ok(testEnv().OUTPUTS);
  assert.ok(HttpError);
});
