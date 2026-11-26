#!/usr/bin/env node
/**
 * Deploy preflight for TranscriptAnything. Catches the mistakes that cost a deploy cycle:
 * scaffolding ids still in wrangler.jsonc, un-composed migrations, half-configured Turnstile,
 * a weak auth secret, a missing model. It never calls Cloudflare, so it is safe to run offline
 * and in CI.
 *
 *   npm run preflight:transcript
 *   node apps/transcript/scripts/preflight.mjs --json
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(appDir, "..", "..");
const json = process.argv.includes("--json");

const SCAFFOLD_D1 = "6f3c1a52-8d4e-4b27-9a10-2c7e5b8d43f1";
const SCAFFOLD_KV = "9dc0a6f6c2e34d1a8f5b7e0c3d4a6b19";

const results = [];
const add = (level, code, message) => results.push({ level, code, message });
const fail = (code, message) => add("error", code, message);
const warn = (code, message) => add("warning", code, message);
const pass = (code, message) => add("ok", code, message);

function readWrangler() {
  const path = join(appDir, "wrangler.jsonc");
  if (!existsSync(path)) {
    fail("wrangler_missing", "apps/transcript/wrangler.jsonc is missing.");
    return null;
  }
  const raw = readFileSync(path, "utf8");
  const withoutComments = raw.replace(/^\s*\/\/.*$/gm, "");
  try {
    return JSON.parse(withoutComments);
  } catch (error) {
    fail("wrangler_invalid", `wrangler.jsonc is not valid JSON after stripping comments: ${error.message}`);
    return null;
  }
}

const wrangler = readWrangler();
if (wrangler) {
  const d1 = wrangler.d1_databases?.[0];
  const kv = wrangler.kv_namespaces?.[0];
  const buckets = (wrangler.r2_buckets ?? []).map((bucket) => bucket.binding);
  const route = wrangler.routes?.[0]?.pattern ?? "";

  if (!d1?.database_id || d1.database_id === SCAFFOLD_D1) {
    fail(
      "d1_placeholder",
      "d1_databases[0].database_id is still the scaffolding id — run `wrangler d1 create transcript-web`.",
    );
  } else {
    pass("d1", `D1 binding ${d1.binding} → ${d1.database_name}`);
  }
  if (!kv?.id || kv.id === SCAFFOLD_KV) {
    fail(
      "kv_placeholder",
      "kv_namespaces[0].id is still the scaffolding id — run `wrangler kv namespace create SESSION`.",
    );
  } else {
    pass("kv", "SESSION KV namespace configured");
  }
  if (!buckets.includes("MEDIA") || !buckets.includes("OUTPUTS")) {
    fail("buckets", "r2_buckets must bind MEDIA and OUTPUTS.");
  } else {
    pass("buckets", "MEDIA and OUTPUTS buckets bound");
  }
  if (!route.includes("transcriptanything")) {
    warn("route", `custom domain looks unexpected: ${route || "(none)"}`);
  } else {
    pass("route", route);
  }
  if (!wrangler.triggers?.crons?.length) {
    fail("crons", "triggers.crons is empty; lease recovery and retention depend on it.");
  } else {
    pass("crons", `crons: ${wrangler.triggers.crons.join(", ")}`);
  }
  const vars = wrangler.vars ?? {};
  for (const key of ["APP_ORIGIN", "BETTER_AUTH_URL"]) {
    if (!vars[key] && !process.env[key]) {
      warn("vars", `${key} is not in wrangler.jsonc vars; set it before the first deploy.`);
    }
  }
  if (vars.APP_ORIGIN && vars.BETTER_AUTH_URL && vars.APP_ORIGIN !== vars.BETTER_AUTH_URL) {
    warn("origin_mismatch", "APP_ORIGIN and BETTER_AUTH_URL differ; cookies and magic links will disagree.");
  }
}

// Migrations must be composed and current (the platform guard).
try {
  execFileSync(
    process.execPath,
    [join(repoRoot, "packages/platform/scripts/compose-migrations.mjs"), appDir, "--check"],
    {
      stdio: "pipe",
    },
  );
  pass("migrations", "composed migrations are current");
} catch (error) {
  const output = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim();
  fail("migrations", `compose-migrations --check failed:\n${output || error.message}`);
}

// Secrets that are easy to forget, read from the environment when present.
const env = process.env;
const secret = env.BETTER_AUTH_SECRET;
if (secret && secret.length < 32) {
  fail("auth_secret", "BETTER_AUTH_SECRET must be at least 32 characters.");
} else if (!secret) {
  warn("auth_secret", "BETTER_AUTH_SECRET is not in this shell; confirm it with `wrangler secret list`.");
} else {
  pass("auth_secret", "BETTER_AUTH_SECRET is long enough");
}

const hasTurnstileSecret = Boolean(env.TURNSTILE_SECRET);
const hasTurnstileKey = Boolean(env.TURNSTILE_SITE_KEY);
if (hasTurnstileSecret !== hasTurnstileKey) {
  fail(
    "turnstile_half",
    "Set both TURNSTILE_SECRET and TURNSTILE_SITE_KEY, or neither; the secret alone blocks every guest.",
  );
} else if (hasTurnstileSecret) {
  pass("turnstile", "Turnstile configured (site key + secret)");
} else {
  warn("turnstile", "Turnstile is off; guests rely on rate limits only. Fine for staging, not for launch.");
}

if (!env.OPENROUTER_API_KEY) {
  warn("openrouter", "OPENROUTER_API_KEY is unset; summary/filter will report unavailable and release credits.");
}
if (!env.R2_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) {
  warn("r2_signing", "R2_* S3 credentials are unset in this shell; uploads and downloads need them on the Worker.");
}

const model = env.WHISPER_MODEL;
if (model && !existsSync(model)) {
  warn("model", `WHISPER_MODEL points at ${model}, which does not exist on this machine.`);
}

const errors = results.filter((entry) => entry.level === "error");
const warnings = results.filter((entry) => entry.level === "warning");

if (json) {
  console.log(JSON.stringify({ ok: errors.length === 0, errors, warnings, results }, null, 2));
} else {
  for (const entry of results) {
    const marker = entry.level === "error" ? "✗" : entry.level === "warning" ? "!" : "✓";
    console.log(`${marker} ${entry.code}: ${entry.message}`);
  }
  console.log(
    `\n${errors.length === 0 ? "Ready for the next deploy step." : `${errors.length} blocking issue(s).`}` +
      (warnings.length ? ` ${warnings.length} warning(s).` : ""),
  );
  console.log(
    "\nNot checked here (needs Cloudflare/dashboard access):\n" +
      "  - D1 migrations applied remotely\n" +
      "  - R2 lifecycle rule on transcript-media (24 h)\n" +
      "  - Worker secrets uploaded (`wrangler secret list`)\n" +
      "  - worker registered and both machines heartbeating\n" +
      "  - Stripe/Paddle webhook endpoint + signing secret",
  );
}

process.exit(errors.length === 0 ? 0 : 1);
