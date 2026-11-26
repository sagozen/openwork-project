#!/usr/bin/env node
/**
 * Provision the Cloudflare resources an app's `wrangler.jsonc` declares: the D1 database bound as
 * DB, the KV namespace bound as SESSION and every R2 bucket. Dry run by default.
 *
 *   node scripts/provision-app.mjs puzzle            # list what exists and what would be created
 *   node scripts/provision-app.mjs puzzle --apply    # create what is missing, write the ids
 *
 * Idempotent: a resource that already exists under the expected name is reused, never recreated.
 * Ids are written into wrangler.jsonc only where a placeholder is still in place; a real id that
 * differs from the account's resource stops the run instead of being overwritten. The dry run only
 * calls Wrangler's read-only list commands.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isPlaceholder, parseJsonc } from "./lib/wrangler-config.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const app = args.find((arg) => !arg.startsWith("-"));
if (!app) {
  console.error("usage: node scripts/provision-app.mjs <app> [--apply]");
  process.exit(2);
}
const appDir = join(root, "apps", app);
const configPath = join(appDir, "wrangler.jsonc");
if (!existsSync(configPath)) {
  console.error(`apps/${app}/wrangler.jsonc not found`);
  process.exit(2);
}

function wrangler(...command) {
  const result = spawnSync("npx", ["wrangler", ...command], {
    cwd: appDir,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", NO_COLOR: "1", FORCE_COLOR: "0" },
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status !== 0) {
    const reason = /not logged in|CLOUDFLARE_API_TOKEN|non-interactive/i.test(output)
      ? "Wrangler is not logged in; run `npx wrangler login`"
      : output.trim().split("\n").slice(-3).join(" ");
    throw new Error(`wrangler ${command.join(" ")} failed: ${reason}`);
  }
  return result.stdout ?? "";
}

function jsonArray(text) {
  const start = text.indexOf("[");
  return start === -1 ? [] : JSON.parse(text.slice(start));
}

const listD1 = () => jsonArray(wrangler("d1", "list", "--json")).map((db) => ({ name: db.name, id: db.uuid }));
const listKv = () => jsonArray(wrangler("kv", "namespace", "list")).map((ns) => ({ name: ns.title, id: ns.id }));
const listVectorize = () => jsonArray(wrangler("vectorize", "list", "--json")).map((index) => ({ name: index.name }));
/** Vectorize needs its shape at creation time and the config only names the index. */
const VECTORIZE_SHAPES = { "tower-docs": { dimensions: 1024, metric: "cosine" } };
const listR2 = () => [...wrangler("r2", "bucket", "list").matchAll(/^name:\s+(\S+)/gm)].map((match) => ({ name: match[1] }));

const text = readFileSync(configPath, "utf8");
const config = parseJsonc(text);
const d1 = (config.d1_databases ?? []).find((entry) => entry.binding === "DB");
const kv = (config.kv_namespaces ?? []).find((entry) => entry.binding === "SESSION");

/** This script writes the ids itself so the file keeps its comments and layout. */
const NO_CONFIG_EDIT = "--update-config=false";

/** Every resource the config needs, with how to find it, create it and record its id. */
const wanted = [];
if (d1) {
  wanted.push({
    kind: "D1 database",
    name: d1.database_name,
    current: d1.database_id,
    list: listD1,
    create: () => wrangler("d1", "create", d1.database_name, NO_CONFIG_EDIT),
    field: "database_id",
  });
}
if (kv) {
  wanted.push({
    kind: "KV namespace (SESSION)",
    name: `${config.name}-session`,
    current: kv.id,
    list: listKv,
    create: () => wrangler("kv", "namespace", "create", `${config.name}-session`, NO_CONFIG_EDIT),
    field: "id",
  });
}
for (const bucket of config.r2_buckets ?? []) {
  wanted.push({
    kind: `R2 bucket (${bucket.binding})`,
    name: bucket.bucket_name,
    list: listR2,
    create: () => wrangler("r2", "bucket", "create", bucket.bucket_name, NO_CONFIG_EDIT),
  });
}

