import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Static guard for the scoped-query rule. Scans app source for SQL that touches a tenant table
 * without the `:ws` token (or an explicit `workspace_id` predicate for platform helpers), so a
 * hand-written `db.first("SELECT ... FROM rc_orders WHERE id = ?")` fails a test instead of
 * shipping. It is a heuristic over string literals, not a SQL parser: a flagged line can be
 * waived with a trailing `// unscoped-ok: <reason>` comment.
 */

const SOURCE = /\.(?:[cm]?ts|tsx|astro)$/;
const SKIP = new Set(["node_modules", "dist", ".astro", ".wrangler", "migrations", "migrations.src", "tests"]);

export interface UnscopedHit {
  file: string;
  line: number;
  table: string;
  text: string;
}

function* walk(directory: string): Generator<string> {
  for (const name of readdirSync(directory)) {
    if (SKIP.has(name)) continue;
    const path = join(directory, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (SOURCE.test(name)) yield path;
  }
}

/**
 * @param dir directory to scan, usually `<app>/src`
 * @param tables tenant tables, from `tenantTables()` in the isolation harness or a static list
 */
export function findUnscopedSql(dir: string, tables: string[]): UnscopedHit[] {
  const hits: UnscopedHit[] = [];
  const pattern = new RegExp(`\\b(?:FROM|JOIN|INTO|UPDATE)\\s+"?(${tables.join("|")})"?\\b`, "i");
  for (const file of walk(dir)) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((text, index) => {
      const match = pattern.exec(text);
      if (!match || /unscoped-ok:/.test(text)) return;
      // A statement can span lines; look at a small window for the scope predicate.
      const window = lines.slice(index, index + 6).join("\n");
      if (/:ws\b|workspace_id/.test(window)) return;
      hits.push({ file: relative(dir, file), line: index + 1, table: match[1], text: text.trim() });
    });
  }
  return hits;
}
