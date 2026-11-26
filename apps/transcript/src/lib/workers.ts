import { getAdminSettingValue } from "@templatedesign/platform/admin";
import type { Db } from "@templatedesign/platform/db";
import { id, nowIso } from "@templatedesign/platform/db";
import { parseJson } from "./jobs";
import { fallbackAfterSeconds, PRICING } from "./pricing";

export type WorkerTier = "primary" | "fallback";

export interface WorkerCapabilities {
  models?: string[];
  maxAudioSeconds?: number;
  canDownloadYoutube?: boolean;
  canDownloadTiktok?: boolean;
  concurrency?: number;
  diskFreeBytes?: number;
  engine?: string;
  platform?: string;
  arch?: string;
}

export interface WorkerRow {
  id: string;
  name: string;
  tier: WorkerTier;
  token_hash: string;
  previous_token_hash: string | null;
  previous_token_expires_at: string | null;
  capabilities_json: string;
  last_heartbeat_at: string | null;
  version: string | null;
  disabled: number;
  config_json: string;
  config_version: number;
  applied_config_version: number;
  metrics_json: string | null;
  update_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkerView {
  id: string;
  name: string;
  tier: WorkerTier;
  version: string | null;
  capabilities: WorkerCapabilities;
  lastHeartbeatAt: string | null;
  disabled: boolean;
  online: boolean;
  config: WorkerConfig;
  configVersion: number;
  appliedConfigVersion: number;
  metrics: WorkerMetrics | null;
  update: WorkerUpdateState | null;
}

export function mapWorker(row: WorkerRow): WorkerView {
  return {
    id: row.id,
    name: row.name,
    tier: row.tier,
    version: row.version,
    capabilities: parseJson<WorkerCapabilities>(row.capabilities_json, {}),
    lastHeartbeatAt: row.last_heartbeat_at,
    disabled: row.disabled === 1,
    online: row.last_heartbeat_at
      ? Date.now() - Date.parse(row.last_heartbeat_at) < PRICING.primaryFreshSeconds * 1000
      : false,
    config: workerConfigFor(row),
    configVersion: row.config_version ?? 0,
    appliedConfigVersion: row.applied_config_version ?? 0,
    metrics: parseJson<WorkerMetrics | null>(row.metrics_json ?? "null", null),
    update: parseJson<WorkerUpdateState | null>(row.update_json ?? "null", null),
  };
}

const TOKEN_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export function generateWorkerToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `wkr_${[...bytes].map((byte) => TOKEN_ALPHABET[byte % TOKEN_ALPHABET.length]).join("")}`;
}

export async function hashWorkerToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function authenticateWorker(db: Db, request: Request): Promise<WorkerRow | null> {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token.startsWith("wkr_")) return null;
  const hash = await hashWorkerToken(token);
  const current = await db.first<WorkerRow>("SELECT * FROM workers WHERE token_hash = ? AND disabled = 0", [hash]);
  if (current) return current;
  // Rotation overlap: the previous token keeps working until its recorded expiry, so rotating
  // does not drop a running job or a machine that is about to restart.
  return db.first<WorkerRow>(
    "SELECT * FROM workers WHERE previous_token_hash = ? AND disabled = 0 AND previous_token_expires_at > ?",
    [hash, nowIso()],
  );
}

export async function registerWorker(
  db: Db,
  input: { name: string; tier: WorkerTier },
): Promise<{ worker: WorkerRow; token: string }> {
  const token = generateWorkerToken();
  const timestamp = nowIso();
  const worker: WorkerRow = {
    id: id("wkr"),
    name: input.name.slice(0, 80) || "worker",
    tier: input.tier,
    token_hash: await hashWorkerToken(token),
    previous_token_hash: null,
    previous_token_expires_at: null,
    capabilities_json: "{}",
    last_heartbeat_at: null,
    version: null,
    disabled: 0,
    config_json: "{}",
    config_version: 0,
    applied_config_version: 0,
    metrics_json: null,
    update_json: null,
    created_at: timestamp,
    updated_at: timestamp,
  };
  await db.run(
    `INSERT INTO workers (id, name, tier, token_hash, capabilities_json, last_heartbeat_at, version, disabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, '{}', NULL, NULL, 0, ?, ?)`,
    [worker.id, worker.name, worker.tier, worker.token_hash, timestamp, timestamp],
  );
  return { worker, token };
}

