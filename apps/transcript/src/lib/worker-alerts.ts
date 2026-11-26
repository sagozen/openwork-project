import { operatorUrl } from "@templatedesign/platform/abuse";
import { alertOperators } from "@templatedesign/platform/alerts";
import type { Db } from "@templatedesign/platform/db";
import { nowIso } from "@templatedesign/platform/db";
import type { Env } from "./types";
import { type WorkerConfig, type WorkerRow, workerConfigFor } from "./workers";

/**
 * Sustained host-threshold alerts for the worker fleet. A warning is emailed when a metric has
 * been over its threshold for two consecutive minute samples and a recovery when it has been
 * under (threshold minus hysteresis) for three. State lives in `worker_alert_state`, so the cron
 * can run every minute without mailing the same condition repeatedly.
 */
interface MetricsRow {
  worker_id: string;
  sampled_at: string;
  cpu_percent: number | null;
  mem_used_bytes: number | null;
  mem_total_bytes: number | null;
  disk_free_bytes: number | null;
  disk_total_bytes: number | null;
  cpu_temp_c: number | null;
  gpu_temp_c: number | null;
  gpu_usage_percent: number | null;
}

interface AlertStateRow {
  worker_id: string;
  metric: string;
  severity: "ok" | "warn";
  value: number | null;
  threshold: number | null;
  since: string;
  updated_at: string;
}

interface Check {
  key: string;
  label: string;
  threshold: number;
  values: number[];
  breach: (value: number, threshold: number) => boolean;
  recovered: (value: number, threshold: number) => boolean;
  format: (value: number) => string;
  hint: string;
}

const ALERT_WINDOW_MS = 10 * 60 * 1000;
const WARN_AFTER_SAMPLES = 2;
const RECOVER_AFTER_SAMPLES = 3;

function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

function formatTemperature(value: number): string {
  return `${value.toFixed(1)}°C`;
}

function freePercent(row: MetricsRow): number | null {
  if (!row.disk_total_bytes || row.disk_total_bytes <= 0 || row.disk_free_bytes === null) return null;
  return (row.disk_free_bytes / row.disk_total_bytes) * 100;
}

function memoryPercent(row: MetricsRow): number | null {
  if (!row.mem_total_bytes || row.mem_total_bytes <= 0 || row.mem_used_bytes === null) return null;
  return (row.mem_used_bytes / row.mem_total_bytes) * 100;
}

function checksFor(rows: MetricsRow[], config: WorkerConfig): Check[] {
  const used = rows.slice(0, 5);
  const pick = (values: Array<number | null>): number[] =>
    values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const alerts = config.alerts;
  return [
    {
      key: "cpu",
      label: "CPU usage",
      threshold: alerts.cpuPercent,
      values: pick(used.map((row) => row.cpu_percent)),
      breach: (value, threshold) => value >= threshold,
      recovered: (value, threshold) => value < threshold - 5,
      format: formatPercent,
      hint: "Check what else is running on the machine; a stuck ffmpeg or whisper process is the usual cause.",
    },
    {
      key: "memory",
      label: "Memory usage",
      threshold: alerts.memPercent,
      values: pick(used.map(memoryPercent)),
      breach: (value, threshold) => value >= threshold,
      recovered: (value, threshold) => value < threshold - 5,
      format: formatPercent,
      hint: "Check for a leaked whisper process; restarting TranscriptWorker releases the worker's own memory.",
    },
    {
      key: "disk",
      label: "Free disk",
      threshold: alerts.diskFreePercent,
      values: pick(used.map(freePercent)),
      breach: (value, threshold) => value <= threshold,
      recovered: (value, threshold) => value > threshold + 5,
      format: formatPercent,
      hint: "Free space on the worker's temp volume. The worker refuses new jobs below MIN_FREE_DISK_GB.",
    },
    {
      key: "cpu_temp",
      label: "CPU temperature",
      threshold: alerts.cpuTempC,
      values: pick(used.map((row) => row.cpu_temp_c)),
      breach: (value, threshold) => value >= threshold,
      recovered: (value, threshold) => value < threshold - 5,
      format: formatTemperature,
      hint: "Check fans and airflow. CPU temperature needs LibreHardwareMonitor (or ACPI) on the worker.",
    },
    {
      key: "gpu_temp",
      label: "GPU temperature",
      threshold: alerts.gpuTempC,
      values: pick(used.map((row) => row.gpu_temp_c)),
      breach: (value, threshold) => value >= threshold,
      recovered: (value, threshold) => value < threshold - 5,
      format: formatTemperature,
      hint: "Check the RX 6800 fans and case airflow; stop the worker if the temperature keeps climbing.",
    },
  ];
}

