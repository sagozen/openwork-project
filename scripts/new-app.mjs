#!/usr/bin/env node
/**
 * Generates `apps/<name>`: an Astro 7 SSR app on Cloudflare Workers that shares
 * `@templatedesign/platform`, modelled on `apps/transcript`.
 *
 *   npm run new-app -- <name> [--host <name>.zhst.app] [--workspaces]
 *
 * `--workspaces` opts the app into the platform `workspaces` migration module (subpath tenants).
 * The generated D1/KV ids are placeholders: create the real resources with wrangler and paste the
 * ids into `wrangler.jsonc` before the first deploy.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const name = args.find((value, index) => !value.startsWith("--") && args[index - 1] !== "--host");
if (!name || !/^[a-z][a-z0-9-]{1,30}$/.test(name)) {
  console.error("Usage: npm run new-app -- <name> [--host <host>] [--workspaces]\nname: lowercase letters, digits, dashes.");
  process.exit(2);
}

const appDir = join(root, "apps", name);
if (existsSync(appDir)) {
  console.error(`apps/${name} already exists.`);
  process.exit(1);
}

const host = option("host") ?? `${name}.zhst.app`;
const withWorkspaces = flag("workspaces");
const title = name.replace(/(^|-)([a-z])/g, (_match, _sep, letter) => ` ${letter.toUpperCase()}`).trim();
const snake = name.replace(/-/g, "_");

function nextPort() {
  const used = new Set();
  for (const app of readdirSync(join(root, "apps"))) {
    const config = join(root, "apps", app, "astro.config.mjs");
    if (!existsSync(config)) continue;
    const match = readFileSync(config, "utf8").match(/port:\s*(\d+)/);
    if (match) used.add(Number(match[1]));
  }
  let port = 4330;
  while (used.has(port)) port += 1;
  return port;
}
const port = nextPort();

const files = {
  "package.json": `${JSON.stringify(
    {
      name: `@templatedesign/${name}`,
      version: "0.1.0",
      private: true,
      type: "module",
      description: `${title} on the shared platform`,
      scripts: {
        dev: "astro dev",
        build: "astro build",
        preview: "astro preview",
        check: "astro check",
        typecheck: "astro check",
        test: "tsx --test --test-concurrency=1 tests/*.test.ts",
        "compose:migrations": "node ../../packages/platform/scripts/compose-migrations.mjs .",
        "db:migrate:local": "wrangler d1 migrations apply DB --local",
        predev: "node ../../packages/tokens/scripts/build.mjs && node ../../packages/platform/scripts/compose-migrations.mjs .",
        prebuild: "node ../../packages/tokens/scripts/build.mjs && node ../../packages/platform/scripts/compose-migrations.mjs .",
        precheck: "node ../../packages/tokens/scripts/build.mjs && node ../../packages/platform/scripts/compose-migrations.mjs . --check",
        pretypecheck: "node ../../packages/tokens/scripts/build.mjs && node ../../packages/platform/scripts/compose-migrations.mjs . --check",
        pretest: "node ../../packages/platform/scripts/compose-migrations.mjs . --check",
      },
      dependencies: {
        "@astrojs/cloudflare": "14.3.3",
        "@astrojs/react": "6.0.0",
        "@templatedesign/contracts": "0.1.0",
        "@templatedesign/platform": "0.1.0",
        "@templatedesign/tokens": "0.1.0",
        "@templatedesign/ui": "0.1.0",
        astro: "7.3.5",
        "better-auth": "1.7.12",
        react: "19.3.1",
        "react-dom": "19.3.1",
      },
      devDependencies: {
        "@astrojs/check": "0.9.10",
        "@cloudflare/workers-types": "5.20261018.1",
        "@types/node": "24.19.2",
        "@types/react": "19.3.0",
        "@types/react-dom": "19.3.0",
        tsx: "4.20.6",
        typescript: "6.0.2",
        wrangler: "4.151.1",
      },
      engines: { node: ">=24.21.0" },
    },
    null,
    2,
  )}\n`,

  "astro.config.mjs": `import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { defineConfig } from "astro/config";

export default defineConfig({
  output: "server",
  site: "https://${host}",
  server: { host: "127.0.0.1", port: ${port} },
  adapter: cloudflare({
    imageService: "passthrough",
    remoteBindings: false,
    persistState: true,
  }),
  integrations: [react()],
  vite: {
    resolve: {
      dedupe: ["react", "react-dom"],
    },
    optimizeDeps: {
      exclude: ["better-auth", "@better-auth/kysely-adapter"],
    },
    ssr: {
      noExternal: ["better-auth"],
    },
  },
});
`,

  "tsconfig.json": `{
  "extends": "astro/tsconfigs/strict",
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "react",
    "types": ["@cloudflare/workers-types", "node"],
    "paths": {
      "@templatedesign/ui": ["../../packages/ui/src/index.ts"],
      "@templatedesign/ui/styles.css": ["../../packages/ui/src/styles/index.css"],
      "@templatedesign/contracts": ["../../packages/contracts/src/index.ts"],
      "@templatedesign/platform/*": ["../../packages/platform/src/*"]
    }
  },
  "include": [".astro/types.d.ts", "**/*.ts", "**/*.tsx", "**/*.astro"],
  "exclude": ["dist", "node_modules"]
}
`,

  "wrangler.jsonc": `{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "${name}-web",
  "main": "./src/worker.ts",
  "compatibility_date": "2026-10-18",
  "compatibility_flags": ["nodejs_compat"],
  "upload_source_maps": true,
  "routes": [{ "pattern": "${host}", "custom_domain": true }],
  "send_email": [{ "name": "EMAIL" }],
  "observability": { "enabled": true },
  "kv_namespaces": [{ "binding": "SESSION", "id": "00000000000000000000000000000000" }],
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "${name}-web",
      "database_id": "00000000-0000-0000-0000-000000000000",
      "migrations_dir": "migrations"
    }
  ],
  "r2_buckets": [{ "binding": "MEDIA", "bucket_name": "${name}-media" }],
  "triggers": { "crons": ["17 3 * * *"] }
}
`,

  "migrations.manifest.json": `${JSON.stringify(
    { frozen: false, output: "migrations", sourcesDir: "migrations.src", ...(withWorkspaces ? { modules: ["workspaces"] } : {}) },
    null,
    2,
  )}\n`,

  [`migrations.src/0100_${snake}.sql`]: `-- ${title}: product tables only. Everything shared (tenants, wallets, ledger, API keys, webhooks,
-- admin) comes from the platform baseline. Business tables carry workspace_id when the app opts
-- into the workspaces module.

