import assert from "node:assert/strict";
import type { Db } from "@templatedesign/platform/db";
import { createWorkspace, type Workspace } from "@templatedesign/platform/workspaces";
import { type ScopedDb, scoped } from "../db/scoped";

/**
 * Cross-tenant isolation harness. It creates two workspaces, seeds both, then replays a list of
 * actions *as workspace A* with workspace B's ids and markers as hostile input, and asserts that
 *
 *   1. none of B's rows changed (a snapshot of every table that has a `workspace_id` column), and
 *   2. nothing an action returned contains a marker string that only B's data holds.
 *
 * An app lists one action per API route or service function that takes an id from the caller.
 */

export interface IsolationContext {
  /** Everything A may legitimately touch. */
  as: ScopedDb;
  a: Workspace;
  b: Workspace;
  /** Marker strings and ids seeded for B. Pass them as hostile inputs. */
  foreign: SeededWorkspace;
}

export interface SeededWorkspace {
  /** Strings that appear only in this workspace's data (names, notes, codes). */
  markers: string[];
  /** Ids of this workspace's rows, by table. */
  ids: Record<string, string[]>;
}

export interface IsolationAction {
  name: string;
  /** Runs the action as A. Throwing is fine (a refusal is a pass); leaking or mutating is not. */
  run(context: IsolationContext): Promise<unknown>;
}

export interface IsolationOptions {
  db: Db;
  app: string;
  /** Creates one workspace's worth of rows through `as` and reports its markers and ids. */
  seed(as: ScopedDb, workspace: Workspace, label: "A" | "B"): Promise<SeededWorkspace>;
  actions: IsolationAction[];
  /** Tenant tables to snapshot. Defaults to every table with a `workspace_id` column. */
  tables?: string[];
}

interface UserSeed {
  userId: string;
  tenantId: string;
}

async function createAccount(db: Db, index: number): Promise<UserSeed> {
  const userId = `usr_iso_${index}`;
  const tenantId = `ten_iso_${index}`;
  const now = "2026-01-01T00:00:00.000Z";
  await db.run('INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)', [
    userId,
    `Iso ${index}`,
    `iso${index}@example.com`,
    now,
    now,
  ]);
  await db.run("INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)", [tenantId, `Iso ${index}`, now]);
  return { userId, tenantId };
}

async function tenantTables(db: Db): Promise<string[]> {
  const tables = await db.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
  );
  const found: string[] = [];
  for (const { name } of tables) {
    const columns = await db.all<{ name: string }>(
      `SELECT name FROM pragma_table_info('${name.replaceAll("'", "''")}')`,
    );
    if (columns.some((column) => column.name === "workspace_id")) found.push(name);
  }
  return found;
}

async function snapshot(db: Db, tables: string[], workspaceId: string): Promise<string> {
  const parts: string[] = [];
  for (const table of tables) {
    const rows = await db.all<Record<string, unknown>>(
      `SELECT * FROM "${table}" WHERE workspace_id = ? ORDER BY rowid`,
      [workspaceId],
    );
    parts.push(`${table}:${JSON.stringify(rows)}`);
  }
  return parts.join("\n");
}

export async function runIsolationSuite(options: IsolationOptions): Promise<void> {
  const { db, app } = options;
  const accountA = await createAccount(db, 1);
  const accountB = await createAccount(db, 2);
  const a = await createWorkspace(db, { app, slug: "iso-alpha", ...accountA });
  const b = await createWorkspace(db, { app, slug: "iso-bravo", ...accountB });
  const asA = scoped(db, a.id);
  const asB = scoped(db, b.id);
  await options.seed(asA, a, "A");
  const foreign = await options.seed(asB, b, "B");
  assert.ok(foreign.markers.length > 0, "seed() must report at least one marker string for the workspace");

  const tables = options.tables ?? (await tenantTables(db));
  assert.ok(tables.length > 0, "no table with a workspace_id column was found; is the schema loaded?");

  for (const action of options.actions) {
    const before = await snapshot(db, tables, b.id);
    let result: unknown;
    try {
      result = await action.run({ as: asA, a, b, foreign });
    } catch {
      result = null;
    }
    const after = await snapshot(db, tables, b.id);
    assert.equal(after, before, `${action.name}: workspace A changed workspace B's rows`);
    const output = JSON.stringify(result ?? null);
    for (const marker of foreign.markers) {
      assert.ok(!output.includes(marker), `${action.name}: workspace A received B's data (${marker})`);
    }
  }
}
