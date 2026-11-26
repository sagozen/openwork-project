#!/usr/bin/env node
/**
 * Deploy preflight for any app under `apps/<name>` that has a `wrangler.jsonc`.
 *
 * Catches the mistakes that cost a deploy cycle without calling Cloudflare: scaffolding resource
 * ids still in the config, a missing binding, an inconsistent queue or Durable Object declaration,
 * stale composed migrations and (for the ERP) a stale embedded accounting artifact.
 *
 *   node scripts/preflight-app.mjs ota
 *   node scripts/preflight-app.mjs ota --plan     # also print the provisioning commands
 *   node scripts/preflight-app.mjs --all
 *   node scripts/preflight-app.mjs ota --json
 *
 * TranscriptAnything has its own deeper check (`npm run preflight:transcript`); `deploy-cf.sh`
 * runs that instead of this script when the app defines one.
 *
 * Apps listed in REQUIRED_SECRETS also get one read-only Cloudflare call, `wrangler secret list`,
 * which returns secret names only. Each required secret that is missing, or that cannot be
 * confirmed because Wrangler is offline or not logged in, is a blocking issue of its own.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isPlaceholder, parseJsonc } from "./lib/wrangler-config.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const REQUIRED_BUCKETS = {
  web: ["EXPORTS"],
  transcript: ["MEDIA", "OUTPUTS"],
  ota: ["MEDIA"],
  restaurant: ["MEDIA"],
  erp: ["MEDIA"],
  puzzle: ["BOOKS"],
  imagefactory: ["IMAGES"],
  tower: ["DOCS"],
};

const SECRET_HINTS = {
  web: ["BETTER_AUTH_URL", "APP_ORIGIN", "RENDERER_URL", "RENDERER_TOKEN", "INTERNAL_SWEEP_SECRET"],
  transcript: ["BETTER_AUTH_URL", "APP_ORIGIN", "R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"],
  ota: ["BETTER_AUTH_URL", "APP_ORIGIN", "OTA_SECRET_KEY"],
  restaurant: ["BETTER_AUTH_URL", "APP_ORIGIN"],
  erp: ["BETTER_AUTH_URL", "APP_ORIGIN"],
  puzzle: ["BETTER_AUTH_URL", "APP_ORIGIN", "WARRIORPLUS_IPN_KEY", "WARRIORPLUS_API_KEY"],
  imagefactory: ["BETTER_AUTH_URL", "APP_ORIGIN", "FAL_KEY"],
  forum: ["PUBLIC_ORIGIN", "APP_ORIGIN", "BETTER_AUTH_URL", "OPENROUTER_API_KEY", "INDEXNOW_KEY"],
  tower: ["PUBLIC_ORIGIN", "APP_ORIGIN", "BETTER_AUTH_URL", "OWNER_EMAILS", "ANTHROPIC_API_KEY"],
  myartifacts: ["BETTER_AUTH_URL", "APP_ORIGIN", "OWNER_EMAILS", "S3_ENDPOINT", "S3_REGION", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"],
  sixmonths: ["BETTER_AUTH_URL", "APP_ORIGIN", "GEMINI_API_KEY", "ANTHROPIC_API_KEY"],
};

/** Apps whose files live in an S3-compatible store instead of R2: the vars that locate it. */
const S3_VARS = {
  myartifacts: ["S3_ENDPOINT", "S3_REGION", "S3_BUCKET"],
};

