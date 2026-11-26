#!/usr/bin/env node
/**
 * i18n gate: key parity, non-empty values, matching placeholders, and every
 * literal t("key") used in a component exists in both locales.
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { messages } = await import(join(root, "src", "copy.ts"));

const failures = [];
const en = messages.en;
const vi = messages.vi;
const enKeys = Object.keys(en).sort();
const viKeys = Object.keys(vi).sort();

for (const key of enKeys) {
  if (!(key in vi)) failures.push(`VI is missing key: ${key}`);
  if (!en[key]?.trim()) failures.push(`EN value is empty: ${key}`);
  if (!vi[key]?.trim()) failures.push(`VI value is empty: ${key}`);
}
for (const key of viKeys) {
  if (!(key in en)) failures.push(`EN is missing key: ${key}`);
}

const placeholderPattern = /\{(\w+)\}/g;
for (const key of enKeys) {
  const enVars = [...en[key].matchAll(placeholderPattern)].map((match) => match[1]).sort();
  const viVars = [...(vi[key] ?? "").matchAll(placeholderPattern)].map((match) => match[1]).sort();
  if (enVars.join() !== viVars.join()) {
    failures.push(`placeholder mismatch at ${key}: EN {${enVars.join(",")}} vs VI {${viVars.join(",")}}`);
  }
}

/* Literal keys used in components must exist. Dynamic keys (template literals) are skipped. */
async function* tsxFiles(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* tsxFiles(path);
    else if ([".tsx", ".ts"].includes(extname(entry.name))) yield path;
  }
}

let usages = 0;
for (const sourceRoot of ["src", "../../apps/web/src", "../../apps/styleguide/src"]) {
  for await (const file of tsxFiles(join(root, sourceRoot))) {
    if (file.endsWith("copy.ts")) continue;
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(/\b(?:t|tr)\(\s*["']([a-z0-9_.]+)["']/g)) {
      usages += 1;
      if (!(match[1] in en)) failures.push(`${file}: unknown message key "${match[1]}"`);
    }
    for (const match of source.matchAll(/\b(?:t|tr)\(\s*`([a-z0-9_.]+)\.\$\{/g)) {
      usages += 1;
      const prefix = match[1] + ".";
      const candidates = enKeys.filter((key) => key.startsWith(prefix));
      if (candidates.length === 0) failures.push(`${file}: dynamic key prefix "${prefix}" has no messages`);
    }
  }
}

if (failures.length > 0) {
  console.error(`i18n: ${failures.length} failure(s)`);
  for (const failure of failures) console.error(`  FAIL ${failure}`);
  process.exit(1);
}
console.log(`i18n: ${enKeys.length} keys × 2 locales, ${usages} usages, parity OK`);
