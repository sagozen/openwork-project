#!/usr/bin/env node
/**
 * CSS gate:
 * - balanced braces
 * - components consume semantic tokens only (no raw hex colours)
 * - every var(--td-*) is defined by the token build or locally
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const stylesDir = join(root, "src", "styles");
const tokenCss = await readFile(join(root, "..", "tokens", "dist", "css", "tokens.css"), "utf8");

const files = (await readdir(stylesDir)).filter((file) => file.endsWith(".css"));
const failures = [];

const defined = new Set([...tokenCss.matchAll(/(--td-[\w-]+)\s*:/g)].map((match) => match[1]));
const used = new Set();
let totalBytes = 0;

for (const file of files) {
  const css = await readFile(join(stylesDir, file), "utf8");
  totalBytes += Buffer.byteLength(css);
  if (!file.startsWith("base") && /#[0-9a-fA-F]{3,8}\b/.test(css)) {
    failures.push(`${file}: raw hex colour found; use a semantic token`);
  }
  let depth = 0;
  for (const char of css) {
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth < 0) break;
  }
  if (depth !== 0) failures.push(`${file}: unbalanced braces`);
  for (const match of css.matchAll(/var\((--td-[\w-]+)/g)) used.add(match[1]);
}

for (const variable of used) {
  if (!defined.has(variable)) failures.push(`undefined custom property: ${variable}`);
}

if (failures.length > 0) {
  console.error(`css: ${failures.length} failure(s)`);
  for (const failure of failures) console.error(`  FAIL ${failure}`);
  process.exit(1);
}
console.log(
  `css: ${files.length} files, ${(totalBytes / 1024).toFixed(1)} KiB, ${used.size} token references, all defined`,
);
