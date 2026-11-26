#!/usr/bin/env node
// Backup of a Cloudflare site's D1 database.
//
//   node ops/scripts/backup-cloudflare.mjs --database <d1-name> --out <dir> [--config <wrangler config>]
//
// 1. Records the D1 Time Travel bookmark (30 days on paid plans). Restoring a
//    bookmark overwrites the database in place, so it is for emergencies only.
// 2. Exports table by table, skipping EmDash's _emdash_fts_* tables: a plain
//    `wrangler d1 export` fails when FTS5 virtual tables exist.
// 3. Writes a manifest with SHA-256 per file and row counts.
// R2 media is copied separately with an S3-compatible tool (for example
// rclone) using credentials that can read the media bucket and write only the
// backup bucket; see ops/runbooks/backup-restore.md.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    database: { type: "string" },
    out: { type: "string", default: "backups" },
    config: { type: "string" },
  },
});
if (!values.database || !/^[A-Za-z0-9_-]+$/.test(values.database)) {
  console.error("Pass --database <d1-name>.");
  process.exit(1);
}
const config = values.config ? ["--config", values.config] : [];
// A backup makes one API call per table; retry the occasional network
// failure ("fetch failed") instead of losing a long run.
const wrangler = (...args) => {
  for (let attempt = 1; ; attempt++) {
    try {
      return execFileSync(
        "npx",
        ["--no-install", "wrangler", ...args, ...config],
        { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
      );
    } catch (error) {
      if (attempt >= 4) throw error;
      console.error(
        `wrangler ${args[0]} ${args[1]} failed; retrying (${attempt}/3).`,
      );
      execFileSync("sleep", [String(attempt * 2)]);
    }
  }
};
/** Wrangler prints a banner before --json output; parse from the first bracket. */
const json = (output) => {
  const start = [output.indexOf("["), output.indexOf("{")]
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];
  return JSON.parse(output.slice(start));
};

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const target = join(values.out, `mytutor-d1-${values.database}-${stamp}`);
mkdirSync(target, { recursive: true, mode: 0o700 });

const bookmark = json(
  wrangler("d1", "time-travel", "info", values.database, "--json"),
);
const listed = json(
  wrangler(
    "d1",
    "execute",
    values.database,
    "--remote",
    "--json",
    "--command",
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE '_emdash_fts_%' ORDER BY name",
  ),
);
const tables = listed[0].results.map((row) => row.name);
const counts = {};
const files = {};
for (const table of tables) {
  const file = `${table}.sql`;
  wrangler(
    "d1",
    "export",
    values.database,
    "--remote",
    "--table",
    table,
    "--output",
    join(target, file),
  );
  files[file] = createHash("sha256")
    .update(readFileSync(join(target, file)))
    .digest("hex");
  counts[table] = json(
    wrangler(
      "d1",
      "execute",
      values.database,
      "--remote",
      "--json",
      "--command",
      `SELECT COUNT(*) AS n FROM "${table.replaceAll('"', '""')}"`,
    ),
  )[0].results[0].n;
}
writeFileSync(
  join(target, "manifest.json"),
  `${JSON.stringify({ kind: "mytutor-d1-backup", createdAt: new Date().toISOString(), database: values.database, bookmark, tables: counts, files }, null, 2)}\n`,
  { mode: 0o600 },
);
console.log(
  `D1 backup written to ${target} (${tables.length} tables). Copy R2 media separately.`,
);