export async function rotateWorkerToken(db: Db, workerId: string, overlapHours = 24): Promise<string | null> {
  const token = generateWorkerToken();
  const expiry = new Date(Date.now() + overlapHours * 60 * 60 * 1000).toISOString();
  const result = await db.run(
    `UPDATE workers SET previous_token_hash = token_hash, previous_token_expires_at = ?,
       token_hash = ?, updated_at = ? WHERE id = ?`,
    [expiry, await hashWorkerToken(token), nowIso(), workerId],
  );
  return result.changes === 1 ? token : null;
}

export async function setWorkerDisabled(db: Db, workerId: string, disabled: boolean): Promise<void> {
  await db.run("UPDATE workers SET disabled = ?, updated_at = ? WHERE id = ?", [disabled ? 1 : 0, nowIso(), workerId]);
}

export interface WorkerHeartbeatInput {
  version?: string;
  capabilities?: WorkerCapabilities;
  configVersion?: number;
  metrics?: WorkerMetrics | null;
  update?: WorkerUpdateState | null;
  activeJobs?: number;
}

export async function heartbeat(db: Db, worker: WorkerRow, input: WorkerHeartbeatInput): Promise<void> {
  const timestamp = nowIso();
  const metrics = normalizeWorkerMetrics(input.metrics);
  if (metrics && typeof input.activeJobs === "number") metrics.activeJobs = clampInt(input.activeJobs, 0, 64);
  const applied = clampInt(input.configVersion ?? worker.applied_config_version ?? 0, 0, 1_000_000);
  const updateState = normalizeWorkerUpdate(input.update);
  await db.run(
    `UPDATE workers SET last_heartbeat_at = ?, version = ?, capabilities_json = ?, applied_config_version = ?,
       metrics_json = ?, update_json = ?, updated_at = ? WHERE id = ?`,
    [
      timestamp,
      input.version?.slice(0, 60) ?? worker.version,
      JSON.stringify(input.capabilities ?? parseJson<WorkerCapabilities>(worker.capabilities_json, {})),
      applied,
      metrics ? JSON.stringify(metrics) : (worker.metrics_json ?? null),
      updateState ? JSON.stringify(updateState) : (worker.update_json ?? null),
      timestamp,
      worker.id,
    ],
  );
  if (metrics) await recordWorkerMetrics(db, worker.id, metrics);
}

/* ------------------------------------------------------------- routing */

export interface LeaseCandidate {
  id: string;
  stage: string;
  free: number;
  queued_at: string;
  source_kind: string;
  duration_seconds: number | null;
  /** The token this lease was granted with; required by extend/complete/fail. */
  lease_token?: string;
}

export function primaryIsFresh(lastHeartbeatAt: string | null, now = Date.now()): boolean {
  if (!lastHeartbeatAt) return false;
  return now - Date.parse(lastHeartbeatAt) < PRICING.primaryFreshSeconds * 1000;
}

/**
 * Home first, VPS fallback (phase 3). Split out from the query so the rule is testable:
 * a fallback worker may take
 * - a `probe` stage job (cheap, keeps the link preview under a second), or
 * - anything when no primary has sent a heartbeat for 60 s, or
 * - a job that has waited longer than `fallback_after_seconds` (GPU backlog).
 */
export function fallbackMayTake(
  job: LeaseCandidate,
  context: { primaryFresh: boolean; fallbackAfterSeconds: number; now?: number },
): boolean {
  if (job.stage === "probe") return true;
  if (!context.primaryFresh) return true;
  const now = context.now ?? Date.now();
  return now - Date.parse(job.queued_at) > context.fallbackAfterSeconds * 1000;
}

