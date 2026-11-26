import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { Db, Statement } from "@templatedesign/platform/db";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

export interface TestDb {
  db: Db;
  raw: DatabaseSync;
  close(): void;
}

/**
 * Loads the composed migrations (platform baseline + app tables) into node:sqlite.
 *
 * The shipped default grants no free credits. Most tests are about generation, not the grant policy, so
 * they start with `freeCredits` (50) per new account; pass `null` to keep the shipped default.
 */
export function createTestDb(options: { freeCredits?: number | null } = {}): TestDb {
  const freeCredits = options.freeCredits === undefined ? 50 : options.freeCredits;
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = ON");
  const migrations = readdirSync(join(root, "migrations"))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const file of migrations) raw.exec(readFileSync(join(root, "migrations", file), "utf8"));
  if (freeCredits !== null) {
    raw.prepare("UPDATE admin_settings SET value_json = ? WHERE key = 'free_monthly_credits'").run(String(freeCredits));
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