CREATE TABLE IF NOT EXISTS ${snake}_notes (
  id text NOT NULL PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  body text NOT NULL,
  created_at text NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_${snake}_notes_tenant ON ${snake}_notes (tenant_id, created_at);
`,

  "src/env.d.ts": `/// <reference types="astro/client" />
/// <reference types="@cloudflare/workers-types" />

import type { AuthSession, AuthUser, Profile } from "@templatedesign/platform/types";
import type { Env } from "./lib/types";

declare global {
  namespace App {
    interface Locals {
      runtime: {
        env: Env;
        cf?: unknown;
        ctx: ExecutionContext;
      };
      user?: AuthUser;
      session?: AuthSession;
      tenantId?: string;
      profile?: Profile;
      csrfToken?: string;
      locale: "en" | "vi";
    }
  }
}
`,

  "src/lib/types.ts": `import type { PlatformEnv } from "@templatedesign/platform/types";

export type { AuthSession, AuthUser, Locale, Profile, RequestContext } from "@templatedesign/platform/types";

/** ${title} bindings = the platform bindings plus the media bucket. */
export interface Env extends PlatformEnv {
  MEDIA: R2Bucket;
}
`,

  "src/lib/runtime.ts": `import { runtimeEnv as runtimeEnvBase, waitUntil } from "@templatedesign/platform/runtime";
import type { Env } from "./types";

/** Cloudflare bindings for the current request, typed with ${title}'s extension. */
export function runtimeEnv(): Env {
  return runtimeEnvBase<Env>();
}

export { waitUntil };
`,

  "src/lib/platform.ts": `import { createPlatform } from "@templatedesign/platform/config";

/** ${title}'s row in the shared platform. Imported by the worker, the middleware and the tests. */
export const platform = createPlatform({
  brand: {
    name: "${title}",
    appOrigin: "https://${host}",
    emailFrom: "${title} <no-reply@${host}>",
    supportEmail: "support@${host}",
  },
  packs: [],
  guestPolicy: {
    dailyCredits: 0,
    exceedingMessage: () => "Sign in to continue.",
    exhaustedMessage: () => "Sign in to continue.",
    signupPath: "/auth/sign-in",
  },
  copy: {
    welcomeBody: {
      en: ["Your ${title} account is ready."],
      vi: ["Tài khoản ${title} của bạn đã sẵn sàng."],
    },
    dataNoun: { en: "your ${title} data", vi: "dữ liệu ${title} của bạn" },
  },
  locales: ["en", "vi"],
  scopes: { available: ["${name}:read", "${name}:write"], default: ["${name}:read"] },
  apiKeyPrefix: "${name.slice(0, 3)}",
  deletion: {
    purgeProductData: async (db, tenantId) => {
      await db.run("DELETE FROM ${snake}_notes WHERE tenant_id = ?", [tenantId]);
    },
  },
});
`,

  "src/worker.ts": `import { handle } from "@astrojs/cloudflare/handler";
import "./lib/platform";
import type { Env } from "./lib/types";

/** Custom Worker entry: the Astro handler plus the daily cron declared in wrangler.jsonc. */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return handle(request, env, ctx);
  },

  async scheduled(controller: ScheduledController, _env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        console.log(JSON.stringify({ evt: "daily_cron", cron: controller.cron }));
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
`,

  "src/pages/index.astro": `---
import "@templatedesign/ui/styles.css";
---

<!doctype html>
<html lang="en" data-theme="light">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
  </head>
  <body>
    <main>
      <h1>${title}</h1>
      <p>Generated by <code>npm run new-app</code>.</p>
    </main>
  </body>
</html>
`,

  "src/pages/api/v1/health.ts": `import { d1Db } from "@templatedesign/platform/db";
import { json } from "@templatedesign/platform/http";
import type { APIRoute } from "astro";
import { runtimeEnv } from "../../../lib/runtime";

export const GET: APIRoute = async () => {
  try {
    await d1Db(runtimeEnv().DB).first("SELECT 1 AS ok");
    return json({ status: "ok" });
  } catch {
    return json({ status: "degraded" }, { status: 503 });
  }
};
`,

  "tests/support/db.ts": readFileSync(join(root, "apps", "transcript", "tests", "support", "db.ts"), "utf8").replace(
    "platform baseline + transcript tables",
    "platform baseline + app tables",
  ),

  "tests/smoke.test.ts": `import assert from "node:assert/strict";
import { test } from "node:test";
import { platformConfig } from "@templatedesign/platform/config";
import "../src/lib/platform";
import { createTestDb } from "./support/db";

test("the composed migrations load and the app table accepts a row", async () => {
  const { db, close } = createTestDb();
  try {
    await db.run("INSERT INTO tenants (id, name, created_at) VALUES ('ten_1', 'Acme', '2026-01-01T00:00:00Z')");
    await db.run("INSERT INTO ${snake}_notes (id, tenant_id, body, created_at) VALUES ('n1', 'ten_1', 'hi', '2026-01-01T00:00:00Z')");
    const row = await db.first<{ body: string }>("SELECT body FROM ${snake}_notes WHERE id = 'n1'");
    assert.equal(row?.body, "hi");
  } finally {
    close();
  }
});

test("createPlatform registers this app's brand", () => {
  assert.equal(platformConfig().brand.name, "${title}");
});
`,

  "README.md": `# ${title}

Generated by \`npm run new-app -- ${name}\`.

\`\`\`bash
npm run dev -w @templatedesign/${name}      # http://localhost:${port}
npm run test -w @templatedesign/${name}
\`\`\`

Before the first deploy create the real resources and paste their ids into \`wrangler.jsonc\`:

\`\`\`bash
npx wrangler d1 create ${name}-web
npx wrangler kv namespace create SESSION
npx wrangler r2 bucket create ${name}-media
\`\`\`

Edit \`migrations.src/\` and run \`npm run compose:migrations\`; never edit \`migrations/\` by hand.
Deploy with \`./deploy-cf.sh ${name}\`; it runs the shared preflight, which blocks a deploy while the
D1/KV ids above are still placeholders.
`,
};

