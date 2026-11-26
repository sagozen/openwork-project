#!/usr/bin/env node
// Verifies a Node backup without touching the live site: checks every file's
// SHA-256 against the manifest, copies the database to a fresh temporary
// directory, runs SQLite's integrity check and compares row counts.
//
//   node ops/scripts/restore-verify.mjs <backup-dir>
//
// A full rehearsal then boots that copy with `npm run preview` (same
// encryption key) and signs in a rehearsal student; see
// ops/runbooks/backup-restore.md.
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const dir = process.argv[2];
if (!dir) {
  console.error("Usage: node ops/scripts/restore-verify.mjs <backup-dir>");
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
const problems = [];
for (const [file, hash] of Object.entries(manifest.files)) {
  const actual = createHash("sha256")
    .update(readFileSync(join(dir, file)))
    .digest("hex");
  if (actual !== hash) problems.push(`Checksum mismatch: ${file}`);
}
const scratch = mkdtempSync(join(tmpdir(), "mytutor-restore-"));
copyFileSync(join(dir, "emdash.db"), join(scratch, "emdash.db"));
const db = new DatabaseSync(join(scratch, "emdash.db"), { readOnly: true });
const integrity = db.prepare("PRAGMA integrity_check").get();
if (Object.values(integrity)[0] !== "ok")
  problems.push(`SQLite integrity check: ${JSON.stringify(integrity)}`);
for (const [table, count] of Object.entries(manifest.tables)) {
  const actual = db
    .prepare(`SELECT COUNT(*) AS n FROM "${table.replaceAll('"', '""')}"`)
    .get().n;
  if (actual !== count)
    problems.push(`Row count for ${table}: expected ${count}, found ${actual}`);
}
db.close();
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(
  `Backup ${dir} verified: ${Object.keys(manifest.files).length} files, ${Object.keys(manifest.tables).length} tables. Restored copy at ${scratch}.`,
);
