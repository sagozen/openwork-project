import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { Db, Statement } from "@templatedesign/platform/db";

const platform = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "platform", "migrations");

export interface TestDb {
  db: Db;
  raw: DatabaseSync;
  close(): void;
}

const sqlIn = (directory: string) =>
  readdirSync(directory)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => readFileSync(join(directory, file), "utf8"));

/** node:sqlite database with the platform baseline, the workspaces module and any extra SQL. */
export function createTestDb(extraSql: string[] = []): TestDb {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = ON");
  for (const sql of [...sqlIn(platform), ...sqlIn(join(platform, "modules", "workspaces")), ...extraSql]) raw.exec(sql);

  const db: Db = {
    async first<T>(sql: string, params: unknown[] = []) {
      return (raw.prepare(sql).get(...(params as never[])) ?? null) as T | null;
    },
    async all<T>(sql: string, params: unknown[] = []) {
      return raw.prepare(sql).all(...(params as never[])) as T[];
    },
    async run(sql: string, params: unknown[] = []) {
      const result = raw.prepare(sql).run(...(params as never[]));
      return { changes: Number(result.changes) };
    },
    async batch(statements: Statement[]) {
      raw.exec("BEGIN");
      try {
        for (const statement of statements) raw.prepare(statement.sql).run(...((statement.params ?? []) as never[]));
        raw.exec("COMMIT");
      } catch (error) {
        raw.exec("ROLLBACK");
        throw error;
      }
    },
    async exec(sql: string) {
      raw.exec(sql);
    },
  };
  return { db, raw, close: () => raw.close() };
}

export class MemoryBucket {
  readonly objects = new Map<string, { bytes: Uint8Array; contentType?: string }>();
  async put(
    key: string,
    value: ArrayBuffer | Uint8Array | string,
    options?: { httpMetadata?: { contentType?: string } },
  ) {
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value as ArrayBuffer);
    this.objects.set(key, { bytes, contentType: options?.httpMetadata?.contentType });
  }
  async get(key: string) {
    const entry = this.objects.get(key);
    return entry ? { body: new Blob([entry.bytes as BlobPart]).stream(), ...entry } : null;
  }
  async delete(keys: string | string[]) {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
  }
}

export function asBucket(bucket: MemoryBucket): R2Bucket {
  return bucket as unknown as R2Bucket;
}
