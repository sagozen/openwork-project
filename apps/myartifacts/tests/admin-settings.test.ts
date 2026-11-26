import assert from "node:assert/strict";
import { test } from "node:test";
import { type AdminActor, setAdminSetting } from "@templatedesign/platform/admin";
import { loadUploadSettings } from "../src/lib/artifacts/settings";
import { setupArtifacts } from "./support/artifacts";

const MB = 1024 * 1024;
const admin: AdminActor = { userId: "usr_admin", email: "admin@example.com", role: "admin" };

test("the admin settings accept the three upload keys within their ceilings and refuse anything else", async () => {
  const t = await setupArtifacts();
  try {
    await setAdminSetting(t.db, admin, "uploads.enabled", false, "pause for maintenance");
    await setAdminSetting(t.db, admin, "uploads.max_inline_bytes", 2 * MB, "smaller inline limit");
    await setAdminSetting(t.db, admin, "uploads.max_import_bytes", 250 * MB, "bigger import limit");
    assert.deepEqual(
      { ...(await loadUploadSettings(t.db)) },
      { enabled: false, maxInlineBytes: 2 * MB, maxImportBytes: 250 * MB },
    );

    // One MCP request carries 4 MB decoded, so the inline limit cannot be set higher.
    await assert.rejects(setAdminSetting(t.db, admin, "uploads.max_inline_bytes", 4 * MB + 1, "too much"), {
      status: 400,
    });
    await assert.rejects(setAdminSetting(t.db, admin, "uploads.max_import_bytes", 500 * MB + 1, "too much"), {
      status: 400,
    });
    await assert.rejects(setAdminSetting(t.db, admin, "uploads.max_import_bytes", -1, "negative"), { status: 400 });
    await assert.rejects(setAdminSetting(t.db, admin, "uploads.enabled", "yes", "not a boolean"), { status: 400 });
    await assert.rejects(setAdminSetting(t.db, admin, "uploads.surprise", 1, "unknown"), { status: 400 });
    assert.deepEqual(
      { ...(await loadUploadSettings(t.db)) },
      { enabled: false, maxInlineBytes: 2 * MB, maxImportBytes: 250 * MB },
    );

    const audit = await t.db.all<{ action: string; resource_id: string; reason: string }>(
      "SELECT action, resource_id, reason FROM admin_audit WHERE action = 'admin.setting.updated' ORDER BY created_at",
    );
    assert.deepEqual(audit.map((row) => row.resource_id).sort(), [
      "uploads.enabled",
      "uploads.max_import_bytes",
      "uploads.max_inline_bytes",
    ]);
    assert.ok(audit.every((row) => row.reason));
  } finally {
    t.close();
  }
});