if (withWorkspaces) {
  // --- Subpath workspaces: swap the single-tenant bits for the app-shell wiring. -------------
  const pkg = JSON.parse(files["package.json"]);
  pkg.dependencies["@templatedesign/app-shell"] = "0.1.0";
  files["package.json"] = `${JSON.stringify(pkg, null, 2)}\n`;

  files["astro.config.mjs"] = files["astro.config.mjs"]
    .replace('import react from "@astrojs/react";', 'import appShell from "@templatedesign/app-shell/integration";\nimport react from "@astrojs/react";')
    .replace("integrations: [react()]", "integrations: [react(), appShell()]");

  files["tsconfig.json"] = files["tsconfig.json"].replace(
    '"@templatedesign/platform/*": ["../../packages/platform/src/*"]',
    '"@templatedesign/platform/*": ["../../packages/platform/src/*"],\n      "@templatedesign/app-shell/*": ["../../packages/app-shell/src/*"]',
  );

  files["src/env.d.ts"] = `/// <reference types="astro/client" />
/// <reference types="@cloudflare/workers-types" />

import type { ShellLocals } from "@templatedesign/app-shell/types";
import type { AuthSession, AuthUser, Profile } from "@templatedesign/platform/types";

declare global {
  namespace App {
    interface Locals extends ShellLocals {
      user?: AuthUser;
      session?: AuthSession;
      tenantId?: string;
      profile?: Profile;
      csrfToken?: string;
      locale: "en" | "vi";
    }
  }
}
`;

  files["src/lib/platform.ts"] = files["src/lib/platform.ts"]
    .replace(
      "  packs: [],",
      `  appId: "${name}",
  plans: {
    free: { name: "Free", entitlements: { notes: 50, "brand.logo": true } },
    pro: { name: "Pro", priceCredits: 500, periodDays: 30, entitlements: { notes: -1, "brand.logo": true } },
  },
  // Top-level pages of this app that a workspace slug must never shadow.
  reservedSlugs: ["privacy", "terms"],
  packs: [
    { id: "credits-500", name: { en: "500 credits", vi: "500 credit" }, priceCents: 500, credits: 500, featured: true },
    { id: "credits-2500", name: { en: "2,500 credits", vi: "2.500 credit" }, priceCents: 2000, credits: 2500 },
  ],`,
    )
    .replace(
      `await db.run("DELETE FROM ${snake}_notes WHERE tenant_id = ?", [tenantId]);`,
      `await db.run(
        "DELETE FROM ${snake}_notes WHERE workspace_id IN (SELECT id FROM workspaces WHERE tenant_id = ?)", // unscoped-ok: account deletion spans the tenant's workspaces
        [tenantId],
      );`,
    );

  files[`migrations.src/0100_${snake}.sql`] = `-- ${title}: product tables only. Everything shared (tenants, wallets, ledger, API keys, webhooks,
-- admin, workspaces) comes from the platform baseline and the workspaces module. Every business
-- table carries workspace_id and an index that starts with it.

CREATE TABLE IF NOT EXISTS ${snake}_notes (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id text NOT NULL,
  body text NOT NULL,
  created_at text NOT NULL,
  PRIMARY KEY (workspace_id, id)
);

CREATE INDEX IF NOT EXISTS idx_${snake}_notes_ws_created ON ${snake}_notes (workspace_id, created_at);
`;

  files["src/middleware.ts"] = `import { defineMiddleware, sequence } from "astro:middleware";
import { createShellMiddleware } from "@templatedesign/app-shell/middleware";
import { createAuth, getSessionContext } from "@templatedesign/platform/auth";
import { CSRF_COOKIE, createCsrfToken, LOCALE_COOKIE, parseCookies } from "@templatedesign/platform/csrf";
import "./lib/platform";
import { runtimeEnv } from "./lib/runtime";

/** Session, locale and the CSRF cookie. The shell middleware below resolves the workspace. */
const session = defineMiddleware(async (context, next) => {
  const env = runtimeEnv();
  const path = context.url.pathname;
  const cookies = parseCookies(context.request.headers.get("cookie"));
  context.locals.locale = cookies[LOCALE_COOKIE] === "vi" ? "vi" : "en";

  let csrfToken = cookies[CSRF_COOKIE];
  if (!csrfToken) {
    csrfToken = createCsrfToken();
    context.cookies.set(CSRF_COOKIE, csrfToken, {
      path: "/",
      sameSite: "lax",
      httpOnly: false,
      secure: context.url.protocol === "https:",
      maxAge: 60 * 60 * 24,
    });
  }
  context.locals.csrfToken = csrfToken;

  if (path.startsWith("/api/auth") || path.startsWith("/_astro/") || path.startsWith("/brand/")) return next();

  const found = await getSessionContext(createAuth(env), env, context.request);
  if (found) {
    context.locals.user = found.user;
    context.locals.session = found.session;
    context.locals.tenantId = found.tenantId;
    context.locals.profile = found.profile;
    context.locals.locale = found.profile.uiLanguage;
  }
  return next();
});

export const onRequest = sequence(session, createShellMiddleware());
`;

  delete files["tests/smoke.test.ts"];

  files["src/worker.ts"] = `import { handle } from "@astrojs/cloudflare/handler";
import { d1Db } from "@templatedesign/platform/db";
import { expireWorkspacePlans } from "@templatedesign/platform/workspaces";
import "./lib/platform";
import type { Env } from "./lib/types";

/** Custom Worker entry: the Astro handler plus the daily cron declared in wrangler.jsonc. */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return handle(request, env, ctx);
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        const expired = await expireWorkspacePlans(d1Db(env.DB));
        console.log(JSON.stringify({ evt: "daily_cron", cron: controller.cron, expiredPlans: expired }));
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
`;

  Object.assign(files, {
    "src/pages/api/auth/[...all].ts": `import { createAuth } from "@templatedesign/platform/auth";
import type { APIRoute } from "astro";
import { runtimeEnv } from "../../../lib/runtime";

export const ALL: APIRoute = async ({ request }) => createAuth(runtimeEnv()).handler(request);
`,
    "src/pages/auth/sign-in.astro": `---
const next = Astro.url.searchParams.get("next") ?? "/app";
const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/app";
if (Astro.locals.user) return Astro.redirect(safeNext);
---

<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>Sign in · ${title}</title>
  </head>
  <body style="font:15px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0">
    <form id="form" data-next={safeNext} style="display:grid;gap:12px;width:min(360px,90vw)">
      <h1 style="font-size:20px;margin:0">Sign in to ${title}</h1>
      <input name="email" type="email" placeholder="you@example.com" required style="padding:10px" />
      <button type="submit" style="padding:10px">Email me a sign-in link</button>
      <p id="status" role="status" style="margin:0;color:#78716c"></p>
    </form>
    <script>
      const form = document.getElementById("form") as HTMLFormElement;
      const status = document.getElementById("status") as HTMLElement;
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const email = String(new FormData(form).get("email"));
        const response = await fetch("/api/auth/sign-in/magic-link", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, callbackURL: form.dataset.next }),
        });
        status.textContent = response.ok ? "Check your email for the link." : "We could not send the link. Try again.";
      });
    </script>
  </body>
</html>
`,
    "src/pages/app.astro": `---
import { d1Db } from "@templatedesign/platform/db";
import { listWorkspacesForUser } from "@templatedesign/platform/workspaces";
import { runtimeEnv } from "../lib/runtime";

const { user } = Astro.locals;
if (!user) return Astro.redirect("/auth/sign-in?next=/app");
const sites = await listWorkspacesForUser(d1Db(runtimeEnv().DB), "${name}", user.id);
if (sites.length === 0) return Astro.redirect("/onboarding");
if (sites.length === 1) return Astro.redirect(\`/\${sites[0].slug}/admin\`);
---

<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><meta name="robots" content="noindex" /><title>Your sites · ${title}</title></head>
  <body style="font:15px/1.5 system-ui,sans-serif;max-width:480px;margin:40px auto;padding:0 16px">
    <h1>Your sites</h1>
    <ul>{sites.map((site) => <li><a href={\`/\${site.slug}/admin\`}>{site.name}</a> ({site.role})</li>)}</ul>
    <p><a href="/onboarding">Create another site</a></p>
  </body>
</html>
`,
    "src/pages/[ws]/index.astro": `---
const { workspace, brand } = Astro.locals;
if (!workspace || !brand) return new Response("Not found", { status: 404 });
const logoUrl = brand.logoKey ? \`/\${brand.logoKey}\` : null;
---

<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{brand.displayName}</title>
  </head>
  <body style="font:16px/1.5 system-ui,sans-serif;max-width:640px;margin:48px auto;padding:0 16px">
    {logoUrl && <img src={logoUrl} alt="" width="72" height="72" style="object-fit:contain" />}
    <h1>{brand.displayName}</h1>
    {workspace.plan === "free" && <p style="color:#78716c;font-size:13px">Powered by ${title}</p>}
  </body>
</html>
`,
    "src/pages/[ws]/admin/index.astro": `---
import AdminLayout from "@templatedesign/app-shell/layouts/AdminLayout.astro";
import { scoped } from "@templatedesign/app-shell/db/scoped";
import { d1Db } from "@templatedesign/platform/db";
import { runtimeEnv } from "../../../lib/runtime";

const { workspace } = Astro.locals;
if (!workspace) return new Response("Not found", { status: 404 });
const as = scoped(d1Db(runtimeEnv().DB), workspace.id);
const notes = await as.all<{ id: string; body: string }>(
  "SELECT id, body FROM ${snake}_notes WHERE workspace_id = :ws ORDER BY created_at DESC LIMIT 50",
);
---

<AdminLayout title="Overview" nav={[{ href: "/admin", label: "Overview" }]} current="/admin">
  <p>{notes.length} notes in this workspace.</p>
  <ul>{notes.map((note) => <li>{note.body}</li>)}</ul>
</AdminLayout>
`,
    "src/lib/notes.ts": `import { scoped } from "@templatedesign/app-shell/db/scoped";
import type { Db } from "@templatedesign/platform/db";
import { id, nowIso } from "@templatedesign/platform/db";
import { requireEntitlement, type Workspace } from "@templatedesign/platform/workspaces";

/** Domain service: every query goes through the scoped helper, so a workspace sees only its rows. */
export async function addNote(db: Db, workspace: Workspace, body: string) {
  const as = scoped(db, workspace.id);
  const count = await as.first<{ count: number }>("SELECT COUNT(*) AS count FROM ${snake}_notes WHERE workspace_id = :ws");
  await requireEntitlement(db, workspace, "notes", { current: count?.count ?? 0 });
  const noteId = id("note");
  await as.insert("${snake}_notes", { id: noteId, body, created_at: nowIso() });
  return noteId;
}

export async function getNote(db: Db, workspaceId: string, noteId: string) {
  return scoped(db, workspaceId).first<{ id: string; body: string }>(
    "SELECT id, body FROM ${snake}_notes WHERE workspace_id = :ws AND id = ?",
    [noteId],
  );
}

export async function deleteNote(db: Db, workspaceId: string, noteId: string) {
  return scoped(db, workspaceId).run("DELETE FROM ${snake}_notes WHERE workspace_id = :ws AND id = ?", [noteId]);
}
`,
    "tests/isolation.test.ts": `import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { scoped } from "@templatedesign/app-shell/db/scoped";
import { runIsolationSuite } from "@templatedesign/app-shell/testing/isolation";
import { findUnscopedSql } from "@templatedesign/app-shell/testing/unscoped-sql";
import { createWorkspace } from "@templatedesign/platform/workspaces";
import "../src/lib/platform";
import { addNote, deleteNote, getNote } from "../src/lib/notes";
import { createTestDb } from "./support/db";

test("workspace A cannot read or change workspace B through any note action", async () => {
  const { db, close } = createTestDb();
  try {
    await runIsolationSuite({
      db,
      app: "${name}",
      seed: async (as, workspace, label) => {
        const noteId = await addNote(db, workspace, \`secret-\${label}-\${workspace.id}\`);
        return { markers: [\`secret-\${label}-\${workspace.id}\`], ids: { notes: [noteId] } };
      },
      actions: [
        { name: "getNote with B's id", run: ({ a, foreign }) => getNote(db, a.id, foreign.ids.notes[0]) },
        { name: "deleteNote with B's id", run: ({ a, foreign }) => deleteNote(db, a.id, foreign.ids.notes[0]) },
        { name: "list notes", run: ({ as }) => as.all("SELECT * FROM ${snake}_notes WHERE workspace_id = :ws") },
      ],
    });
  } finally {
    close();
  }
});

test("the free plan caps notes and a second workspace has its own allowance", async () => {
  const { db, close } = createTestDb();
  try {
    await db.run('INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (\\'u1\\', \\'U\\', \\'u@example.com\\', 1, \\'2026-01-01\\', \\'2026-01-01\\')');
    await db.run("INSERT INTO tenants (id, name, created_at) VALUES ('t1', 'T', '2026-01-01')");
    const one = await createWorkspace(db, { app: "${name}", slug: "site-one", userId: "u1", tenantId: "t1" });
    const two = await createWorkspace(db, { app: "${name}", slug: "site-two", userId: "u1", tenantId: "t1" });
    for (let index = 0; index < 50; index += 1) await addNote(db, one, \`n\${index}\`);
    await assert.rejects(() => addNote(db, one, "one too many"), /plan limit/);
    await addNote(db, two, "still fine");
  } finally {
    close();
  }
});

test("no source file queries a tenant table without the workspace scope", () => {
  assert.deepEqual(findUnscopedSql(join(import.meta.dirname, "..", "src"), ["${snake}_notes"]), []);
});
`,
  });
}

for (const [relative, content] of Object.entries(files)) {
  const target = join(appDir, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}
mkdirSync(join(appDir, "public"), { recursive: true });
writeFileSync(
  join(appDir, "public", "favicon.svg"),
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#2563eb"/></svg>\n',
);

console.log(`✓ apps/${name} created (port ${port}, host ${host})`);
const install = spawnSync("npm", ["install"], { cwd: root, stdio: "inherit" });
if (install.status !== 0) process.exit(install.status ?? 1);
const compose = spawnSync("node", ["packages/platform/scripts/compose-migrations.mjs", `apps/${name}`], {
  cwd: root,
  stdio: "inherit",
});
process.exit(compose.status ?? 0);