/** Secrets the app cannot run without, with what each one is for. Names only, never values. */
const REQUIRED_SECRETS = {
  puzzle: {
    BETTER_AUTH_SECRET: "session signing key, at least 32 characters (openssl rand -hex 32)",
    WARRIORPLUS_IPN_KEY: "WarriorPlus IPN security key (Account > Settings > Security Key)",
    WARRIORPLUS_API_KEY: "WarriorPlus REST v2 API key, used for sale verification and daily reconciliation",
    ADMIN_EMAILS: "comma-separated owner emails: the first admin account and the recipients of IPN and render alerts",
  },
  imagefactory: {
    BETTER_AUTH_SECRET: "session signing key, at least 32 characters (openssl rand -hex 32)",
    FAL_KEY: "fal.ai API key used for every generation (billed to the owner's fal account)",
  },
  forum: {
    BETTER_AUTH_SECRET: "session signing key, at least 32 characters (openssl rand -hex 32)",
    OPENROUTER_API_KEY: "OpenRouter API key the twice-daily moderation job uses (free models by default)",
    TURNSTILE_SECRET: "Cloudflare Turnstile secret key that blocks bulk posting without a real human check",
  },
  tower: {
    BETTER_AUTH_SECRET: "session signing key, at least 32 characters (openssl rand -hex 32)",
    ANTHROPIC_API_KEY: "Anthropic API key the chat calls Claude with (billed to the owner's Anthropic account)",
  },
  myartifacts: {
    BETTER_AUTH_SECRET: "session signing key, at least 32 characters (openssl rand -hex 32)",
    S3_ACCESS_KEY_ID: "access key id of a Contabo Object Storage key that can read, write and delete in the bucket",
    S3_SECRET_ACCESS_KEY: "secret key paired with S3_ACCESS_KEY_ID",
  },
  sixmonths: {
    BETTER_AUTH_SECRET: "session signing key, at least 32 characters (openssl rand -hex 32)",
    GEMINI_API_KEY:
      "Gemini API key for personal story videos and admin content generation (billed to the owner's Google account, paid tier)",
    ANTHROPIC_API_KEY:
      "Anthropic API key that screens each personal photo and polishes video prompts (billed to the owner's Anthropic account)",
  },
};

/**
 * Required secrets that may be deferred with PREFLIGHT_DEFER_SECRETS=NAME,NAME, and what the app
 * does without them. A deferred missing secret is a warning instead of a blocking issue.
 */
const DEFERRABLE_SECRETS = {
  sixmonths: {
    GEMINI_API_KEY: "cards, coloring, sounds, album and PDF export work; personal videos and AI content generation stay off",
    ANTHROPIC_API_KEY:
      "personal photos are not screened and video prompts stay as the fixed templates; everything else works",
  },
  tower: { ANTHROPIC_API_KEY: "the chat cannot answer until it is set; the dashboard and Control work without it" },
  imagefactory: {},
  puzzle: {
    WARRIORPLUS_IPN_KEY: "every WarriorPlus IPN is refused with 401, so no purchase is granted",
    WARRIORPLUS_API_KEY: "sale verification and the daily reconciliation are skipped",
  },
};

/** Settings needed before launch but not to run: a warning names each group that is missing. */
const LAUNCH_SETTINGS = {
  forum: [
    {
      anyOf: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
      consequence: "Google one-click sign-in is unavailable; magic links still work",
    },
    {
      anyOf: ["INDEXNOW_KEY"],
      consequence: "approved posts are not pushed to IndexNow",
    },
  ],
  tower: [
    { anyOf: ["OPENAI_API_KEY"], consequence: "GPT models are not offered in the chat" },
    { anyOf: ["STALKCHAIN_API_KEY"], consequence: "the chat's StalkChain on-chain tools are hidden" },
    { anyOf: ["FX_DATA_API_KEY"], consequence: "the chat's forex candle tool is hidden" },
  ],
  puzzle: [
    {
      anyOf: ["ANTHROPIC_API_KEY", "OWN_LLM_URL", "OPENROUTER_API_KEY"],
      consequence: "Pro AI theme suggestions are unavailable",
    },
    {
      anyOf: ["PLATFORM_BRIDGE_TOKEN"],
      consequence: "OTO2 TemplateDesign credit grants stay queued (and retry) until it is set",
    },
  ],
};

