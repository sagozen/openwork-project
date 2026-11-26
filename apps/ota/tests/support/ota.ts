import type { Db } from "@templatedesign/platform/db";
import { createWorkspace, setWorkspacePlan, type Workspace } from "@templatedesign/platform/workspaces";
import "../../src/lib/platform";
import { scoped } from "@templatedesign/app-shell/db/scoped";
import { createTestDb, type TestDb } from "./db";

export const DEFAULT_APPS = [
  { slug: "unitel-man", name: "Unitel Man" },
  { slug: "unitel-logistics", name: "Unitel Logistics" },
];

/** The slice of the D1 query API the assertions below use, over the app's `Db`. */
export interface Inspector {
  prepare(sql: string): Prepared;
}
interface Prepared {
  bind(...params: unknown[]): Prepared;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<{ changes: number }>;
}

export function inspector(db: Db): Inspector {
  const prepared = (sql: string, params: unknown[]): Prepared => ({
    bind: (...next) => prepared(sql, next),
    first: <T>() => db.first<T>(sql, params),
    all: async <T>() => ({ results: await db.all<T>(sql, params) }),
    run: () => db.run(sql, params),
  });
  return { prepare: (sql) => prepared(sql, []) };
}

export interface OtaFixture extends TestDb {
  workspace: Workspace;
  inspect: Inspector;
}

let counter = 0;

/** Adds a user, tenant and workspace on `plan` to an existing test database, with the given apps registered. */
export async function addOtaWorkspace(
  test: TestDb,
  options: { plan?: string; apps?: Array<{ slug: string; name: string }>; slug?: string } = {},
): Promise<Workspace> {
  const { db } = test;
  counter += 1;
  const now = "2026-01-01T00:00:00.000Z";
  await db.run('INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)', [
    `u${counter}`,
    "Tester",
    `tester${counter}@example.com`,
    now,
    now,
  ]);
  await db.run("INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)", [`t${counter}`, "Tenant", now]);
  let workspace = await createWorkspace(db, {
    app: "ota",
    slug: options.slug ?? "ota-test",
    userId: `u${counter}`,
    tenantId: `t${counter}`,
  });
  if (options.plan && options.plan !== "free") workspace = await setWorkspacePlan(db, workspace, options.plan);
  const as = scoped(db, workspace.id);
  for (const app of options.apps ?? DEFAULT_APPS) {
    await as.insert("ota_apps", { slug: app.slug, name: app.name, enabled: 1, created_at: 0, updated_at: 0 });
  }
  return workspace;
}

/** A fresh database with one workspace on `plan` and the given apps already registered. */
export async function setupOta(
  options: { plan?: string; apps?: Array<{ slug: string; name: string }>; slug?: string } = {},
): Promise<OtaFixture> {
  const test = createTestDb();
  const workspace = await addOtaWorkspace(test, options);
  return { ...test, workspace, inspect: inspector(test.db) };
}
