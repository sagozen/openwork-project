import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { checkHealth, HEALTH_PROBE_KEY, resetHealthCache } from "../src/lib/health";
import { StorageError } from "../src/lib/storage/s3";
import { setupArtifacts } from "./support/artifacts";

beforeEach(() => resetHealthCache());

test("health is ok when the database answers and the store answers 404 to a key that never exists", async () => {
  const t = await setupArtifacts();
  try {
    const probed: string[] = [];
    const storage = {
      ...t.store.storage,
      headObject: async (key: string) => {
        probed.push(key);
        return t.store.storage.headObject(key);
      },
    };
    assert.deepEqual({ ...(await checkHealth(t.db, () => storage)) }, { status: "ok", db: "ok", storage: "ok" });
    assert.deepEqual(probed, [HEALTH_PROBE_KEY]);
  } finally {
    t.close();
  }
});

test("a refused key, an unreachable store, a missing secret or a dead database all make health degraded", async () => {
  const t = await setupArtifacts();
  try {
    const failing = (error: unknown) => ({ ...t.store.storage, headObject: async () => Promise.reject(error) });
    const cases: Array<[string, () => never | ReturnType<typeof failing>]> = [
      ["forbidden", () => failing(new StorageError("PROVIDER_ERROR", "Object storage HEAD failed (HTTP 403).", 403))],
      ["unreachable", () => failing(new StorageError("PROVIDER_ERROR", "Object storage HEAD could not be reached."))],
      [
        "not configured",
        () => {
          throw new StorageError("PROVIDER_ERROR", "Object storage is not configured: S3_ACCESS_KEY_ID missing.");
        },
      ],
    ];
    for (const [name, make] of cases) {
      resetHealthCache();
      const health = await checkHealth(t.db, make as never);
      assert.deepEqual({ ...health }, { status: "degraded", db: "ok", storage: "down" }, name);
    }
    resetHealthCache();
    const brokenDb = { ...t.db, first: async () => Promise.reject(new Error("D1 down")) };
    assert.deepEqual(
      { ...(await checkHealth(brokenDb as never, () => t.store.storage)) },
      { status: "degraded", db: "down", storage: "ok" },
    );
  } finally {
    t.close();
  }
});

test("the storage answer is reused for 30 seconds so the public route does not call out on every hit", async () => {
  const t = await setupArtifacts();
  try {
    let calls = 0;
    const storage = {
      ...t.store.storage,
      headObject: async (key: string) => {
        calls += 1;
        return t.store.storage.headObject(key);
      },
    };
    await checkHealth(t.db, () => storage, 1_000_000);
    await checkHealth(t.db, () => storage, 1_020_000);
    assert.equal(calls, 1);
    await checkHealth(t.db, () => storage, 1_031_000);
    assert.equal(calls, 2);
  } finally {
    t.close();
  }
});
