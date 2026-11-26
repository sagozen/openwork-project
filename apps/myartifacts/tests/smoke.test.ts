import assert from "node:assert/strict";
import { test } from "node:test";
import { platformConfig } from "@templatedesign/platform/config";
import "../src/lib/platform";
import { createTestDb } from "./support/db";

test("the composed migrations include the platform baseline and the OAuth module", async () => {
  const { db, close } = createTestDb();
  try {
    const tables = (await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")).map(
      (row) => row.name,
    );
    for (const expected of ["tenants", "api_keys", "oauthClient", "oauthAccessToken", "agent_grants"]) {
      assert.ok(tables.includes(expected), `${expected} exists`);
    }
  } finally {
    close();
  }
});

test("createPlatform registers this app's brand, key prefix, scopes and MCP resource", () => {
  const config = platformConfig();
  assert.equal(config.brand.name, "MyArtifacts");
  assert.equal(config.apiKeyPrefix, "ma");
  assert.deepEqual(config.scopes.available, ["artifacts:read", "artifacts:write"]);
  assert.equal(config.mcp?.resourcePath, "/mcp");
  assert.deepEqual(config.mcp?.scopes, ["artifacts:read", "artifacts:write", "offline_access"]);
});
