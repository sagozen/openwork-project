import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import type { ScopedDb } from "@templatedesign/app-shell/db/scoped";
import { runIsolationSuite } from "@templatedesign/app-shell/testing/isolation";
import { findUnscopedSql } from "@templatedesign/app-shell/testing/unscoped-sql";
import type { Workspace } from "@templatedesign/platform/workspaces";
import { sha256Hex } from "../src/domain/data.js";
import { handleOtaAdminRequest } from "../src/http/admin.js";
import { handleOtaAppRequest } from "../src/http/app.js";
import { serviceFor } from "../src/http/shared.js";
import { otaRuntime } from "../src/lib/ota-runtime";
import type { Env } from "../src/lib/types";
import { multipartBody } from "./helpers.js";
import { createTestDb } from "./support/db";
import { memoryR2 } from "./support/memory-r2.js";
import { addOtaWorkspace } from "./support/ota.js";

const OTA_TABLES = ["ota_apps", "ota_releases", "ota_current", "ota_tokens", "ota_settings", "ota_audit"];
const encoder = new TextEncoder();
const LONG_AGO = Date.UTC(2020, 0, 1);

/** Everything a hostile caller needs to know about workspace B. */
interface Foreign {
  appOnlyInB: string;
  sharedApp: string;
  releaseId: string;
  releaseFile: string;
  tokenId: string;
  token: string;
  channel: string;
}

