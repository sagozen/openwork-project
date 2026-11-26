import type { Db, Statement } from "@templatedesign/platform/db";

/**
 * Tenant-scoped queries. Every statement against a business table is written with the `:ws`
 * token where the workspace id belongs, for example
 *
 *   scoped.first("SELECT * FROM rc_orders WHERE workspace_id = :ws AND id = ?", [orderId])
 *
 * `:ws` is replaced by a bound parameter holding the workspace id the helper was created with,
 * so a route cannot forget to pass it, and a statement without the token is refused instead of
 * silently running across tenants. Do not put a literal `?` or `:ws` inside a SQL string literal.
 */
export interface ScopedDb {
  readonly workspaceId: string;
  first<T>(sql: string, params?: unknown[]): Promise<T | null>;
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  run(sql: string, params?: unknown[]): Promise<{ changes: number }>;
  batch(statements: Statement[]): Promise<void>;
  /** INSERT with `workspace_id` filled in. Column names are checked; values are bound. */
  insert(table: string, values: Record<string, unknown>): Promise<{ changes: number }>;
  /** Same insert as a batch statement. */
  insertStatement(table: string, values: Record<string, unknown>): Statement;
}

export class UnscopedQueryError extends Error {
  constructor(sql: string) {
    super(`Query on a tenant table must contain the :ws token: ${sql.trim().slice(0, 120)}`);
    this.name = "UnscopedQueryError";
  }
}

const TOKEN = /\?|:ws\b/g;
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/** Rewrites `:ws` to `?` and splices the workspace id into the parameter list in order. */
export function bindWorkspace(sql: string, params: unknown[], workspaceId: string): { sql: string; params: unknown[] } {
  if (!/:ws\b/.test(sql)) throw new UnscopedQueryError(sql);
  const bound: unknown[] = [];
  let next = 0;
  const rewritten = sql.replace(TOKEN, (token) => {
    if (token === ":ws") {
      bound.push(workspaceId);
    } else {
      if (next >= params.length) throw new Error(`Missing parameter ${next + 1} for: ${sql.trim().slice(0, 120)}`);
      bound.push(params[next]);
      next += 1;
    }
    return "?";
  });
  if (next !== params.length) throw new Error(`Expected ${next} parameters, got ${params.length}`);
  return { sql: rewritten, params: bound };
}

export function scoped(db: Db, workspaceId: string): ScopedDb {
  if (!workspaceId) throw new Error("scoped() needs a workspace id");
  const rewrite = (sql: string, params: unknown[] = []) => bindWorkspace(sql, params, workspaceId);
  const insertStatement = (table: string, values: Record<string, unknown>): Statement => {
    if (!IDENTIFIER.test(table)) throw new Error(`Bad table name: ${table}`);
    const columns = Object.keys(values);
    for (const column of columns) {
      if (!IDENTIFIER.test(column)) throw new Error(`Bad column name: ${column}`);
      if (column === "workspace_id") throw new Error("workspace_id is set by the scoped helper");
    }
    const names = ["workspace_id", ...columns];
    return {
      sql: `INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
      params: [workspaceId, ...columns.map((column) => values[column])],
    };
  };
  return {
    workspaceId,
    first: async (sql, params) => {
      const q = rewrite(sql, params);
      return db.first(q.sql, q.params);
    },
    all: async (sql, params) => {
      const q = rewrite(sql, params);
      return db.all(q.sql, q.params);
    },
    run: async (sql, params) => {
      const q = rewrite(sql, params);
      return db.run(q.sql, q.params);
    },
    batch: async (statements) =>
      db.batch(
        statements.map((statement) => {
          const q = rewrite(statement.sql, statement.params ?? []);
          return { sql: q.sql, params: q.params };
        }),
      ),
    insert: async (table, values) => {
      const statement = insertStatement(table, values);
      return db.run(statement.sql, statement.params ?? []);
    },
    insertStatement,
  };
}
