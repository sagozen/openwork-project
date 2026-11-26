import type { Db } from "@templatedesign/platform/db";
import { type Storage, StorageError } from "./storage/s3";

export interface Health {
  status: "ok" | "degraded";
  db: "ok" | "down";
  /** "ok" when the object store answered a signed request, "down" when it could not be reached or refused our key. */
  storage: "ok" | "down";
}

/** A key that never exists: asking for it proves the endpoint, the bucket and the credentials work without reading anything. */
export const HEALTH_PROBE_KEY = "ma/.health-probe";
/** The health route is public, so the storage answer is reused for this long instead of calling out on every hit. */
const CACHE_MS = 30_000;

let lastStorage: { at: number; value: Health["storage"] } | null = null;

/** Forgets the cached storage answer. Only tests need this. */
export function resetHealthCache(): void {
  lastStorage = null;
}

async function probeStorage(storage: Storage): Promise<Health["storage"]> {
  try {
    await storage.headObject(HEALTH_PROBE_KEY);
    return "ok";
  } catch (error) {
    // Not found is the expected answer: the store replied, so it is reachable and our key is accepted.
    return error instanceof StorageError && error.code === "NOT_FOUND" ? "ok" : "down";
  }
}

export async function checkHealth(db: Db, getStorage: () => Storage, nowMs: number = Date.now()): Promise<Health> {
  const dbState = await db.first("SELECT 1 AS ok").then(
    () => "ok" as const,
    () => "down" as const,
  );
  let storageState: Health["storage"];
  if (lastStorage && nowMs - lastStorage.at < CACHE_MS) {
    storageState = lastStorage.value;
  } else {
    try {
      storageState = await probeStorage(getStorage());
    } catch {
      // The store is not configured (missing secret).
      storageState = "down";
    }
    lastStorage = { at: nowMs, value: storageState };
  }
  return { status: dbState === "ok" && storageState === "ok" ? "ok" : "degraded", db: dbState, storage: storageState };
}