test("workspace A cannot read or change workspace B through any admin action or device route", async () => {
  const { db, close } = createTestDb();
  const r2 = memoryR2();
  const env = { MEDIA: r2.bucket, OTA_SECRET_KEY: "11".repeat(32) } as unknown as Env;
  const foreignOf = new Map<string, Foreign>();

  const runtimeFor = (workspace: Workspace) => otaRuntime({ env, db, workspace, origin: "https://ota.test" });

  async function seed(as: ScopedDb, workspace: Workspace, label: "A" | "B") {
    // Seeded rows are old on purpose: a purge that leaked across workspaces would delete B's builds.
    const runtime = { ...(await runtimeFor(workspace)), now: () => LONG_AGO };
    const admin = { id: `admin-${label}`, administrator: true };
    const service = serviceFor(runtime, admin).service;
    const sharedApp = "shared-app";
    const appOnlyInB = "only-in-b";
    await service.saveApp({ slug: sharedApp, name: `Shared ${label} ${workspace.id}`, enabled: true });
    if (label === "B") await service.saveApp({ slug: appOnlyInB, name: `Private app ${workspace.id}`, enabled: true });
    const created = await service.createToken({ app: sharedApp, name: `token-${label}-${workspace.id}` });
    const channel = `channel-${label}-${workspace.id}`;
    const bytes = encoder.encode(`bundle-bytes-${label}-${workspace.id}`);
    const release = await service.push(sharedApp, "android", {
      channel,
      binary: "1.0.0",
      sha256: await sha256Hex(bytes),
      note: `note-${label}-${workspace.id}`,
      commit: `commit${label}`,
      bytes,
    });
    await service.rotateUploadKey({ app: sharedApp });
    foreignOf.set(label, {
      appOnlyInB,
      sharedApp,
      releaseId: release.id,
      releaseFile: release.file,
      tokenId: created.record.id,
      token: created.token,
      channel,
    });
    const rows = await as.first<{ count: number }>(
      "SELECT COUNT(*) AS count FROM ota_releases WHERE workspace_id = :ws",
    );
    assert.equal(rows?.count, 1);
    return {
      markers: [
        `Shared ${label} ${workspace.id}`,
        `token-${label}-${workspace.id}`,
        `note-${label}-${workspace.id}`,
        channel,
        created.token,
        ...(label === "B" ? [`Private app ${workspace.id}`] : []),
      ],
      ids: { ota_releases: [release.id], ota_tokens: [created.record.id] },
    };
  }

  const text = async (response: Response) => ({ status: response.status, body: await response.text() });

  async function admin(workspace: Workspace, action: string, body?: unknown, query = "") {
    const runtime = { ...(await runtimeFor(workspace)), actor: { id: "admin-A", administrator: true } };
    const isRead = body === undefined;
    const request = new Request(`https://ota.test/iso-alpha/admin/api/${action}${query}`, {
      method: isRead ? "GET" : "POST",
      headers: isRead ? {} : { "Content-Type": "application/json" },
      body: isRead ? undefined : JSON.stringify(body),
    });
    return text(await handleOtaAdminRequest(request, action, runtime));
  }

  async function device(workspace: Workspace, path: string, init: RequestInit = {}) {
    const runtime = await runtimeFor(workspace);
    return text(await handleOtaAppRequest(new Request(`https://ota.test/iso-alpha/ota/${path}`, init), path, runtime));
  }

  try {
    await runIsolationSuite({
      db,
      app: "ota",
      seed,
      actions: [
        // --- admin API, using B's ids -------------------------------------------------------
        {
          name: "release-delete with B's release id",
          run: ({ a, foreign }) => admin(a, "release-delete", { id: foreign.ids.ota_releases[0] }),
        },
        {
          name: "release-promote with B's release id",
          run: ({ a, foreign }) => admin(a, "release-promote", { id: foreign.ids.ota_releases[0] }),
        },
        {
          name: "token-revoke with B's token id",
          run: ({ a, foreign }) => admin(a, "token-revoke", { id: foreign.ids.ota_tokens[0] }),
        },
        {
          name: "token-create for an app only B has",
          run: ({ a }) => admin(a, "token-create", { app: foreignOf.get("B")?.appOnlyInB, name: "probe" }),
        },
        {
          name: "upload-key-rotate for an app only B has",
          run: ({ a }) => admin(a, "upload-key-rotate", { app: foreignOf.get("B")?.appOnlyInB }),
        },
        {
          name: "upload-key status for an app only B has",
          run: ({ a }) => admin(a, "upload-key", undefined, `?app=${foreignOf.get("B")?.appOnlyInB}`),
        },
        {
          name: "release-upload into an app only B has",
          run: async ({ a }) => {
            const multipart = multipartBody([
              { name: "app", value: foreignOf.get("B")?.appOnlyInB ?? "" },
              { name: "platform", value: "android" },
              { name: "channel", value: "probe" },
              { name: "binary", value: "9.9.9" },
              { name: "bundle", filename: "x.bundle", bytes: encoder.encode("probe") },
            ]);
            const runtime = { ...(await runtimeFor(a)), actor: { id: "admin-A", administrator: true } };
            return text(
              await handleOtaAdminRequest(
                new Request("https://ota.test/iso-alpha/admin/api/release-upload", {
                  method: "POST",
                  headers: { "content-type": multipart.contentType },
                  body: multipart.body as unknown as BodyInit,
                }),
                "release-upload",
                runtime,
              ),
            );
          },
        },
        { name: "releases list", run: ({ a }) => admin(a, "releases", undefined, "?limit=100") },
        {
          name: "releases list filtered by B's channel",
          run: ({ a }) =>
            admin(a, "releases", undefined, `?channel=${encodeURIComponent(foreignOf.get("B")?.channel ?? "")}`),
        },
        { name: "tokens list", run: ({ a }) => admin(a, "tokens") },
        { name: "audit list", run: ({ a }) => admin(a, "audit", undefined, "?limit=200") },
        { name: "info", run: ({ a }) => admin(a, "info") },
        { name: "storage view", run: ({ a }) => admin(a, "storage") },
        { name: "retention view", run: ({ a }) => admin(a, "retention") },
        { name: "retention save", run: ({ a }) => admin(a, "retention-save", { days: 7 }) },
        {
          name: "app-save overwriting B's app slug",
          run: ({ a }) =>
            admin(a, "app-save", { slug: foreignOf.get("B")?.sharedApp, name: "Renamed by A", enabled: false }),
        },
        { name: "storage-test on platform storage", run: ({ a }) => admin(a, "storage-test", { mode: "platform" }) },
        { name: "purge expired builds", run: ({ a }) => admin(a, "purge", {}) },

        // --- device routes, using B's app, files and token ----------------------------------
        {
          name: "manifest of an app only B has",
          run: ({ a }) => device(a, `${foreignOf.get("B")?.appOnlyInB}/android/manifest.json`),
        },
        {
          name: "manifest of the shared app slug",
          run: ({ a }) => device(a, `${foreignOf.get("B")?.sharedApp}/android/manifest.json`),
        },
        {
          name: "download of B's bundle file under the shared app slug",
          run: ({ a }) => device(a, `${foreignOf.get("B")?.sharedApp}/android/${foreignOf.get("B")?.releaseFile}`),
        },
        {
          name: "download of B's bundle file under B's private app",
          run: ({ a }) => device(a, `${foreignOf.get("B")?.appOnlyInB}/android/${foreignOf.get("B")?.releaseFile}`),
        },
        {
          name: "release list with B's token",
          run: ({ a }) =>
            device(a, `${foreignOf.get("B")?.sharedApp}/android/releases`, {
              headers: { authorization: `Bearer ${foreignOf.get("B")?.token}` },
            }),
        },
        {
          name: "push with B's token",
          run: async ({ a }) => {
            const bytes = encoder.encode("hostile-push");
            const multipart = multipartBody([
              { name: "channel", value: "hostile" },
              { name: "binary", value: "6.6.6" },
              { name: "sha256", value: await sha256Hex(bytes) },
              { name: "bundle", filename: "x.bundle", bytes },
            ]);
            return device(a, `${foreignOf.get("B")?.sharedApp}/android/releases`, {
              method: "POST",
              headers: {
                "content-type": multipart.contentType,
                authorization: `Bearer ${foreignOf.get("B")?.token}`,
              },
              body: multipart.body as unknown as BodyInit,
            });
          },
        },
        {
          name: "delete a channel with B's token",
          run: ({ a }) =>
            device(
              a,
              `${foreignOf.get("B")?.sharedApp}/android/releases?channel=${encodeURIComponent(foreignOf.get("B")?.channel ?? "")}&binary=1.0.0`,
              { method: "DELETE", headers: { authorization: `Bearer ${foreignOf.get("B")?.token}` } },
            ),
        },
      ],
    });

    // Everything A did left B's stored bundle in place, under B's own prefix.
    const bKeys = [...r2.objects.keys()].filter((key) => key.includes(foreignOf.get("B")?.releaseFile ?? "?"));
    assert.equal(bKeys.length, 1, "B's bundle object still exists");
    assert.match(bKeys[0] ?? "", /^ota\/ws_/, "bundle keys carry the owning workspace prefix");
  } finally {
    close();
  }
});

