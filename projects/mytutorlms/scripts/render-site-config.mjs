#!/usr/bin/env node
// Writes themes/mytutor/wrangler.<site>.jsonc and a Node environment template
// from deploy/sites/<site>/site.json. Secrets are never written: set them with
// `wrangler secret put` or in the Node host's private environment file.
import { readFileSync, writeFileSync } from "node:fs";

const name = process.argv[2];
if (!name || !/^[a-z0-9-]+$/.test(name)) {
  console.error("Usage: node scripts/render-site-config.mjs <site-id>");
  process.exit(1);
}
const site = JSON.parse(
  readFileSync(
    new URL(`../deploy/sites/${name}/site.json`, import.meta.url),
    "utf8",
  ),
);
const theme = new URL("../themes/mytutor/", import.meta.url);
const cf = site.cloudflare;
writeFileSync(
  new URL(`wrangler.${name}.jsonc`, theme),
  `${JSON.stringify(
    {
      name: cf.workerName,
      main: "./src/worker.ts",
      compatibility_date: "2026-10-13",
      compatibility_flags: ["nodejs_compat"],
      vars: { EMDASH_SITE_URL: site.canonicalOrigin },
      d1_databases: [
        {
          binding: "DB",
          database_name: cf.d1DatabaseName,
          database_id: cf.d1DatabaseId,
        },
      ],
      r2_buckets: [{ binding: "MEDIA", bucket_name: cf.r2Bucket }],
      // UX telemetry for /api/events; omitted until the site names a dataset.
      ...(cf.analyticsDataset
        ? {
            analytics_engine_datasets: [
              { binding: "MYTUTOR_EVENTS", dataset: cf.analyticsDataset },
            ],
          }
        : {}),
      triggers: { crons: ["* * * * *"] },
      observability: { enabled: true, head_sampling_rate: 1 },
    },
    null,
    2,
  )}\n`,
);
const envTemplate = ["", "env", name, "example"].join(".");
writeFileSync(
  new URL(envTemplate, theme),
  [
    `# ${name}: copy to the host's private environment file (mode 0600) and fill the key.`,
    "# Never regenerate EMDASH_ENCRYPTION_KEY for an existing site.",
    "EMDASH_ENCRYPTION_KEY=",
    `EMDASH_SITE_URL=${site.canonicalOrigin}`,
    `MYTUTOR_DATA_DIR=${site.node.dataDir}`,
    "",
  ].join("\n"),
);
console.log(
  `Wrote wrangler.${name}.jsonc and ${envTemplate} in themes/mytutor.`,
);
