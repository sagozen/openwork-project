import type { DatabaseSync, SQLInputValue } from "node:sqlite";

/**
 * Minimal `D1Database` over node:sqlite, enough for Better Auth's D1 dialect (prepare/bind/all,
 * batch, exec) and the platform's `d1Db` wrapper. Values are coerced the way D1 coerces them:
 * booleans become 0/1 and `undefined` becomes NULL.
 */
export function d1FromSqlite(raw: DatabaseSync): D1Database {
  const coerce = (value: unknown): SQLInputValue => {
    if (value === undefined) return null;
    if (typeof value === "boolean") return value ? 1 : 0;
    return value as SQLInputValue;
  };

  function execute(sql: string, params: unknown[]) {
    const statement = raw.prepare(sql);
    const values = params.map(coerce);
    if (statement.columns().length === 0) {
      const result = statement.run(...values);
      return {
        results: [] as Record<string, unknown>[],
        meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) },
      };
    }
    const rows = statement.all(...values) as Record<string, unknown>[];
    return { results: rows, meta: { changes: 0, last_row_id: 0 } };
  }

  function prepare(sql: string, params: unknown[] = []) {
    const statement = {
      sql,
      params,
      bind: (...values: unknown[]) => prepare(sql, values),
      async all() {
        return { success: true, ...execute(sql, params) };
      },
      async run() {
        return { success: true, ...execute(sql, params) };
      },
      async first(column?: string) {
        const row = execute(sql, params).results[0] ?? null;
        if (row && column) return row[column] ?? null;
        return row;
      },
      async raw() {
        return execute(sql, params).results.map((row) => Object.values(row));
      },
    };
    return statement;
  }

  const database = {
    prepare: (sql: string) => prepare(sql),
    async batch(statements: Array<{ sql: string; params: unknown[] }>) {
      raw.exec("BEGIN");
      try {
        const results = statements.map((statement) => ({
          success: true,
          ...execute(statement.sql, statement.params),
        }));
        raw.exec("COMMIT");
        return results;
      } catch (error) {
        raw.exec("ROLLBACK");
        throw error;
      }
    },
    async exec(sql: string) {
      raw.exec(sql);
      return { count: 0, duration: 0 };
    },
  };
  // The structural subset above is what Better Auth and `d1Db` call; the full D1 surface
  // (sessions, dump) is not used by the code under test.
  return database as unknown as D1Database;
}
