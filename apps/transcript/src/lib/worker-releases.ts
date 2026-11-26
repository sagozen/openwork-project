import { type Db, id, nowIso } from "@templatedesign/platform/db";
import { presignConfigured, presignR2 } from "./r2-presign";
import type { Env } from "./types";

/**
 * Worker release channel. Binaries live under the existing outputs bucket at
 * `releases/worker/<platform>/<arch>/<version>/…`; the admin publishes metadata after a direct
 * presigned PUT, and every worker heartbeat mints a short-lived signed GET for the newest release.
 */
export interface WorkerReleaseRow {
  id: string;
  version: string;
  platform: string;
  arch: string;
  object_key: string;
  sha256: string;
  size_bytes: number;
  notes: string | null;
  active: number;
  created_by: string | null;
  created_at: string;
}

export interface WorkerUpdate {
  version: string;
  url: string;
  sha256: string;
  sizeBytes: number;
  notes?: string;
  mandatory?: boolean;
}

export const RELEASE_PREFIX = "releases/worker/";
const MAX_RELEASE_BYTES = 200 * 1024 * 1024;
const PLATFORMS = ["windows", "linux"] as const;
const ARCHES = ["amd64", "arm64"] as const;

export function validReleaseVersion(version: string): boolean {
  // Stable releases only: the worker's comparison ignores a pre-release suffix, so allowing
  // `1.9.0-beta` here would let a later `1.9.0` look "not newer".
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(version);
}

export function releaseKey(version: string, platform: string, arch: string): string {
  return `${RELEASE_PREFIX}${platform}/${arch}/${version}/transcriber-${platform}-${arch}.exe`;
}

export function validReleaseTarget(platform: string, arch: string): boolean {
  return (PLATFORMS as readonly string[]).includes(platform) && (ARCHES as readonly string[]).includes(arch);
}

export function maxReleaseBytes(): number {
  return MAX_RELEASE_BYTES;
}

export async function listWorkerReleases(db: Db, limit = 30): Promise<WorkerReleaseRow[]> {
  return db.all<WorkerReleaseRow>("SELECT * FROM worker_releases ORDER BY created_at DESC LIMIT ?", [
    Math.min(Math.max(limit, 1), 100),
  ]);
}

export async function latestWorkerRelease(db: Db, platform: string, arch: string): Promise<WorkerReleaseRow | null> {
  return db.first<WorkerReleaseRow>(
    `SELECT * FROM worker_releases
     WHERE active = 1 AND platform = ? AND arch = ?
     ORDER BY created_at DESC LIMIT 1`,
    [platform, arch],
  );
}

/** Returns the manifest only when the release is strictly newer than what the worker reports. */
export async function updateManifestFor(
  env: Env,
  db: Db,
  input: { platform: string; arch: string; currentVersion: string },
): Promise<WorkerUpdate | null> {
  if (!validReleaseTarget(input.platform, input.arch)) return null;
  if (!presignConfigured(env)) return null;
  const release = await latestWorkerRelease(db, input.platform, input.arch);
  if (!release) return null;
  if (compareVersions(input.currentVersion, release.version) >= 0) return null;
  const url = await presignR2(env, {
    bucket: "outputs",
    key: release.object_key,
    method: "GET",
    expiresIn: 3600,
  });
  return {
    version: release.version,
    url,
    sha256: release.sha256,
    sizeBytes: release.size_bytes,
    notes: release.notes ?? undefined,
  };
}

export async function createWorkerRelease(
  db: Db,
  input: {
    version: string;
    platform: string;
    arch: string;
    objectKey: string;
    sha256: string;
    sizeBytes: number;
    notes?: string;
    actorId: string;
  },
): Promise<WorkerReleaseRow> {
  const row: WorkerReleaseRow = {
    id: id("wrel"),
    version: input.version,
    platform: input.platform,
    arch: input.arch,
    object_key: input.objectKey,
    sha256: input.sha256.toLowerCase(),
    size_bytes: input.sizeBytes,
    notes: input.notes?.trim().slice(0, 500) || null,
    active: 1,
    created_by: input.actorId,
    created_at: nowIso(),
  };
  await db.run(
    `INSERT INTO worker_releases
       (id, version, platform, arch, object_key, sha256, size_bytes, notes, active, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    [
      row.id,
      row.version,
      row.platform,
      row.arch,
      row.object_key,
      row.sha256,
      row.size_bytes,
      row.notes,
      row.created_by,
      row.created_at,
    ],
  );
  return row;
}

export async function setWorkerReleaseActive(db: Db, releaseId: string, active: boolean): Promise<boolean> {
  const result = await db.run("UPDATE worker_releases SET active = ? WHERE id = ?", [active ? 1 : 0, releaseId]);
  return result.changes === 1;
}

export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (a === null && b === null) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const x = a[index] ?? 0;
    const y = b[index] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function parseVersion(value: string): number[] | null {
  if (!value) return null;
  const trimmed = value.trim().replace(/^v/, "").split(/[-+]/, 1)[0] ?? "";
  const parts = trimmed.split(".");
  if (parts.length < 2 || parts.length > 4) return null;
  const numbers: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    numbers.push(Number(part));
  }
  return numbers;
}
