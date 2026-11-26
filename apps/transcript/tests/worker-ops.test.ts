import assert from "node:assert/strict";
import { test } from "node:test";
import "../src/lib/platform";
import { evaluateWorkerAlerts } from "../src/lib/worker-alerts";
import {
  compareVersions,
  createWorkerRelease,
  releaseKey,
  updateManifestFor,
  validReleaseVersion,
} from "../src/lib/worker-releases";
import {
  heartbeat,
  normalizeWorkerConfig,
  normalizeWorkerMetrics,
  recordWorkerMetrics,
  registerWorker,
  updateWorkerConfig,
  type WorkerConfig,
  type WorkerRow,
  workerConfigFor,
} from "../src/lib/workers";
import { createTestDb } from "./support/db";
import { testEnv } from "./support/fixtures";

async function registered(db: Awaited<ReturnType<typeof createTestDb>>["db"]) {
  const { worker } = await registerWorker(db, { name: "home-gpu", tier: "primary" });
  await heartbeat(db, worker, { version: "1.9.0" });
  return worker;
}

test("remote config is clamped, versioned and follows the tier column", async () => {
  const { db, close } = createTestDb();
  try {
    const worker = await registered(db);
    const updated = await updateWorkerConfig(db, worker.id, {
      tier: "fallback",
      concurrency: 99,
      maxAudioSeconds: 5,
      minFreeDiskGb: 999,
      canDownloadYoutube: false,
      alerts: { enabled: false, cpuPercent: 10 },
    });
    assert.ok(updated);
    assert.equal(updated.configVersion, 1);
    assert.equal(updated.config.tier, "fallback");
    assert.equal(updated.config.concurrency, 8);
    assert.equal(updated.config.maxAudioSeconds, 60);
    assert.equal(updated.config.minFreeDiskGb, 200);
    assert.equal(updated.config.canDownloadYoutube, false);
    assert.equal(updated.config.alerts.enabled, false);
    assert.equal(updated.config.alerts.cpuPercent, 50);

    const row = await db.first<WorkerRow>("SELECT * FROM workers WHERE id = ?", [worker.id]);
    assert.ok(row);
    assert.equal(row.tier, "fallback");
    assert.equal(row.config_version, 1);
    assert.equal(workerConfigFor(row).alerts.enabled, false);

    const second = await updateWorkerConfig(db, worker.id, { concurrency: 2 });
    assert.ok(second);
    assert.equal(second.configVersion, 2);
    assert.equal(second.config.concurrency, 2);
    assert.equal(second.config.tier, "fallback", "an omitted field keeps the stored value");
    assert.equal(second.config.alerts.enabled, false);
  } finally {
    close();
  }
});

test("normalizeWorkerConfig rejects nonsense instead of widening limits", () => {
  const base: WorkerConfig = {
    tier: "primary",
    concurrency: 1,
    maxAudioSeconds: 10800,
    canDownloadYoutube: true,
    canDownloadTiktok: true,
    minFreeDiskGb: 5,
    autoUpdate: true,
    alerts: { enabled: true, cpuPercent: 95, memPercent: 92, diskFreePercent: 10, cpuTempC: 90, gpuTempC: 90 },
  };
  const result = normalizeWorkerConfig(
    {
      tier: "supreme",
      concurrency: Number.NaN,
      maxAudioSeconds: "600",
      minFreeDiskGb: -4,
      canDownloadYoutube: "yes",
      alerts: { gpuTempC: 200, diskFreePercent: 0 },
    },
    base,
  );
  assert.equal(result.tier, "primary");
  assert.equal(result.concurrency, 1);
  assert.equal(result.maxAudioSeconds, 600);
  assert.equal(result.minFreeDiskGb, 1);
  assert.equal(result.canDownloadYoutube, true);
  assert.equal(result.alerts.gpuTempC, 115);
  assert.equal(result.alerts.diskFreePercent, 1);
});

test("metrics are validated, stored once per minute and reported in the heartbeat", async () => {
  const { db, close } = createTestDb();
  try {
    const worker = await registered(db);
    assert.equal(normalizeWorkerMetrics({ cpuPercent: Number.NaN }), null);
    assert.equal(
      normalizeWorkerMetrics({ memUsedBytes: 1, memTotalBytes: 0 }),
      null,
      "a byte count without a total is not a sample",
    );

    const metrics = normalizeWorkerMetrics({
      cpuPercent: 42.5,
      cpuCount: 24,
      memUsedBytes: 8 * 1024 ** 3,
      memTotalBytes: 32 * 1024 ** 3,
      diskFreeBytes: 100 * 1024 ** 3,
      diskTotalBytes: 1000 * 1024 ** 3,
      cpuTempC: 71.2,
      gpuTempC: 68,
      gpuUsagePercent: 96,
      tempSource: "librehardwaremonitor",
      gpuName: "AMD Radeon RX 6800",
      activeJobs: 1,
    });
    assert.ok(metrics);

    const minute = Date.UTC(2026, 9, 29, 12, 0, 30);
    await recordWorkerMetrics(db, worker.id, metrics, minute);
    await recordWorkerMetrics(db, worker.id, { ...metrics, cpuPercent: 55 }, minute + 10_000);
    const rows = await db.all<{ sampled_at: string; cpu_percent: number }>(
      "SELECT * FROM worker_metrics WHERE worker_id = ?",
      [worker.id],
    );
    assert.equal(rows.length, 1, "two samples in one minute upsert a single row");
    assert.equal(rows[0].cpu_percent, 55);

    await heartbeat(db, worker, {
      version: "1.9.1",
      capabilities: { platform: "windows", arch: "amd64" },
      configVersion: 4,
      metrics: { ...metrics, activeJobs: 1 },
      update: { state: "staged", version: "1.10.0" },
      activeJobs: 1,
    });
    const fresh = await db.first<WorkerRow>("SELECT * FROM workers WHERE id = ?", [worker.id]);
    assert.ok(fresh);
    assert.equal(fresh.version, "1.9.1");
    assert.equal(fresh.applied_config_version, 4);
    assert.equal(JSON.parse(fresh.metrics_json ?? "{}").cpuPercent, 42.5);
    assert.equal(JSON.parse(fresh.update_json ?? "{}").state, "staged");
  } finally {
    close();
  }
});