/** Long jobs wait for the GPU: a worker never takes media above its advertised maximum. */
export function workerCanTake(job: LeaseCandidate, worker: WorkerRow): boolean {
  const capabilities = parseJson<WorkerCapabilities>(worker.capabilities_json, {});
  const max = capabilities.maxAudioSeconds;
  if (job.stage === "probe") return true;
  if (typeof max === "number" && max > 0 && job.duration_seconds !== null && job.duration_seconds > max) return false;
  if (job.source_kind === "youtube" && capabilities.canDownloadYoutube === false) return false;
  if (job.source_kind === "tiktok" && capabilities.canDownloadTiktok === false) return false;
  return true;
}

export interface LeaseOptions {
  /** How long to hold the request open, in seconds. 0 = one shot. */
  waitSeconds?: number;
  /** Injected in tests so the long-poll does not actually sleep. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function leaseJob(db: Db, worker: WorkerRow, options: LeaseOptions = {}): Promise<LeaseCandidate | null> {
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const deadline = now() + Math.max(0, options.waitSeconds ?? 20) * 1000;
  const fallbackAfter = await fallbackAfterSeconds(db);
  const starvation = await freeStarvationSeconds(db);
  // D1 counts every query: the first second stays fast for the link preview, after that the poll
  // backs off, and the primary heartbeat is re-read at most every 5 s instead of on every pass.
  let delay = 900;
  let primaryFresh: boolean | null = null;
  let primaryCheckedAt = 0;
  const heartbeatCacheMs = 5000;
  while (true) {
    if (primaryFresh === null || now() - primaryCheckedAt >= heartbeatCacheMs) {
      primaryFresh = await readPrimaryFresh(db, now);
      primaryCheckedAt = now();
    }
    const candidate = await tryLease(db, worker, { fallbackAfter, starvation, now, primaryFresh });
    if (candidate) return candidate;
    if (now() >= deadline) return null;
    await sleep(delay);
    delay = Math.min(2500, delay + 300);
  }
}

async function readPrimaryFresh(db: Db, now: () => number): Promise<boolean> {
  const primary = await db.first<{ last_heartbeat_at: string | null }>(
    "SELECT MAX(last_heartbeat_at) AS last_heartbeat_at FROM workers WHERE tier = 'primary' AND disabled = 0",
  );
  return primaryIsFresh(primary?.last_heartbeat_at ?? null, now());
}

/**
 * The worker's slot budget, enforced server-side too: a worker that advertises concurrency 1 can
 * never hold two leases, even if its loop misbehaves. `concurrency` defaults to 1.
 */
export async function workerSlotsFree(db: Db, worker: WorkerRow): Promise<boolean> {
  const capabilities = parseJson<WorkerCapabilities>(worker.capabilities_json, {});
  const limit = Math.max(1, capabilities.concurrency ?? 1);
  const held = await db.first<{ count: number }>(
    "SELECT COUNT(*) AS count FROM transcription_jobs WHERE status = 'leased' AND leased_by = ? AND lease_expires_at > ?",
    [worker.id, nowIso()],
  );
  return (held?.count ?? 0) < limit;
}

export async function tryLease(
  db: Db,
  worker: WorkerRow,
  context: {
    fallbackAfter: number;
    /** A free job older than this jumps ahead of paid work. */
    starvation?: number;
    now: () => number;
    /** Cached by `leaseJob`; read here when omitted (tests, one-shot calls). */
    primaryFresh?: boolean;
  },
): Promise<LeaseCandidate | null> {
  const primaryFresh = context.primaryFresh ?? (await readPrimaryFresh(db, context.now));
  if (!(await workerSlotsFree(db, worker))) return null;

  const starvationCutoff = new Date(
    context.now() - (context.starvation ?? PRICING.freeStarvationSeconds) * 1000,
  ).toISOString();
  const rows = await db.all<LeaseCandidate>(
    `SELECT id, stage, free, queued_at, source_kind, duration_seconds FROM transcription_jobs
     WHERE status = 'queued'
     ORDER BY
       CASE WHEN free = 1 AND queued_at <= ? THEN 0 ELSE 1 END ASC,
       free ASC,
       queued_at ASC
     LIMIT 20`,
    [starvationCutoff],
  );

  for (const row of rows) {
    if (!workerCanTake(row, worker)) continue;
    if (
      worker.tier === "fallback" &&
      !fallbackMayTake(row, { primaryFresh, fallbackAfterSeconds: context.fallbackAfter })
    )
      continue;
    const leaseToken = generateLeaseToken();
    const expiresAt = new Date(context.now() + PRICING.leaseSeconds * 1000).toISOString();
    const claimed = await db.run(
      `UPDATE transcription_jobs SET status = 'leased', leased_by = ?, lease_token = ?, lease_expires_at = ?,
         started_at = COALESCE(started_at, ?), updated_at = ?
       WHERE id = ? AND status = 'queued'`,
      [worker.id, leaseToken, expiresAt, nowIso(), nowIso(), row.id],
    );
    if (claimed.changes === 1) return { ...row, lease_token: leaseToken };
  }
  return null;
}

export function generateLeaseToken(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `lst_${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function freeStarvationSeconds(db: Db): Promise<number> {
  const value = await getAdminSettingValue<number>(db, "transcript.free_starvation_seconds");
  return typeof value === "number" ? value : PRICING.freeStarvationSeconds;
}

export async function workerHealth(db: Db): Promise<{
  primaryFresh: boolean;
  anyOnline: boolean;
  lastPrimaryAt: string | null;
  lastAnyAt: string | null;
  queueAgeSeconds: number | null;
}> {
  const primary = await db.first<{ last_heartbeat_at: string | null }>(
    "SELECT MAX(last_heartbeat_at) AS last_heartbeat_at FROM workers WHERE tier = 'primary' AND disabled = 0",
  );
  const any = await db.first<{ last_heartbeat_at: string | null }>(
    "SELECT MAX(last_heartbeat_at) AS last_heartbeat_at FROM workers WHERE disabled = 0",
  );
  const oldest = await db.first<{ queued_at: string }>(
    "SELECT queued_at FROM transcription_jobs WHERE status = 'queued' ORDER BY queued_at LIMIT 1",
  );
  return {
    primaryFresh: primaryIsFresh(primary?.last_heartbeat_at ?? null),
    anyOnline: primaryIsFresh(any?.last_heartbeat_at ?? null),
    lastPrimaryAt: primary?.last_heartbeat_at ?? null,
    lastAnyAt: any?.last_heartbeat_at ?? null,
    queueAgeSeconds: oldest ? Math.max(0, (Date.now() - Date.parse(oldest.queued_at)) / 1000) : null,
  };
}

/* ------------------------------------------------------- remote config */

export interface WorkerAlertsConfig {
  enabled: boolean;
  cpuPercent: number;
  memPercent: number;
  diskFreePercent: number;
  cpuTempC: number;
  gpuTempC: number;
}

export interface WorkerConfig {
  tier: WorkerTier;
  concurrency: number;
  maxAudioSeconds: number;
  canDownloadYoutube: boolean;
  canDownloadTiktok: boolean;
  minFreeDiskGb: number;
  autoUpdate: boolean;
  alerts: WorkerAlertsConfig;
}

export const DEFAULT_WORKER_CONFIG: WorkerConfig = {
  tier: "primary",
  concurrency: 1,
  maxAudioSeconds: 10800,
  canDownloadYoutube: true,
  canDownloadTiktok: true,
  minFreeDiskGb: 5,
  autoUpdate: true,
  alerts: {
    enabled: true,
    cpuPercent: 95,
    memPercent: 92,
    diskFreePercent: 10,
    cpuTempC: 90,
    gpuTempC: 90,
  },
};

function clampInt(value: unknown, min: number, max: number, fallback = min): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.round(number), min), max);
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(number, min), max);
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** Validates a full or partial config against the worker's current values. */
export function normalizeWorkerConfig(input: unknown, base: WorkerConfig): WorkerConfig {
  const source = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const alertsSource =
    source.alerts && typeof source.alerts === "object" ? (source.alerts as Record<string, unknown>) : {};
  return {
    tier: source.tier === "fallback" ? "fallback" : source.tier === "primary" ? "primary" : base.tier,
    concurrency: clampInt(source.concurrency, 1, 8, base.concurrency),
    maxAudioSeconds: clampInt(source.maxAudioSeconds, 60, 43200, base.maxAudioSeconds),
    canDownloadYoutube: boolOr(source.canDownloadYoutube, base.canDownloadYoutube),
    canDownloadTiktok: boolOr(source.canDownloadTiktok, base.canDownloadTiktok),
    minFreeDiskGb: clampNumber(source.minFreeDiskGb, 1, 200, base.minFreeDiskGb),
    autoUpdate: boolOr(source.autoUpdate, base.autoUpdate),
    alerts: {
      enabled: boolOr(alertsSource.enabled, base.alerts.enabled),
      cpuPercent: clampNumber(alertsSource.cpuPercent, 50, 100, base.alerts.cpuPercent),
      memPercent: clampNumber(alertsSource.memPercent, 50, 100, base.alerts.memPercent),
      diskFreePercent: clampNumber(alertsSource.diskFreePercent, 1, 90, base.alerts.diskFreePercent),
      cpuTempC: clampNumber(alertsSource.cpuTempC, 40, 110, base.alerts.cpuTempC),
      gpuTempC: clampNumber(alertsSource.gpuTempC, 40, 115, base.alerts.gpuTempC),
    },
  };
}

export function workerConfigFor(row: WorkerRow): WorkerConfig {
  const stored = parseJson<Partial<WorkerConfig>>(row.config_json || "{}", {});
  return normalizeWorkerConfig(stored, { ...DEFAULT_WORKER_CONFIG, tier: row.tier });
}

export async function updateWorkerConfig(
  db: Db,
  workerId: string,
  input: unknown,
): Promise<{ config: WorkerConfig; configVersion: number } | null> {
  const row = await db.first<WorkerRow>("SELECT * FROM workers WHERE id = ?", [workerId]);
  if (!row) return null;
  const config = normalizeWorkerConfig(input, workerConfigFor(row));
  const version = (row.config_version ?? 0) + 1;
  // The registry tier drives lease routing, so keep the column and the config in step.
  await db.run("UPDATE workers SET config_json = ?, config_version = ?, tier = ?, updated_at = ? WHERE id = ?", [
    JSON.stringify(config),
    version,
    config.tier,
    nowIso(),
    workerId,
  ]);
  return { config, configVersion: version };
}

/* ---------------------------------------------------------- metrics */

export interface WorkerMetrics {
  sampledAt?: string;
  cpuPercent?: number;
  cpuCount?: number;
  memUsedBytes?: number;
  memTotalBytes?: number;
  diskFreeBytes?: number;
  diskTotalBytes?: number;
  cpuTempC?: number;
  gpuTempC?: number;
  tempSource?: string;
  cpuName?: string;
  gpuName?: string;
  gpuUsagePercent?: number;
  uptimeSeconds?: number;
  activeJobs?: number;
}

function numberField(source: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  const value = source[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(Math.max(value, min), max);
}

function stringField(source: Record<string, unknown>, key: string, max = 120): string | undefined {
  const value = source[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

/** Rejects non-numeric or implausible sensor values instead of storing them for alerts. */
export function normalizeWorkerMetrics(input: unknown): WorkerMetrics | null {
  if (!input || typeof input !== "object") return null;
  const source = input as Record<string, unknown>;
  const metrics: WorkerMetrics = {};
  const cpu = numberField(source, "cpuPercent", 0, 100);
  const memUsed = numberField(source, "memUsedBytes", 0, 1e15);
  const memTotal = numberField(source, "memTotalBytes", 0, 1e15);
  const diskFree = numberField(source, "diskFreeBytes", 0, 1e15);
  const diskTotal = numberField(source, "diskTotalBytes", 0, 1e15);
  if (cpu !== undefined) metrics.cpuPercent = cpu;
  if (memTotal && memTotal > 0) {
    metrics.memTotalBytes = Math.round(memTotal);
    metrics.memUsedBytes = Math.round(Math.min(memUsed ?? 0, memTotal));
  }
  if (diskTotal && diskTotal > 0) {
    metrics.diskTotalBytes = Math.round(diskTotal);
    metrics.diskFreeBytes = Math.round(Math.min(diskFree ?? 0, diskTotal));
  }
  const cpuTemp = numberField(source, "cpuTempC", -20, 125);
  const gpuTemp = numberField(source, "gpuTempC", -20, 125);
  if (cpuTemp !== undefined) metrics.cpuTempC = cpuTemp;
  if (gpuTemp !== undefined) metrics.gpuTempC = gpuTemp;
  const gpuUsage = numberField(source, "gpuUsagePercent", 0, 100);
  if (gpuUsage !== undefined) metrics.gpuUsagePercent = gpuUsage;
  const uptime = numberField(source, "uptimeSeconds", 0, 1e10);
  if (uptime !== undefined) metrics.uptimeSeconds = Math.round(uptime);
  const activeJobs = numberField(source, "activeJobs", 0, 64);
  if (activeJobs !== undefined) metrics.activeJobs = Math.round(activeJobs);
  const cpuCount = numberField(source, "cpuCount", 1, 1024);
  if (cpuCount !== undefined) metrics.cpuCount = Math.round(cpuCount);
  metrics.tempSource = stringField(source, "tempSource", 40);
  metrics.cpuName = stringField(source, "cpuName");
  metrics.gpuName = stringField(source, "gpuName");
  const meaningful = [
    metrics.cpuPercent,
    metrics.memTotalBytes,
    metrics.diskTotalBytes,
    metrics.cpuTempC,
    metrics.gpuTempC,
  ].some((value) => typeof value === "number");
  return meaningful ? metrics : null;
}

/**
 * One row per worker per minute: upserting the current minute keeps D1 small while preserving a
 * useful history for the admin charts and the sustained-threshold alerts.
 */
export async function recordWorkerMetrics(
  db: Db,
  workerId: string,
  metrics: WorkerMetrics,
  now = Date.now(),
): Promise<void> {
  const bucket = new Date(Math.floor(now / 60000) * 60000).toISOString();
  await db.run(
    `INSERT INTO worker_metrics
       (worker_id, sampled_at, cpu_percent, mem_used_bytes, mem_total_bytes, disk_free_bytes,
        disk_total_bytes, cpu_temp_c, gpu_temp_c, gpu_usage_percent, active_jobs)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(worker_id, sampled_at) DO UPDATE SET
       cpu_percent = excluded.cpu_percent,
       mem_used_bytes = excluded.mem_used_bytes,
       mem_total_bytes = excluded.mem_total_bytes,
       disk_free_bytes = excluded.disk_free_bytes,
       disk_total_bytes = excluded.disk_total_bytes,
       cpu_temp_c = excluded.cpu_temp_c,
       gpu_temp_c = excluded.gpu_temp_c,
       gpu_usage_percent = excluded.gpu_usage_percent,
       active_jobs = excluded.active_jobs`,
    [
      workerId,
      bucket,
      metrics.cpuPercent ?? null,
      metrics.memUsedBytes ?? null,
      metrics.memTotalBytes ?? null,
      metrics.diskFreeBytes ?? null,
      metrics.diskTotalBytes ?? null,
      metrics.cpuTempC ?? null,
      metrics.gpuTempC ?? null,
      metrics.gpuUsagePercent ?? null,
      metrics.activeJobs ?? null,
    ],
  );
}

/* ---------------------------------------------------------- updater */

export interface WorkerUpdateState {
  state: "idle" | "downloading" | "staged" | "applying" | "failed" | "disabled";
  version?: string;
  error?: string;
  at?: string;
}

const UPDATE_STATES: WorkerUpdateState["state"][] = ["idle", "downloading", "staged", "applying", "failed", "disabled"];

export function normalizeWorkerUpdate(input: unknown): WorkerUpdateState | null {
  if (!input || typeof input !== "object") return null;
  const source = input as Record<string, unknown>;
  const state =
    typeof source.state === "string" && UPDATE_STATES.includes(source.state as WorkerUpdateState["state"])
      ? (source.state as WorkerUpdateState["state"])
      : "idle";
  return {
    state,
    version: typeof source.version === "string" ? source.version.slice(0, 40) : undefined,
    error: typeof source.error === "string" ? source.error.slice(0, 300) : undefined,
    at: typeof source.at === "string" ? source.at.slice(0, 40) : undefined,
  };
}
