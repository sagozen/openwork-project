import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Static guard: every statement on a tenant table names tenant_id, so a hand-written query that
 * forgets the predicate fails here. Each exception starts from a value the visitor's secret link
 * supplies, and everything after it is scoped to the row's own tenant.
 */
const ALLOWED: Array<{ file: string; pattern: RegExp; reason: string }> = [
  {
    file: "lib/ops.ts",
    pattern: /FROM (?:artifacts|shares)\b/,
    reason: "operator reporting and cleanup totals the whole service and returns counts and sizes only",
  },
  {
    file: "lib/shares/service.ts",
    pattern: /FROM shares WHERE id = \?"/,
    reason:
      "public share lookup: the 128-bit token in the URL is the capability; the queries after it use the share's tenant",
  },
];

const TABLES = ["artifacts", "shares", "share_items"];
const STATEMENT = new RegExp(`\\b(?:FROM|JOIN|INTO|UPDATE)\\s+(${TABLES.join("|")})\\b`);

interface Source {
  file: string;
  text: string;
}

/** Statements on a tenant table with no tenant_id within the next eight lines and no listed exception. */
function scan(sources: Source[]): { statements: number; offenders: string[] } {
  const offenders: string[] = [];
  let statements = 0;
  for (const { file, text } of sources) {
    const lines = text.split("\n");
    lines.forEach((line, index) => {
      if (!STATEMENT.test(line)) return;
      statements += 1;
      if (/tenant_id/.test(lines.slice(index, index + 8).join("\n"))) return;
      if (ALLOWED.some((entry) => entry.file === file && entry.pattern.test(line))) return;
      offenders.push(`${file}:${index + 1} ${line.trim()}`);
    });
  }
  return { statements, offenders };
}

function* walk(directory: string): Generator<string> {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (/\.(?:ts|tsx|astro)$/.test(name)) yield path;
  }
}

test("every query on a tenant table carries a tenant_id predicate unless it is a listed exception", () => {
  const root = join(here, "..", "src");
  const sources = [...walk(root)].map((path) => ({ file: relative(root, path), text: readFileSync(path, "utf8") }));
  const { statements, offenders } = scan(sources);
  assert.ok(statements > 20, `the scan found the service's statements (${statements})`);
  assert.deepEqual(offenders, []);
});

test("the scan flags a query that forgets the predicate and accepts one that has it", () => {
  const bad = scan([{ file: "lib/x.ts", text: 'await db.run("DELETE FROM artifacts WHERE id = ?", [id]);\n' }]);
  assert.equal(bad.offenders.length, 1);
  const joined = scan([
    {
      file: "lib/x.ts",
      text: "db.all(`SELECT a.* FROM share_items si\n JOIN artifacts a ON a.id = si.artifact_id\n WHERE si.tenant_id = ?`)",
    },
  ]);
  assert.deepEqual(joined.offenders, []);
  const unlisted = scan([{ file: "lib/other.ts", text: 'db.first("SELECT * FROM shares WHERE id = ?")\n' }]);
  assert.equal(unlisted.offenders.length, 1, "the exception is tied to one file");
});
