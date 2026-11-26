import assert from "node:assert/strict";
import { afterEach, beforeEach, it } from "node:test";
import { OtaService } from "../src/domain/service.js";
import { memoryStore } from "./helpers.js";
import { type OtaFixture, setupOta } from "./support/ota.js";

let fixture: OtaFixture;

beforeEach(async () => {
  fixture = await setupOta();
});
afterEach(() => {
  fixture.close();
});

it("reads a release stored without update metadata as an empty signature and optional, and rejects a bad flag", async () => {
  const createdAt = Date.UTC(2026, 9, 8, 2, 15, 0);
  const file = "bundles/main/1.0.0/20261008-021500.bundle";
  const { db, workspace } = fixture;
  await db.run(
    `INSERT INTO ota_releases (workspace_id, id, app, platform, channel, binary, release_id, file, sha256, size, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      workspace.id,
      "legacy-release",
      "unitel-man",
      "android",
      "main",
      "1.0.0",
      "20261008-021500",
      file,
      "a".repeat(64),
      1,
      createdAt,
    ],
  );
  await db.run(
    "INSERT INTO ota_current (workspace_id, app, platform, channel, binary, release_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [workspace.id, "unitel-man", "android", "main", "1.0.0", "legacy-release", createdAt],
  );
  const stored = await fixture.inspect
    .prepare("SELECT signature, mandatory FROM ota_releases WHERE id = ?")
    .bind("legacy-release")
    .first<{ signature: string; mandatory: number }>();
  assert.deepEqual({ ...stored }, { signature: "", mandatory: 0 });

  const blobs = memoryStore();
  const service = new OtaService({
    db,
    workspace,
    actor: { id: "admin-1", administrator: true },
    blobs: async () => blobs.store,
    now: () => createdAt,
    maxBundleBytes: 1024 * 1024,
    secretKey: null,
    platformAvailable: true,
    baseUrl: "https://ota.test",
  });
  const manifest = await service.manifest("unitel-man", "android");
  assert.equal(manifest.channels.main?.["1.0.0"]?.signature, "");
  assert.equal(manifest.channels.main?.["1.0.0"]?.mandatory, false);
  const release = await service.findByFile("unitel-man", "android", file);
  assert.ok(release);
  assert.equal(release.signature, "");
  assert.equal(release.mandatory, false);
  assert.equal((await service.listReleases({ app: "unitel-man" })).items[0]?.mandatory, false);
  await assert.rejects(
    fixture.inspect.prepare("UPDATE ota_releases SET mandatory = 2 WHERE id = ?").bind("legacy-release").run(),
  );
});
