import { createStorage, type Storage, StorageError } from "../../src/lib/storage/s3";
import "../../src/lib/platform";
import type { ArtifactDeps } from "../../src/lib/artifacts/service";
import { DEFAULT_SETTINGS, type UploadSettings } from "../../src/lib/artifacts/settings";
import type { Caller } from "../../src/lib/auth/caller";
import type { ShareDeps } from "../../src/lib/shares/service";
import { createTestDb } from "./db";

export const STORAGE_ORIGIN = "https://s3.test";
export const ORIGIN = "https://myartifacts.test";
export const SECRET = "share-cookie-secret-for-tests-0123456789";
export const START = new Date("2026-11-22T10:00:00.000Z");

export const A: Caller = {
  tenantId: "ten_a",
  userId: "usr_a",
  scopes: ["artifacts:read", "artifacts:write"],
  via: "oauth",
};
export const B: Caller = {
  tenantId: "ten_b",
  userId: "usr_b",
  scopes: ["artifacts:read", "artifacts:write"],
  via: "api_key",
};
export const READ_ONLY: Caller = { ...A, scopes: ["artifacts:read"] };
export const NO_SCOPE: Caller = { ...A, scopes: [] };

async function readAll(body: unknown): Promise<Uint8Array> {
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  return new Uint8Array(await new Response(body as ReadableStream).arrayBuffer());
}

/**
 * An in-memory object store that implements `Storage`. Presigned URLs come from the real signer, so
 * their query strings are exactly what the app would hand out; only the transport is replaced.
 */
export function fakeStorage() {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  const log = { puts: [] as string[], deletes: [] as string[] };
  const faults = { delete: false, put: false };
  const signer = createStorage({
    endpoint: STORAGE_ORIGIN,
    region: "usc1",
    bucket: "myartifact",
    accessKeyId: "AKTEST",
    secretAccessKey: "SKTEST",
    now: () => START,
  });
  const storage: Storage = {
    async headObject(key) {
      const found = objects.get(key);
      if (!found) throw new StorageError("NOT_FOUND", "Object not found.", 404);
      return { size: found.bytes.length, contentType: found.contentType, etag: '"e"', lastModified: null };
    },
    async putObject(key, body, options) {
      if (faults.put) throw new StorageError("PROVIDER_ERROR", "Object storage PUT failed (HTTP 500).", 500);
      const bytes = await readAll(body);
      if (options.contentLength !== undefined && options.contentLength !== bytes.length) {
        throw new StorageError("PROVIDER_ERROR", "Body length differs from Content-Length.");
      }
      objects.set(key, { bytes, contentType: options.contentType });
      log.puts.push(key);
    },
    async getObject(key, options) {
      const found = objects.get(key);
      if (!found) throw new StorageError("NOT_FOUND", "Object not found.", 404);
      const bytes = options?.range ? found.bytes.slice(options.range.start, options.range.end + 1) : found.bytes;
      return {
        body: new Blob([bytes as BlobPart]).stream(),
        contentType: found.contentType,
        contentLength: bytes.length,
      };
    },
    async deleteObject(key) {
      if (faults.delete) throw new StorageError("PROVIDER_ERROR", "Object storage DELETE failed (HTTP 500).", 500);
      objects.delete(key);
      log.deletes.push(key);
    },
    presignPut: signer.presignPut,
    presignGet: signer.presignGet,
  };
  return { storage, objects, log, faults };
}

export type FakeStorage = ReturnType<typeof fakeStorage>;

/** A clock the test can move. */
export function clock(start: Date = START) {
  let current = start.getTime();
  return {
    now: () => new Date(current),
    advance: (ms: number) => {
      current += ms;
    },
  };
}

export async function setupArtifacts(options: { settings?: Partial<UploadSettings> } = {}) {
  const database = createTestDb();
  for (const id of ["ten_a", "ten_b"]) {
    await database.db.run("INSERT INTO tenants (id, name, created_at) VALUES (?, ?, '2026-01-01T00:00:00Z')", [id, id]);
  }
  const store = fakeStorage();
  const time = clock();
  const deps: ArtifactDeps = {
    db: database.db,
    storage: store.storage,
    settings: { ...DEFAULT_SETTINGS, ...options.settings },
    resolveHost: async () => ["93.184.216.34"],
    now: time.now,
  };
  const shareDeps: ShareDeps = {
    db: database.db,
    storage: store.storage,
    origin: ORIGIN,
    storageOrigin: STORAGE_ORIGIN,
    secret: SECRET,
    now: time.now,
  };
  return { ...database, store, time, deps, shareDeps };
}