test("release versions compare numerically and the manifest needs a newer build", async () => {
  assert.equal(compareVersions("1.9.0", "1.10.0"), -1);
  assert.equal(compareVersions("v1.10.0", "1.10.0"), 0);
  assert.equal(compareVersions("dev", "1.0.0"), -1);
  assert.equal(validReleaseVersion("1.9.0"), true);
  assert.equal(validReleaseVersion("v1.9.0"), false);
  assert.equal(validReleaseVersion("1.9"), false);
  assert.equal(validReleaseVersion("1.9.0-beta"), false, "a pre-release would sort equal to the stable release");

  const { db, close } = createTestDb();
  try {
    const env = {
      ...testEnv(),
      R2_ACCOUNT_ID: "account",
      R2_ACCESS_KEY_ID: "access",
      R2_SECRET_ACCESS_KEY: "secret",
    };
    const key = releaseKey("1.10.0", "windows", "amd64");
    await createWorkerRelease(db, {
      version: "1.10.0",
      platform: "windows",
      arch: "amd64",
      objectKey: key,
      sha256: "a".repeat(64),
      sizeBytes: 12_000_000,
      notes: "dashboard",
      actorId: "usr_1",
    });

    const manifest = await updateManifestFor(env, db, {
      platform: "windows",
      arch: "amd64",
      currentVersion: "1.9.0",
    });
    assert.ok(manifest);
    assert.equal(manifest.version, "1.10.0");
    assert.equal(manifest.sha256, "a".repeat(64));
    assert.match(manifest.url, /^https:\/\/transcript-outputs\.account\.r2\.cloudflarestorage\.com\//);
    assert.ok(manifest.url.includes(encodeURIComponent(key).replaceAll("%2F", "/")));

    assert.equal(
      await updateManifestFor(env, db, { platform: "windows", arch: "amd64", currentVersion: "1.10.0" }),
      null,
    );
    assert.equal(await updateManifestFor(env, db, { platform: "linux", arch: "amd64", currentVersion: "1.0.0" }), null);
  } finally {
    close();
  }
});

test("a sustained threshold emails once and a recovery emails once", async () => {
  const { db, close } = createTestDb();
  try {
    const worker = await registered(db);
    await updateWorkerConfig(db, worker.id, {
      alerts: { enabled: true, cpuPercent: 90, memPercent: 99, diskFreePercent: 5, cpuTempC: 100, gpuTempC: 100 },
    });
    const base = Date.now();
    // Two consecutive minutes above 90%: enough for a warning.
    await recordWorkerMetrics(db, worker.id, { cpuPercent: 96, tempSource: "test" }, base - 60_000);
    await recordWorkerMetrics(db, worker.id, { cpuPercent: 97, tempSource: "test" }, base);

    const fired = await evaluateWorkerAlerts(testEnv(), db, base);
    assert.deepEqual(fired, ["worker_home-gpu_cpu"]);
    const state = await db.first<{ severity: string }>(
      "SELECT * FROM worker_alert_state WHERE worker_id = ? AND metric = 'cpu'",
      [worker.id],
    );
    assert.equal(state?.severity, "warn");
    let emails = await db.all<{ template: string }>(
      "SELECT template FROM email_outbox WHERE template = 'worker_alert'",
    );
    assert.equal(emails.length, 1);

    // A second cron tick while the condition persists must not email again.
    await evaluateWorkerAlerts(testEnv(), db, base + 60_000);
    emails = await db.all<{ template: string }>("SELECT template FROM email_outbox WHERE template = 'worker_alert'");
    assert.equal(emails.length, 1);

    // Three minutes back under the hysteresis threshold: one recovery.
    const later = base + 3 * 60_000;
    await heartbeat(db, worker, { version: "1.9.0" });
    await db.run("UPDATE workers SET last_heartbeat_at = ? WHERE id = ?", [
      new Date(later + 120_000).toISOString(),
      worker.id,
    ]);
    for (const offset of [0, 60_000, 120_000]) {
      await recordWorkerMetrics(db, worker.id, { cpuPercent: 50 }, later + offset);
    }
    const recovered = await evaluateWorkerAlerts(testEnv(), db, later + 180_000);
    assert.deepEqual(recovered, ["worker_home-gpu_cpu_recovered"]);
    emails = await db.all<{ template: string }>("SELECT template FROM email_outbox WHERE template = 'worker_alert'");
    assert.equal(emails.length, 2);
    const stateAfter = await db.first<{ severity: string }>(
      "SELECT * FROM worker_alert_state WHERE worker_id = ? AND metric = 'cpu'",
      [worker.id],
    );
    assert.equal(stateAfter?.severity, "ok");
  } finally {
    close();
  }
});
