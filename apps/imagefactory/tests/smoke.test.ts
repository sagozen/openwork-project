import assert from "node:assert/strict";
import { test } from "node:test";
import { platformConfig } from "@templatedesign/platform/config";
import "../src/lib/platform";
import { createTestDb } from "./support/db";

test("the composed migrations create the image and brand tables, each led by tenant_id", async () => {
  const { db, close } = createTestDb();
  try {
    for (const table of ["image_jobs", "images", "brand_kits", "brand_assets"]) {
      const columns = await db.all<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`);
      assert.ok(
        columns.some((column) => column.name === "tenant_id"),
        `${table} has tenant_id`,
      );
      const indexes = await db.all<{ name: string }>(`SELECT name FROM pragma_index_list('${table}')`);
      const leading = await Promise.all(
        indexes.map((index) =>
          db.first<{ name: string }>(`SELECT name FROM pragma_index_info('${index.name}') WHERE seqno = 0`),
        ),
      );
      assert.ok(
        leading.some((column) => column?.name === "tenant_id"),
        `${table} has an index that starts with tenant_id`,
      );
    }
  } finally {
    close();
  }
});

test("createPlatform registers this app's brand, key prefix and scopes", () => {
  const config = platformConfig();
  assert.equal(config.brand.name, "ImageFactory");
  assert.equal(config.apiKeyPrefix, "if");
  assert.deepEqual(config.scopes.available, ["images:read", "images:write"]);
});
