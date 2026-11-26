import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { Db, Statement } from "../../src/db";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

export interface TestDb {
  db: Db;
  raw: DatabaseSync;
  close(): void;
}

/**
 * D1-compatible wrapper over node:sqlite that applies **only** the platform baseline
 * migrations. If a platform module ever starts depending on a product table, these tests
 * fail — which is the point of the extraction.
 */
export function createTestDb(options: { modules?: string[] } = {}): TestDb {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = ON");
  const migrations = readdirSync(join(root, "migrations"))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const file of migrations) raw.exec(readFileSync(join(root, "migrations", file), "utf8"));
  for (const moduleName of options.modules ?? []) {
    const directory = join(root, "migrations", "modules", moduleName);
    for (const file of readdirSync(directory)
      .filter((name) => name.endsWith(".sql"))
      .sort()) {
      raw.exec(readFileSync(join(directory, file), "utf8"));
    }
  }

  const db: Db = {
    async first<T>(sql: string, params: unknown[] = []) {
      const statement = raw.prepare(sql);
      return (statement.get(...(params as never[])) ?? null) as T | null;
    },
    async all<T>(sql: string, params: unknown[] = []) {
      const statement = raw.prepare(sql);
      return statement.all(...(params as never[])) as T[];
    },
    async run(sql: string, params: unknown[] = []) {
      const statement = raw.prepare(sql);
      const result = statement.run(...(params as never[]));
      return { changes: Number(result.changes) };
    },
    async batch(statements: Statement[]) {
      raw.exec("BEGIN");
      try {
        for (const statement of statements) {
          raw.prepare(statement.sql).run(...((statement.params ?? []) as never[]));
        }
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
