import type { Db } from "@templatedesign/platform/db";
import { id, nowIso } from "@templatedesign/platform/db";

/**
 * The worker registry. A worker is an agent (for example one running in OpenClaw) that pulls image jobs
 * over outbound HTTPS with its own bearer token. The Worker never calls it, so the machine needs no
 * inbound port. Only a hash of the token is stored.
 */

/** A worker whose last heartbeat is older than this is treated as offline. */
export const WORKER_FRESH_SECONDS = 60;
/** How long a lease lasts without an extension. The worker extends well before it runs out. */
export const LEASE_SECONDS = 180;
/** Lease attempts on the worker lane before the job moves to the fallback provider. */
export const MAX_WORKER_ATTEMPTS = 2;
/** How long a job may wait for a worker before the fallback provider takes it. */
export const DEFAULT_WORKER_WAIT_SECONDS = 45;
export const MAX_WORKER_WAIT_SECONDS = 600;
/** Largest output a worker is assumed to handle when it does not say otherwise. */
const DEFAULT_MAX_MEGAPIXELS = 4;

export type JobKind = "generate" | "edit";

export interface WorkerCapabilities {
  kinds?: JobKind[];
  maxMegapixels?: number;
  /** Job slots the worker holds at once. */
  concurrency?: number;
  /** Free text shown in admin, for example "openclaw 2026.6". */
  engine?: string;
}

export interface WorkerRow {
  id: string;
  name: string;
  token_hash: string;
  previous_token_hash: string | null;
  previous_token_expires_at: string | null;
  capabilities_json: string;
  last_heartbeat_at: string | null;
  version: string | null;
  disabled: number;
  created_at: string;
  updated_at: string;
}

export interface WorkerView {
  id: string;
  name: string;
  version: string | null;
  capabilities: WorkerCapabilities;
  lastHeartbeatAt: string | null;
  disabled: boolean;
  online: boolean;
}

function parseCapabilities(json: string): WorkerCapabilities {
  try {
    const raw = JSON.parse(json) as Record<string, unknown>;
    const kinds = Array.isArray(raw.kinds)
      ? (raw.kinds.filter((kind) => kind === "generate" || kind === "edit") as JobKind[])
      : undefined;
    const max = Number(raw.maxMegapixels);
    const slots = Number(raw.concurrency);
    return {
      kinds: kinds && kinds.length > 0 ? kinds : undefined,
      maxMegapixels: Number.isFinite(max) && max > 0 ? Math.min(max, 16) : undefined,
      concurrency: Number.isFinite(slots) && slots >= 1 ? Math.min(Math.floor(slots), 8) : undefined,
      engine: typeof raw.engine === "string" ? raw.engine.slice(0, 80) : undefined,
    };
  } catch {
    return {};
  }
}

export function isFresh(lastHeartbeatAt: string | null, now = Date.now()): boolean {
  return lastHeartbeatAt !== null && now - Date.parse(lastHeartbeatAt) < WORKER_FRESH_SECONDS * 1000;
}

export function mapWorker(row: WorkerRow, now = Date.now()): WorkerView {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    capabilities: parseCapabilities(row.capabilities_json),
    lastHeartbeatAt: row.last_heartbeat_at,
    disabled: row.disabled === 1,
    online: row.disabled === 0 && isFresh(row.last_heartbeat_at, now),
  };
}

/* ---------------------------------------------------------------- tokens */

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
  // Rotation overlap: the previous token keeps working until its recorded expiry, so rotating does not
  // drop a running job or a machine that is about to restart.
  return db.first<WorkerRow>(
    "SELECT * FROM workers WHERE previous_token_hash = ? AND disabled = 0 AND previous_token_expires_at > ?",
    [hash, nowIso()],
  );
}

export async function registerWorker(db: Db, name: string): Promise<{ worker: WorkerRow; token: string }> {
  const token = generateWorkerToken();
  const timestamp = nowIso();
  const worker: WorkerRow = {
    id: id("wkr"),
    name: name.trim().slice(0, 80) || "worker",
    token_hash: await hashWorkerToken(token),
    previous_token_hash: null,
    previous_token_expires_at: null,
    capabilities_json: "{}",
    last_heartbeat_at: null,
    version: null,
    disabled: 0,
    created_at: timestamp,
    updated_at: timestamp,
  };
  await db.run(
    `INSERT INTO workers (id, name, token_hash, capabilities_json, disabled, created_at, updated_at)
     VALUES (?, ?, ?, '{}', 0, ?, ?)`,
    [worker.id, worker.name, worker.token_hash, timestamp, timestamp],
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

export async function setWorkerDisabled(db: Db, workerId: string, disabled: boolean): Promise<boolean> {
  const result = await db.run("UPDATE workers SET disabled = ?, updated_at = ? WHERE id = ?", [
    disabled ? 1 : 0,
    nowIso(),
    workerId,
  ]);
  return result.changes === 1;
}

export async function listWorkers(db: Db): Promise<WorkerView[]> {
  const rows = await db.all<WorkerRow>("SELECT * FROM workers ORDER BY created_at");
  return rows.map((row) => mapWorker(row));
}

export interface HeartbeatInput {
  version?: string;
  capabilities?: unknown;
}

export async function recordHeartbeat(db: Db, worker: WorkerRow, input: HeartbeatInput): Promise<void> {
  const capabilities =
    input.capabilities && typeof input.capabilities === "object"
      ? parseCapabilities(JSON.stringify(input.capabilities))
      : parseCapabilities(worker.capabilities_json);
  const timestamp = nowIso();
  await db.run(
    "UPDATE workers SET last_heartbeat_at = ?, version = ?, capabilities_json = ?, updated_at = ? WHERE id = ?",
    [
      timestamp,
      typeof input.version === "string" ? input.version.slice(0, 60) : worker.version,
      JSON.stringify(capabilities),
      timestamp,
      worker.id,
    ],
  );
}

/* ---------------------------------------------------------- availability */

export function workerCanTake(worker: Pick<WorkerRow, "capabilities_json">, kind: JobKind, megapixels: number) {
  const capabilities = parseCapabilities(worker.capabilities_json);
  if (capabilities.kinds && !capabilities.kinds.includes(kind)) return false;
  return megapixels <= (capabilities.maxMegapixels ?? DEFAULT_MAX_MEGAPIXELS);
}

/** Whether a worker that can take this job has sent a heartbeat recently. Decides the lane for new jobs. */
export async function hasFreshWorker(db: Db, kind: JobKind, megapixels: number, now = Date.now()): Promise<boolean> {
  const rows = await db.all<WorkerRow>(
    "SELECT * FROM workers WHERE disabled = 0 AND last_heartbeat_at IS NOT NULL AND last_heartbeat_at > ?",
    [new Date(now - WORKER_FRESH_SECONDS * 1000).toISOString()],
  );
  return rows.some((row) => workerCanTake(row, kind, megapixels));
}

export function slotLimit(worker: Pick<WorkerRow, "capabilities_json">): number {
  return parseCapabilities(worker.capabilities_json).concurrency ?? 1;
}