for (const index of config.vectorize ?? []) {
  const shape = VECTORIZE_SHAPES[index.index_name];
  if (!shape) {
    console.error(`  ✗ Vectorize index "${index.index_name}" has no known shape in provision-app.mjs; add it to VECTORIZE_SHAPES.`);
    process.exit(1);
  }
  wanted.push({
    kind: `Vectorize index (${index.binding})`,
    name: index.index_name,
    list: listVectorize,
    create: () =>
      wrangler("vectorize", "create", index.index_name, `--dimensions=${shape.dimensions}`, `--metric=${shape.metric}`),
    shape,
  });
}

/** Replace one placeholder value of `field` with `id`, keeping the file's comments and layout. */
function writeId(source, field, placeholder, id) {
  const pattern = new RegExp(`("${field}"\\s*:\\s*")${placeholder.replace(/[-]/g, "\\-")}(")`);
  if (!pattern.test(source)) throw new Error(`could not find "${field}": "${placeholder}" in wrangler.jsonc`);
  return source.replace(pattern, `$1${id}$2`);
}

console.log(`${apply ? "Provisioning" : "Dry run for"} apps/${app} (Worker "${config.name}")\n`);
let updated = text;
let conflicts = 0;
const toCreate = [];

for (const item of wanted) {
  const found = item.list().find((entry) => entry.name === item.name);
  const hasId = item.field !== undefined;
  if (found) {
    if (hasId && !isPlaceholder(item.current) && item.current !== found.id) {
      console.log(`  ✗ ${item.kind} "${item.name}" exists as ${found.id}, but wrangler.jsonc has ${item.current}`);
      conflicts += 1;
      continue;
    }
    const write = hasId && isPlaceholder(item.current);
    console.log(`  ✓ ${item.kind} "${item.name}" exists${hasId ? ` (${found.id})` : ""}; reuse${write ? ", write its id" : ""}`);
    if (write) updated = writeId(updated, item.field, item.current, found.id);
  } else {
    console.log(`  + ${item.kind} "${item.name}" is missing; ${apply ? "creating" : "would create"}`);
    toCreate.push(item);
  }
}

if (conflicts > 0) {
  console.error("\nStopped: resolve the id conflicts above by hand; nothing was created or written.");
  process.exit(1);
}

if (!apply) {
  if (toCreate.length > 0) {
    console.log("\nCommands --apply will run:");
    for (const item of toCreate) {
      const verb = item.kind.startsWith("D1")
        ? "d1 create"
        : item.kind.startsWith("KV")
          ? "kv namespace create"
          : item.kind.startsWith("Vectorize")
            ? "vectorize create"
            : "r2 bucket create";
      const extra = item.shape ? `--dimensions=${item.shape.dimensions} --metric=${item.shape.metric}` : NO_CONFIG_EDIT;
      console.log(`  (cd apps/${app} && npx wrangler ${verb} ${item.name} ${extra})`);
    }
  }
  if (updated !== text || toCreate.some((item) => item.field)) {
    console.log("\n--apply will then write the resulting ids into apps/" + app + "/wrangler.jsonc.");
  }
  console.log(toCreate.length === 0 && updated === text ? "\nNothing to do." : "\nRe-run with --apply to make these changes.");
  process.exit(0);
}

for (const item of toCreate) {
  item.create();
  if (!item.field) {
    console.log(`  created ${item.kind} "${item.name}"`);
    continue;
  }
  const created = item.list().find((entry) => entry.name === item.name);
  if (!created) throw new Error(`${item.kind} "${item.name}" was created but does not appear in the list`);
  console.log(`  created ${item.kind} "${item.name}" (${created.id})`);
  if (isPlaceholder(item.current)) updated = writeId(updated, item.field, item.current, created.id);
}

if (updated !== text) {
  writeFileSync(configPath, updated);
  console.log(`\nWrote the ids into apps/${app}/wrangler.jsonc. Commit that change, then run npm run preflight:${app}.`);
} else {
  console.log("\nwrangler.jsonc already had every id.");
}
