#!/usr/bin/env node
// Online backup of a Node host: SQLite database, media and a manifest.
//
//   node --env-file=<host env file> ops/scripts/backup-node.mjs --data-dir <dir> --out <dir>
//
// EmDash's JSON export excludes users, passkeys, plugin storage and settings,
// so it is not a backup for this product. This copies the whole database with
// SQLite's online backup. The encryption key is NOT copied: keep it escrowed
// separately (see ops/security/secrets-inventory.md). The script refuses to
// run without the key in the environment, so a backup is never taken from a
// host that could not decrypt its own secrets.
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    "data-dir": {
      type: "string",
      default: process.env.MYTUTOR_DATA_DIR ?? "themes/mytutor/.data",
    },
    out: { type: "string", default: "backups" },
  },
});
if (!process.env.EMDASH_ENCRYPTION_KEY) {
  console.error(
    "EMDASH_ENCRYPTION_KEY is not set. Run with the host's environment file; the key itself is never copied.",
  );
  process.exit(1);
}
const dataDir = values["data-dir"];
const database = join(dataDir, "emdash.db");
if (!existsSync(database)) {
  console.error(`No database at ${database}.`);
  process.exit(1);
}
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const target = join(values.out, `mytutor-node-${stamp}`);
mkdirSync(target, { recursive: true, mode: 0o700 });

const source = new DatabaseSync(database, { readOnly: true });
await backup(source, join(target, "emdash.db"));
source.close();
if (existsSync(join(dataDir, "media")))
  cpSync(join(dataDir, "media"), join(target, "media"), { recursive: true });

const copy = new DatabaseSync(join(target, "emdash.db"), { readOnly: true });
const tables = Object.fromEntries(
  copy
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map(({ name }) => [
      name,
      copy
        .prepare(
          `SELECT COUNT(*) AS n FROM "${String(name).replaceAll('"', '""')}"`,
        )
        .get().n,
    ]),
);
copy.close();

const files = {};
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (name !== "manifest.json")
      files[relative(target, path)] = createHash("sha256")
        .update(readFileSync(path))
        .digest("hex");
  }
};
walk(target);
writeFileSync(
  join(target, "manifest.json"),
  `${JSON.stringify({ kind: "mytutor-node-backup", createdAt: new Date().toISOString(), source: dataDir, tables, files }, null, 2)}\n`,
  { mode: 0o600 },
);
console.log(
  `Backup written to ${target} (${Object.keys(files).length} files, ${Object.keys(tables).length} tables).`,
);
