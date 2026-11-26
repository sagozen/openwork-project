#!/usr/bin/env node
// Fails if two sites share an origin, Worker, database, bucket or data
// directory, or if a site file has a key that looks like a secret. Site files
// are non-secret by design; secrets live in Wrangler secrets or the Node host's
// private environment file.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../deploy/sites/", import.meta.url).pathname;
const SECRET = /(secret|token|password|apikey|api_key|privatekey|encryption)/i;
const problems = [];
const seen = new Map();
const claim = (kind, value, site) => {
  if (!value) return;
  const key = `${kind}:${String(value).toLowerCase()}`;
  if (seen.has(key))
    problems.push(`${site} and ${seen.get(key)} share ${kind} ${value}`);
  else seen.set(key, site);
};
const sites = readdirSync(root).filter((name) =>
  statSync(join(root, name)).isDirectory(),
);
for (const name of sites) {
  const site = JSON.parse(readFileSync(join(root, name, "site.json"), "utf8"));
  if (site.siteId !== name)
    problems.push(`${name}: siteId must equal its folder name`);
  if (!/^https:\/\/[^/]+$/.test(site.canonicalOrigin ?? ""))
    problems.push(
      `${name}: canonicalOrigin must be an https origin without a path`,
    );
  const walk = (value, path) => {
    if (value && typeof value === "object")
      for (const [key, inner] of Object.entries(value)) {
        if (SECRET.test(key))
          problems.push(
            `${name}: ${path}${key} looks like a secret; keep secrets out of site.json`,
          );
        walk(inner, `${path}${key}.`);
      }
  };
  walk(site, "");
  claim("origin", site.canonicalOrigin, name);
  claim("Worker", site.cloudflare?.workerName, name);
  claim("D1 database", site.cloudflare?.d1DatabaseName, name);
  if (
    site.cloudflare?.d1DatabaseId &&
    !/^0{8}-/.test(site.cloudflare.d1DatabaseId)
  )
    claim("D1 database id", site.cloudflare.d1DatabaseId, name);
  claim("R2 bucket", site.cloudflare?.r2Bucket, name);
  claim("analytics dataset", site.cloudflare?.analyticsDataset, name);
  claim("backup bucket", site.cloudflare?.backupBucket, name);
  claim("data directory", site.node?.dataDir, name);
  if (
    site.cloudflare?.r2Bucket &&
    site.cloudflare.r2Bucket === site.cloudflare.backupBucket
  )
    problems.push(`${name}: backups must not share the media bucket`);
}
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`${sites.length} site(s) isolated.`);