/** Optional secrets: set together or not at all. */
const SECRET_PAIRS = {
  puzzle: [["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]],
  imagefactory: [["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]],
  forum: [["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]],
  myartifacts: [["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]],
};

/** Vars that must point at the app's own public origin. */
const ORIGIN_VARS = {
  puzzle: ["APP_ORIGIN", "BETTER_AUTH_URL"],
  imagefactory: ["APP_ORIGIN", "BETTER_AUTH_URL"],
  forum: ["PUBLIC_ORIGIN", "APP_ORIGIN", "BETTER_AUTH_URL"],
  tower: ["PUBLIC_ORIGIN", "APP_ORIGIN", "BETTER_AUTH_URL"],
  myartifacts: ["APP_ORIGIN", "BETTER_AUTH_URL"],
};

/** Read the deployed secret names with Wrangler. Returns { names } or { problem }. */
function listSecretNames(appDir) {
  const result = spawnSync("npx", ["wrangler", "secret", "list", "--format", "json"], {
    cwd: appDir,
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", NO_COLOR: "1", FORCE_COLOR: "0" },
  });
  const output = `${result.stdout ?? ""}`;
  const start = output.indexOf("[");
  if (result.status === 0 && start !== -1) {
    try {
      const names = JSON.parse(output.slice(start)).map((entry) => entry.name);
      return { names: new Set(names) };
    } catch {
      // Fall through to the problem report below.
    }
  }
  const text = `${result.stdout ?? ""}${result.stderr ?? ""}`.replace(/\u001b\[[0-9;]*m/g, "");
  if (/does not exist|not found|10007/i.test(text)) {
    return { problem: "the Worker does not exist yet; the first `wrangler secret put` creates it" };
  }
  if (/not logged in|wrangler login|CLOUDFLARE_API_TOKEN|non-interactive/i.test(text)) {
    return { problem: "Wrangler is not logged in (run `npx wrangler login`)" };
  }
  if (result.error) return { problem: `wrangler could not run: ${result.error.message}` };
  const line = text.split("\n").map((entry) => entry.trim()).find((entry) => /error|✘/i.test(entry));
  return { problem: `wrangler secret list failed${line ? `: ${line.replace(/^[✘▲\s]+/, "")}` : ""}` };
}

/** The `wso_fe`-style keys the generator writes before the real WarriorPlus ids are known. */
function placeholderProductIds(appDir) {
  const file = join(appDir, "src/lib/products.ts");
  if (!existsSync(file)) return [];
  const text = readFileSync(file, "utf8");
  return [...text.matchAll(/^\s*(wso_(?:fe|bump|oto\d(?:_ds)?|club)):/gm)].map((match) => match[1]);
}

function appPath(name) {
  return name.includes("/") ? resolve(name) : join(root, "apps", name);
}

function checkApp(appDir, { plan = false } = {}) {
  const name = basename(appDir);
  const results = [];
  const add = (level, code, message) => results.push({ level, code, message });
  const fail = (code, message) => add("error", code, message);
  const warn = (code, message) => add("warning", code, message);
  const pass = (code, message) => add("ok", code, message);
  const commands = [];

  const wranglerPath = join(appDir, "wrangler.jsonc");
  const packagePath = join(appDir, "package.json");
  if (!existsSync(wranglerPath)) {
    fail("wrangler_missing", `${wranglerPath} is missing.`);
    return { name, results, commands, ok: false };
  }
  if (!existsSync(packagePath)) {
    fail("package_missing", `${packagePath} is missing.`);
    return { name, results, commands, ok: false };
  }

  let config;
  try {
    config = parseJsonc(readFileSync(wranglerPath, "utf8"));
  } catch (error) {
    fail("wrangler_invalid", `wrangler.jsonc is not valid JSONC: ${error.message}`);
    return { name, results, commands, ok: false };
  }

  let pkg;
  try {
    pkg = JSON.parse(readFileSync(packagePath, "utf8"));
  } catch (error) {
    fail("package_invalid", `package.json is not valid JSON: ${error.message}`);
    return { name, results, commands, ok: false };
  }

  const packageName = pkg.name ?? "";
  if (packageName !== `@templatedesign/${name}`) {
    warn("package_name", `package name is ${packageName || "(missing)"}; expected @templatedesign/${name}.`);
  } else {
    pass("package_name", packageName);
  }
  for (const script of ["dev", "build", "check", "test"]) {
    if (!pkg.scripts?.[script]) warn("package_script", `package.json has no "${script}" script.`);
  }

  // D1: one database per app, bound as DB.
  const d1 = (config.d1_databases ?? []).find((entry) => entry.binding === "DB") ?? config.d1_databases?.[0];
  if (!d1?.database_name) {
    fail("d1_missing", "wrangler.jsonc has no d1_databases entry bound to DB.");
  } else if (isPlaceholder(d1.database_id)) {
    fail(
      "d1_placeholder",
      `d1_databases[0].database_id is still a placeholder — run "node scripts/provision-app.mjs ${name}" (dry run, then --apply), or "npx wrangler d1 create ${d1.database_name}" in ${appDir} and paste the id.`,
    );
    commands.push(`npx wrangler d1 create ${d1.database_name}`);
  } else {
    pass("d1", `DB → ${d1.database_name} (${d1.database_id})`);
  }

  // Better Auth sessions live in the SESSION KV namespace.
  const kv = (config.kv_namespaces ?? []).find((entry) => entry.binding === "SESSION") ?? config.kv_namespaces?.[0];
  if (!kv) {
    fail("kv_missing", "wrangler.jsonc has no kv_namespaces entry bound to SESSION.");
  } else if (isPlaceholder(kv.id)) {
    fail(
      "kv_placeholder",
      `kv_namespaces[0].id is still a placeholder — run "node scripts/provision-app.mjs ${name}" (dry run, then --apply), or "npx wrangler kv namespace create ${config.name}-session" in ${appDir} and paste the id.`,
    );
    commands.push(`npx wrangler kv namespace create ${config.name}-session`);
  } else {
    pass("kv", "SESSION KV namespace configured");
  }

  // R2 bindings the app actually reads.
  const buckets = (config.r2_buckets ?? []).map((bucket) => bucket.binding);
  const requiredBuckets = REQUIRED_BUCKETS[name] ?? [];
  const missingBuckets = requiredBuckets.filter((binding) => !buckets.includes(binding));
  if (requiredBuckets.length > 0 && missingBuckets.length > 0) {
    fail("r2_missing", `r2_buckets must bind ${missingBuckets.join(", ")}.`);
  } else if (buckets.length === 0 && S3_VARS[name]) {
    pass("r2", "no R2 bucket: files live in the S3-compatible store configured by vars.S3_*");
  } else if (buckets.length === 0) {
    warn("r2", "no R2 bucket bound; confirm the app does not store media.");
  } else {
    pass("r2", `bound ${buckets.join(", ")}`);
  }
  for (const bucket of config.r2_buckets ?? []) {
    if (!bucket.bucket_name) {
      fail("r2_name", `r2 binding ${bucket.binding} has no bucket_name.`);
      continue;
    }
    commands.push(`npx wrangler r2 bucket create ${bucket.bucket_name}`);
  }

  // Cron sweeps own retention and retries in every app of this monorepo.
  if (!config.triggers?.crons?.length) {
    fail("crons", "triggers.crons is empty; retention, retries and lease recovery depend on it.");
  } else {
    pass("crons", `crons: ${config.triggers.crons.join(", ")}`);
  }

  // Custom domain or route that the smoke test can reach.
  const route = config.routes?.[0]?.pattern ?? "";
  if (!route && name === "tower") {
    warn("route_missing", "no custom domain yet (tower runs on workers.dev until the cutover); deploy with APP_URL set so the smoke test finds it.");
  } else if (!route) {
    fail("route_missing", "wrangler.jsonc has no routes entry; the deploy smoke test cannot find the app.");
  } else if (config.routes?.[0]?.custom_domain !== true) {
    warn("route", `route ${route} is not a custom_domain; confirm DNS before deploying.`);
  } else {
    pass("route", `https://${String(route).replace(/\/.*$/, "")}`);
  }

  // Queue producers and consumers must describe the same queues.
  const producers = config.queues?.producers ?? [];
  const consumers = config.queues?.consumers ?? [];
  const consumerQueues = new Set(consumers.map((consumer) => consumer.queue));
  for (const producer of producers) {
    if (!consumerQueues.has(producer.queue)) {
      warn("queue_consumer", `queue ${producer.queue} has a producer but no consumer in this config.`);
    }
    commands.push(`npx wrangler queues create ${producer.queue}`);
  }
  for (const consumer of consumers) {
    if (!consumerQueues.has(consumer.queue)) continue;
    if (!consumer.dead_letter_queue) {
      warn("queue_dlq", `queue ${consumer.queue} has no dead_letter_queue.`);
    } else if (consumer.dead_letter_queue === consumer.queue) {
      fail("queue_dlq", `queue ${consumer.queue} cannot be its own dead-letter queue.`);
    } else {
      commands.push(`npx wrangler queues create ${consumer.dead_letter_queue}`);
    }
  }
  if (producers.length > 0 || consumers.length > 0) {
    pass("queues", `${producers.length} producer(s), ${consumers.length} consumer(s)`);
  }

  // Durable Object bindings need a migration that declares the class.
  const declaredClasses = new Set(
    (config.migrations ?? []).flatMap((migration) => [
      ...(migration.new_classes ?? []),
      ...(migration.new_sqlite_classes ?? []),
    ]),
  );
  for (const binding of config.durable_objects?.bindings ?? []) {
    if (!binding.class_name) {
      fail("do_binding", `durable object binding ${binding.name} has no class_name.`);
    } else if (!declaredClasses.has(binding.class_name)) {
      fail("do_migration", `durable object class ${binding.class_name} is not declared in wrangler migrations.`);
    } else {
      pass("durable_object", `${binding.name} → ${binding.class_name}`);
    }
  }

  // Composed migrations must match their sources.
  const compose = spawnSync(
    process.execPath,
    [join(root, "packages/platform/scripts/compose-migrations.mjs"), appDir, "--check"],
    { encoding: "utf8" },
  );
  if (compose.status === 0) {
    pass("migrations", "composed migrations are current");
  } else {
    const output = `${compose.stdout ?? ""}${compose.stderr ?? ""}`.trim();
    fail("migrations", `compose-migrations --check failed: ${output || compose.error?.message || "unknown error"}`);
  }

  // The ERP embeds its Durable Object schema as a generated artifact.
  if (name === "erp") {
    const artifact = spawnSync(process.execPath, [join(appDir, "scripts/accounting-artifact.mjs"), "--check"], {
      encoding: "utf8",
    });
    if (artifact.status === 0) {
      pass("accounting_artifact", "embedded accounting migrations are current");
    } else {
      const output = `${artifact.stdout ?? ""}${artifact.stderr ?? ""}`.trim();
      fail(
        "accounting_artifact",
        `accounting artifact is stale: ${output || "run `npm run accounting:artifact -w @templatedesign/erp`"}`,
      );
    }
  }

  // Secrets and vars cannot be read offline; print the checklist instead of pretending to verify it.
  const secretHints = ["BETTER_AUTH_SECRET", "EMAIL_FROM", "EMAIL_PROVIDER", ...(SECRET_HINTS[name] ?? [])];
  if (process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_SECRET.length < 32) {
    fail("auth_secret", "BETTER_AUTH_SECRET in this shell is shorter than 32 characters.");
  }
  if (name === "puzzle") {
    if (config.vars?.EMAIL_PROVIDER !== "cloudflare") {
      fail("email_provider", "puzzle must set vars.EMAIL_PROVIDER to cloudflare.");
    }
    if (!(config.send_email ?? []).some((entry) => entry.name === "EMAIL")) {
      fail("email_binding", "puzzle must bind send_email as EMAIL.");
    }
    if (!config.version_metadata?.binding) {
      fail("version_metadata", "puzzle must bind version_metadata so log lines carry the canary version id.");
    }
  }
  if (name === "forum") {
    if (config.vars?.EMAIL_PROVIDER !== "cloudflare") {
      fail("email_provider", "forum must set vars.EMAIL_PROVIDER to cloudflare.");
    }
    if (!(config.send_email ?? []).some((entry) => entry.name === "EMAIL")) {
      fail("email_binding", "forum must bind send_email as EMAIL.");
    }
    if (!config.vars?.TURNSTILE_SITE_KEY) {
      warn(
        "turnstile_site_key",
        "vars.TURNSTILE_SITE_KEY is unset, so the Turnstile widget never renders and the server check is skipped. Set it (and the TURNSTILE_SECRET) before launch.",
      );
    }
  }
  if (name === "tower") {
    if (config.vars?.EMAIL_PROVIDER !== "cloudflare") {
      fail("email_provider", "tower must set vars.EMAIL_PROVIDER to cloudflare.");
    }
    if (!(config.send_email ?? []).some((entry) => entry.name === "EMAIL")) {
      fail("email_binding", "tower must bind send_email as EMAIL.");
    }
    if (!String(config.vars?.OWNER_EMAILS ?? "").includes("@")) {
      fail("owner_emails", "vars.OWNER_EMAILS is empty, so nobody can sign in. Set the owner's address(es), comma separated.");
    }
    if (!config.ai?.binding) fail("ai_binding", 'tower must bind Workers AI as "AI" (document embeddings).');
    if (!(config.vectorize ?? []).some((entry) => entry.binding === "VECTORS" && entry.index_name)) {
      fail("vectorize_binding", 'tower must bind a Vectorize index as "VECTORS" (document search).');
    }
  }
  if (name === "myartifacts") {
    if (config.vars?.EMAIL_PROVIDER !== "cloudflare") {
      fail("email_provider", "myartifacts must set vars.EMAIL_PROVIDER to cloudflare.");
    }
    if (!(config.send_email ?? []).some((entry) => entry.name === "EMAIL")) {
      fail("email_binding", "myartifacts must bind send_email as EMAIL.");
    }
    if (!String(config.vars?.OWNER_EMAILS ?? "").includes("@")) {
      fail("owner_emails", "vars.OWNER_EMAILS is empty, so nobody can sign in or connect. Set the owner's address(es), comma separated.");
    }
  }
  for (const variable of S3_VARS[name] ?? []) {
    if (!config.vars?.[variable]) fail("s3_var", `vars.${variable} is not set; it locates the object store.`);
  }
  if (S3_VARS[name] && config.vars?.S3_ENDPOINT && !/^https:\/\/[^/]+$/.test(String(config.vars.S3_ENDPOINT))) {
    fail("s3_endpoint", "vars.S3_ENDPOINT must be an https origin with no path, for example https://usc1.contabostorage.com.");
  }
  const route0 = String(config.routes?.[0]?.pattern ?? "").replace(/\/.*$/, "");
  for (const variable of ORIGIN_VARS[name] ?? []) {
    const value = config.vars?.[variable];
    if (!value) {
      fail("var_missing", `vars.${variable} is not set; it must be https://${route0}.`);
    } else if (route0 && value !== `https://${route0}`) {
      fail("var_origin", `vars.${variable} is ${value}; it must be https://${route0}.`);
    }
  }
  const placeholders = placeholderProductIds(appDir);
  if (placeholders.length > 0) {
    warn(
      "warriorplus_products",
      `${placeholders.length} WarriorPlus product id(s) are still placeholders (${placeholders.join(", ")}); ` +
        "real IPNs will not map to a product until src/lib/products.ts uses the ids from provider-facts.md.",
    );
  }
  if (process.env.WARRIORPLUS_ACCEPT_TEST_KEY) {
    fail(
      "warriorplus_test_key_retired",
      "WARRIORPLUS_ACCEPT_TEST_KEY is retired and must never be set; Send Test works only inside an admin test window.",
    );
  }
  const required = REQUIRED_SECRETS[name];
  if (!required) {
    pass("secrets", `confirm with \`npx wrangler secret list\`: ${secretHints.join(", ")}`);
  } else {
    const listed = listSecretNames(appDir);
    const deferrable = DEFERRABLE_SECRETS[name] ?? {};
    const deferred = new Set(
      (process.env.PREFLIGHT_DEFER_SECRETS ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    );
    for (const secret of deferred) {
      if (!deferrable[secret]) {
        fail("secret_defer", `${secret} cannot be deferred; only ${Object.keys(deferrable).join(", ") || "none"} can.`);
      }
    }
    for (const [secret, purpose] of Object.entries(required)) {
      const how = `set it with: cd apps/${name} && npx wrangler secret put ${secret}`;
      const isDeferred = deferred.has(secret) && deferrable[secret];
      if (!listed.problem && listed.names.has(secret)) {
        pass("secret", `${secret} is set`);
      } else if (isDeferred) {
        warn("secret_deferred", `${secret} is deferred and not set: ${deferrable[secret]}. Before launch, ${how}.`);
      } else if (listed.problem) {
        fail("secret_unconfirmed", `${secret} could not be confirmed (${listed.problem}). It is the ${purpose}; ${how}.`);
      } else {
        fail("secret_missing", `${secret} is not set on the ${config.name} Worker. It is the ${purpose}; ${how}.`);
      }
    }
    if (!listed.problem) {
      for (const setting of LAUNCH_SETTINGS[name] ?? []) {
        const present = setting.anyOf.some((key) => listed.names.has(key) || config.vars?.[key]);
        if (!present) {
          warn("launch_setting", `${setting.anyOf.join(" or ")} is not set: ${setting.consequence}. Set it before launch.`);
        }
      }
      for (const pair of SECRET_PAIRS[name] ?? []) {
        const present = pair.filter((secret) => listed.names.has(secret));
        if (present.length > 0 && present.length < pair.length) {
          fail("secret_pair", `set ${pair.join(" and ")} together or not at all; only ${present.join(", ")} is set.`);
        }
      }
      if (listed.names.has("WARRIORPLUS_ACCEPT_TEST_KEY")) {
        fail("warriorplus_test_key_retired", "WARRIORPLUS_ACCEPT_TEST_KEY is set on the Worker; delete it with `npx wrangler secret delete WARRIORPLUS_ACCEPT_TEST_KEY`.");
      }
    }
  }

  const errors = results.filter((entry) => entry.level === "error");
  const hasPlaceholder = errors.some((entry) => entry.code.endsWith("_placeholder"));
  if (plan || hasPlaceholder) {
    const unique = [...new Set(commands)];
    if (unique.length > 0) {
      commands.length = 0;
      commands.push(
        `cd ${appDir}`,
        ...unique,
        "# paste the returned ids into wrangler.jsonc, then run:",
        ...(REQUIRED_SECRETS[name]
          ? Object.keys(REQUIRED_SECRETS[name]).map((secret) => `npx wrangler secret put ${secret}`)
          : []),
        "npx wrangler secret list",
      );
    }
  }

  return { name, results, commands, ok: errors.length === 0, showPlan: plan || hasPlaceholder };
}

function printReport(report) {
  console.log(`\n${report.name}`);
  for (const entry of report.results) {
    const marker = entry.level === "error" ? "✗" : entry.level === "warning" ? "!" : "✓";
    console.log(`  ${marker} ${entry.code}: ${entry.message}`);
  }
  if (report.showPlan && report.commands.length > 0) {
    console.log("\n  Provisioning commands:");
    for (const command of report.commands) console.log(`    ${command}`);
  }
  const errors = report.results.filter((entry) => entry.level === "error").length;
  const warnings = report.results.filter((entry) => entry.level === "warning").length;
  console.log(`  ${errors === 0 ? "ready" : `${errors} blocking issue(s)`}${warnings ? `, ${warnings} warning(s)` : ""}`);
}

/** Apps such as TranscriptAnything ship a deeper preflight of their own; use it when present. */
function ownPreflight(appDir) {
  try {
    const pkg = JSON.parse(readFileSync(join(appDir, "package.json"), "utf8"));
    if (pkg.scripts?.preflight) return { name: pkg.name, script: pkg.scripts.preflight };
  } catch {
    // Missing package.json is reported by checkApp below.
  }
  return null;
}

function footer() {
  console.log(
    "\nNot checked here (needs Cloudflare/dashboard access):\n" +
      "  - Cloudflare resources actually exist (D1, KV, R2, queues, Durable Objects)\n" +
      "  - D1 migrations applied remotely\n" +
      "  - Worker secrets uploaded (`wrangler secret list`)\n" +
      "  - DNS, custom domain, WAF and email sender verification",
  );
}

const args = process.argv.slice(2);
const json = args.includes("--json");
const plan = args.includes("--plan");
const all = args.includes("--all");
const targets = args.filter((arg) => !arg.startsWith("-"));

const apps = all
  ? readdirSync(join(root, "apps"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(root, "apps", entry.name, "wrangler.jsonc")))
      .map((entry) => entry.name)
      .sort()
  : targets;

if (apps.length === 0) {
  console.error("usage: node scripts/preflight-app.mjs <app|path> [--plan] [--json] | --all");
  process.exit(2);
}

const reports = [];
let ok = true;

if (all) {
  for (const app of apps) {
    const dir = appPath(app);
    const own = ownPreflight(dir);
    if (!own) {
      const report = checkApp(dir, { plan });
      reports.push(report);
      if (!report.ok) ok = false;
      if (!json) printReport(report);
      continue;
    }
    if (!json) console.log(`\n${app} (app-specific preflight: ${own.name})`);
    const result = spawnSync("npm", ["run", "--silent", "preflight", "-w", own.name], {
      cwd: root,
      encoding: json ? "utf8" : undefined,
      stdio: json ? "pipe" : "inherit",
    });
    const passed = result.status === 0;
    if (!passed) ok = false;
    reports.push({ name: app, delegated: true, ok: passed, output: json ? `${result.stdout ?? ""}${result.stderr ?? ""}` : undefined });
  }
} else {
  for (const app of apps) {
    const report = checkApp(appPath(app), { plan });
    reports.push(report);
    if (!report.ok) ok = false;
    if (!json) printReport(report);
  }
}

if (json) {
  console.log(JSON.stringify({ ok, reports }, null, 2));
} else if (all) {
  console.log(`\n${ok ? "Ready for the next deploy step." : "One or more apps have blocking issues."}`);
  footer();
} else {
  footer();
}

process.exit(ok ? 0 : 1);
