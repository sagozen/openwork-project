export interface Statement {
  sql: string;
  params?: unknown[];
}

export interface Db {
  first<T>(sql: string, params?: unknown[]): Promise<T | null>;
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  run(sql: string, params?: unknown[]): Promise<{ changes: number }>;
  batch(statements: Statement[]): Promise<void>;
  exec(sql: string): Promise<void>;
}

export function d1Db(d1: D1Database): Db {
  return {
    async first<T>(sql: string, params: unknown[] = []) {
      const statement = d1.prepare(sql);
      return (await (params.length ? statement.bind(...params) : statement).first<T>()) ?? null;
    },
    async all<T>(sql: string, params: unknown[] = []) {
      const statement = d1.prepare(sql);
      const result = await (params.length ? statement.bind(...params) : statement).all<T>();
      return result.results ?? [];
    },
    async run(sql: string, params: unknown[] = []) {
      const statement = d1.prepare(sql);
      const result = await (params.length ? statement.bind(...params) : statement).run();
      return { changes: result.meta?.changes ?? 0 };
    },
    async batch(statements: Statement[]) {
      if (statements.length === 0) return;
      await d1.batch(
        statements.map((statement) => {
          const prepared = d1.prepare(statement.sql);
          return statement.params?.length ? prepared.bind(...statement.params) : prepared;
        }),
      );
    },
    async exec(sql: string) {
      await d1.exec(sql);
    },
  };
}

export function id(prefix: string): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `${prefix}_${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