export async function evaluateWorkerAlerts(env: Env, db: Db, now = Date.now()): Promise<string[]> {
  const workers = await db.all<WorkerRow>("SELECT * FROM workers WHERE disabled = 0");
  const online = workers.filter(
    (worker) => worker.last_heartbeat_at && now - Date.parse(worker.last_heartbeat_at) < 3 * 60 * 1000,
  );
  if (online.length === 0) return [];

  const since = new Date(now - ALERT_WINDOW_MS).toISOString();
  const rows = await db.all<MetricsRow>(
    `SELECT * FROM worker_metrics
     WHERE sampled_at >= ?
     ORDER BY worker_id, sampled_at DESC`,
    [since],
  );
  if (rows.length === 0) return [];

  const byWorker = new Map<string, MetricsRow[]>();
  for (const row of rows) {
    const list = byWorker.get(row.worker_id);
    if (list) list.push(row);
    else byWorker.set(row.worker_id, [row]);
  }

  const stateRows = await db.all<AlertStateRow>("SELECT * FROM worker_alert_state");
  const states = new Map(stateRows.map((row) => [`${row.worker_id}:${row.metric}`, row]));
  const fired: string[] = [];

  for (const worker of online) {
    const samples = byWorker.get(worker.id);
    if (!samples || samples.length < WARN_AFTER_SAMPLES) continue;
    if (now - Date.parse(samples[0].sampled_at) > 5 * 60 * 1000) continue;

    const config = workerConfigFor(worker);
    if (!config.alerts.enabled) continue;

    for (const check of checksFor(samples, config)) {
      if (check.values.length < WARN_AFTER_SAMPLES) continue;
      const latest = check.values[0];
      const state = states.get(`${worker.id}:${check.key}`);
      const breached = check.values.slice(0, WARN_AFTER_SAMPLES).every((value) => check.breach(value, check.threshold));
      const recovered =
        check.values.length >= RECOVER_AFTER_SAMPLES &&
        check.values.slice(0, RECOVER_AFTER_SAMPLES).every((value) => check.recovered(value, check.threshold));

      if (breached && state?.severity !== "warn") {
        const sinceAt = nowIso();
        await upsertState(db, worker.id, check.key, "warn", latest, check.threshold, sinceAt, sinceAt);
        states.set(`${worker.id}:${check.key}`, {
          worker_id: worker.id,
          metric: check.key,
          severity: "warn",
          value: latest,
          threshold: check.threshold,
          since: sinceAt,
          updated_at: sinceAt,
        });
        await notify(env, db, worker, check, latest, "warning");
        fired.push(`worker_${worker.name}_${check.key}`);
        continue;
      }

      if (state?.severity === "warn" && recovered) {
        const sinceAt = nowIso();
        await upsertState(db, worker.id, check.key, "ok", latest, check.threshold, sinceAt, sinceAt);
        states.set(`${worker.id}:${check.key}`, {
          worker_id: worker.id,
          metric: check.key,
          severity: "ok",
          value: latest,
          threshold: check.threshold,
          since: sinceAt,
          updated_at: sinceAt,
        });
        await notify(env, db, worker, check, latest, "recovery");
        fired.push(`worker_${worker.name}_${check.key}_recovered`);
        continue;
      }

      if (state?.severity === "warn") {
        // Keep the displayed value fresh without moving `since` or emailing again.
        await db.run(
          "UPDATE worker_alert_state SET value = ?, threshold = ?, updated_at = ? WHERE worker_id = ? AND metric = ?",
          [latest, check.threshold, nowIso(), worker.id, check.key],
        );
      }
    }
  }
  return fired;
}

async function upsertState(
  db: Db,
  workerId: string,
  metric: string,
  severity: "ok" | "warn",
  value: number,
  threshold: number,
  since: string,
  updatedAt: string,
): Promise<void> {
  await db.run(
    `INSERT INTO worker_alert_state (worker_id, metric, severity, value, threshold, since, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(worker_id, metric) DO UPDATE SET
       severity = excluded.severity,
       value = excluded.value,
       threshold = excluded.threshold,
       since = excluded.since,
       updated_at = excluded.updated_at`,
    [workerId, metric, severity, value, threshold, since, updatedAt],
  );
}

async function notify(
  env: Env,
  db: Db,
  worker: WorkerRow,
  check: Check,
  value: number,
  severity: "warning" | "recovery",
): Promise<void> {
  const threshold = check.format(check.threshold);
  const formatted = check.format(value);
  const recovered = severity === "recovery";
  // The link only opens Admin → Workers; a signed-in admin still confirms the disable there.
  const workerPath = `/admin/workers/?worker=${encodeURIComponent(worker.id)}`;
  await alertOperators(env, db, {
    kind: recovered ? `worker_${check.key}_recovered` : `worker_${check.key}`,
    summary: recovered
      ? `${worker.name}: ${check.label} recovered (${formatted}, threshold ${threshold}).`
      : `${worker.name}: ${check.label} ${formatted} (threshold ${threshold}).`,
    detail: { worker: worker.name, metric: check.key, value: formatted, threshold },
    template: "worker_alert",
    emailData: {
      worker: worker.name,
      metric: check.label.toLowerCase(),
      value: formatted,
      threshold,
      severity: recovered ? "recovered" : "warning",
      hint: recovered ? "The value is back under the threshold. No action is needed." : check.hint,
      url: operatorUrl(env, recovered ? workerPath : `${workerPath}&action=disable`),
      action: recovered ? "Open worker in Admin" : "Stop this worker taking jobs",
    },
    throttle: { limit: 3, windowSeconds: 3600 },
  });
}
