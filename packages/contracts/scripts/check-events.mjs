#!/usr/bin/env node
import { existsSync } from "node:fs";
/**
 * Fail CI when UI code emits an analytics event that is not in the allowlist,
 * or passes a property the event does not declare.
 *
 * Usage: node packages/contracts/scripts/check-events.mjs
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const analytics = JSON.parse(
  await readFile(join(root, "packages", "contracts", "catalogue", "analytics-events.json"), "utf8"),
);
const allowed = new Map(analytics.events.map((event) => [event.name, new Set(event.props)]));

const roots = ["packages/ui/src", "apps/styleguide/src"];
const extensions = new Set([".ts", ".tsx", ".js", ".jsx", ".astro", ".mjs"]);

async function* files(directory) {
  if (!existsSync(directory)) return;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (extensions.has(extname(entry.name))) yield path;
  }
}

const failures = [];
let found = 0;
const callPattern = /\btrack(?:Event)?\(\s*["'`]([a-z0-9_]+)["'`]\s*(?:,\s*\{([^}]*)\})?/g;

for (const relative of roots) {
  for await (const file of files(join(root, relative))) {
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(callPattern)) {
      found += 1;
      const [, name, rawProps] = match;
      if (!allowed.has(name)) {
        failures.push(`${file}: unknown analytics event "${name}"`);
        continue;
      }
      if (!rawProps) continue;
      const declared = allowed.get(name);
      const keys = [...rawProps.matchAll(/([A-Za-z_$][\w$]*)\s*:/g)].map((keyMatch) => keyMatch[1]);
      for (const key of keys) {
        if (!declared.has(key)) failures.push(`${file}: event "${name}" passes undeclared property "${key}"`);
      }
    }
  }
}

if (failures.length > 0) {
  console.error(`analytics: ${failures.length} failure(s)`);
  for (const failure of failures) console.error(`  FAIL ${failure}`);
  process.exit(1);
}
console.log(`analytics: ${found} emitted event call(s) checked, allowlist OK`);