test("two workspaces can publish an app with the same slug without seeing each other", async () => {
  const test = createTestDb();
  const r2 = memoryR2();
  const env = { MEDIA: r2.bucket } as unknown as Env;
  try {
    const workspaces = [
      await addOtaWorkspace(test, { slug: "same-one", apps: [{ slug: "my-app", name: "One" }] }),
      await addOtaWorkspace(test, { slug: "same-two", apps: [{ slug: "my-app", name: "Two" }] }),
    ];
    for (const workspace of workspaces) {
      const runtime = await otaRuntime({ env, db: test.db, workspace });
      const service = serviceFor(
        { ...runtime, now: () => Date.UTC(2026, 9, 8) },
        { id: "a", administrator: true },
      ).service;
      const bytes = encoder.encode(`bytes-${workspace.slug}`);
      await service.push("my-app", "android", {
        channel: "main",
        binary: "1.0.0",
        sha256: await sha256Hex(bytes),
        note: "",
        commit: "",
        bytes,
      });
      const manifest = await service.manifest("my-app", "android");
      assert.equal(manifest.channels.main?.["1.0.0"]?.size, bytes.byteLength);
      const own = await test.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM ota_releases WHERE workspace_id = ?", [
        workspace.id,
      ]);
      assert.equal(own?.n, 1);
    }
    assert.equal(r2.objects.size, 2, "each workspace stored its own object");
    const prefixes = new Set([...r2.objects.keys()].map((key) => key.split("/").slice(0, 2).join("/")));
    assert.equal(prefixes.size, 2, "under its own prefix");
  } finally {
    test.close();
  }
});

test("no source file queries a tenant table without the workspace scope", () => {
  assert.deepEqual(findUnscopedSql(join(import.meta.dirname, "..", "src"), OTA_TABLES), []);
});
