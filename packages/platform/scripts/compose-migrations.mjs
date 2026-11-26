#!/usr/bin/env node
/**
 * Migration composition for the shared platform.
 *
 * Every app that ships a `migrations.manifest.json` is handled in one of two modes:
 *
 * - `"frozen": true` — the app already applied these migrations in production, so the
 *   directory is never rewritten. The manifest carries a SHA-256 per file and `--check`
 *   fails if any byte changes. This is the guard against renumbering SQL that D1 already
 *   ran (phase-01 risk).
 * - `"frozen": false` — the directory is generated: platform migrations first (renumbered
 *   from 0001), then the opt-in platform modules the manifest lists in `"modules"` (from
 *   `packages/platform/migrations/modules/<name>/`), then the app's own sources from
 *   `sourcesDir`, continuing the sequence. Apps without `"modules"` receive none of them.
 *
 * Usage:
 *   node packages/platform/scripts/compose-migrations.mjs all [--check]
 *   node packages/platform/scripts/compose-migrations.mjs apps/transcript [--check]
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const platformMigrations = join(repoRoot, "packages", "platform", "migrations");
const moduleMigrations = join(platformMigrations, "modules");

const args = process.argv.slice(2);
const check = args.includes("--check");
const targets = args.filter((argument) => !argument.startsWith("--"));

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function sqlFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((file) => file.endsWith(".sql"))
    .sort();
}

function pad(number) {
  return String(number).padStart(4, "0");
}

function verifyFrozen(appDir, manifest) {
  const errors = [];
  const directory = join(appDir, manifest.output ?? "migrations");
  for (const [file, expected] of Object.entries(manifest.hashes ?? {})) {
    const path = join(directory, file);
    if (!existsSync(path)) {
      errors.push(`${relative(repoRoot, path)} is missing (frozen migration)`);
      continue;
    }
    const actual = sha256(readFileSync(path));
    if (actual !== expected) errors.push(`${relative(repoRoot, path)} changed: ${actual} != ${expected}`);
  }
  const known = new Set(Object.keys(manifest.hashes ?? {}));
  for (const file of sqlFiles(directory)) {
    if (!known.has(file)) errors.push(`${relative(repoRoot, directory)}/${file} is not in the frozen manifest`);
  }
  return errors;
}

function compose(appDir, manifest) {
  const output = join(appDir, manifest.output ?? "migrations");
  const sources = join(appDir, manifest.sourcesDir ?? "migrations.src");
  const generated = [];
  let index = 1;
  for (const file of sqlFiles(platformMigrations)) {
    const stem = file.replace(/^\d+_/, "").replace(/\.sql$/, "");
    generated.push({
      name: `${pad(index)}_${stem}.sql`,
      content: readFileSync(join(platformMigrations, file), "utf8"),
    });
    index += 1;
  }
  for (const moduleName of manifest.modules ?? []) {
    const directory = join(moduleMigrations, moduleName);
    const files = sqlFiles(directory);
    if (files.length === 0) throw new Error(`Unknown platform migration module "${moduleName}"`);
    for (const file of files) {
      const stem = file.replace(/^\d+_/, "").replace(/\.sql$/, "");
      generated.push({
        name: `${pad(index)}_${moduleName}_${stem}.sql`,
        content: readFileSync(join(directory, file), "utf8"),
      });
      index += 1;
    }
  }
  for (const file of sqlFiles(sources)) {
    const stem = file.replace(/^\d+_/, "").replace(/\.sql$/, "");
    generated.push({ name: `${pad(index)}_${stem}.sql`, content: readFileSync(join(sources, file), "utf8") });
    index += 1;
  }

  const errors = [];
  if (existsSync(output)) {
    const existing = sqlFiles(output);
    const expected = new Set(generated.map((entry) => entry.name));
    for (const file of existing) {
      if (!expected.has(file)) errors.push(`${relative(repoRoot, output)}/${file} is not generated (stale)`);
    }
    for (const entry of generated) {
      const path = join(output, entry.name);
      const actual = existsSync(path) ? readFileSync(path, "utf8") : null;
      if (actual !== entry.content) errors.push(`${relative(repoRoot, output)}/${entry.name} differs from its source`);
    }
  } else {
    errors.push(`${relative(repoRoot, output)} does not exist`);
  }

  if (check) return errors;

  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  for (const entry of generated) writeFileSync(join(output, entry.name), entry.content);
  writeFileSync(
    join(output, "README.md"),
    `# Generated migrations\n\nDo not edit by hand. Run \`npm run compose:migrations\`.\n\n` +
      `Sources: \`packages/platform/migrations/*.sql\`${(manifest.modules ?? []).length ? `, modules ${manifest.modules.join(", ")},` : ""} then \`${manifest.sourcesDir ?? "migrations.src"}/*.sql\`.\n`,
  );
  return [];
}

function appsWithManifests() {
  const appsDir = join(repoRoot, "apps");
  return readdirSync(appsDir)
    .map((name) => join(appsDir, name))
    .filter((directory) => existsSync(join(directory, "migrations.manifest.json")));
}

const selected = targets[0] === "all" ? appsWithManifests() : targets.map((target) => resolve(process.cwd(), target));

if (selected.length === 0) {
  console.error("No app with a migrations.manifest.json found. Pass `all` or an app directory.");
  process.exit(2);
}

let failed = false;
for (const appDir of selected) {
  const manifestPath = join(appDir, "migrations.manifest.json");
  if (!existsSync(manifestPath)) {
    console.error(`✗ ${relative(repoRoot, appDir)} has no migrations.manifest.json`);
    failed = true;
    continue;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const mode = manifest.frozen ? "frozen" : "composed";
  const errors = manifest.frozen ? verifyFrozen(appDir, manifest) : compose(appDir, manifest);
  if (errors.length > 0) {
    failed = true;
    console.error(`✗ ${relative(repoRoot, appDir)} (${mode})`);
    for (const error of errors) console.error(`  - ${error}`);
  } else if (check) {
    console.log(`✓ ${relative(repoRoot, appDir)} (${mode}) verified`);
  } else {
    console.log(`✓ ${relative(repoRoot, appDir)} (${mode}) ${manifest.frozen ? "verified, not rewritten" : "written"}`);
  }
}

process.exit(failed ? 1 : 0);
