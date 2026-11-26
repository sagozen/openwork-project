import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { scoped } from "@templatedesign/app-shell/db/scoped";
import { setWorkspacePlan } from "@templatedesign/platform/workspaces";
import { OtaError, sha256Hex } from "../src/domain/data.js";
import { OtaService } from "../src/domain/service.js";
import type { OtaBlobStore } from "../src/domain/types.js";
import { serviceFor } from "../src/http/shared.js";
import { otaRuntime } from "../src/lib/ota-runtime";
import { sweepExpiredBuilds } from "../src/lib/sweep";
import type { Env } from "../src/lib/types";
import { memoryStore } from "./helpers.js";
import { memoryR2 } from "./support/memory-r2.js";
import { addOtaWorkspace, type OtaFixture, setupOta } from "./support/ota.js";

const encoder = new TextEncoder();
const DAY = 24 * 60 * 60 * 1000;
const admin = { id: "admin-1", administrator: true };

let fixture: OtaFixture | undefined;
afterEach(() => {
  fixture?.close();
  fixture = undefined;
});

function serviceOn(
  target: OtaFixture,
  options: { blobs?: OtaBlobStore; now?: () => number; retentionDays?: number; maxBundleBytes?: number } = {},
) {
  const blobs = options.blobs ?? memoryStore().store;
  return new OtaService({
    db: target.db,
    workspace: target.workspace,
    actor: admin,
    blobs: async () => blobs,
    now: options.now ?? (() => Date.now()),
    maxBundleBytes: options.maxBundleBytes ?? 1024 * 1024,
    secretKey: null,
    platformAvailable: true,
    ...(options.retentionDays === undefined ? {} : { retentionDays: options.retentionDays }),
  });
}

async function push(service: OtaService, payload: string, channel = "main", binary = "1.0.0") {
  const bytes = encoder.encode(payload);
  return service.push("my-app", "android", {
    channel,
    binary,
    sha256: await sha256Hex(bytes),
    note: "",
    commit: "",
    bytes,
  });
}

async function expectPlanLimit(promise: Promise<unknown>, message: RegExp) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof OtaError, `expected OtaError, got ${String(error)}`);
    assert.equal(error.code, "PLAN_LIMIT");
    assert.equal(error.status, 402);
    assert.match(error.message, message);
    return true;
  });
}

describe("apps cap", () => {
  beforeEach(async () => {
    fixture = await setupOta({ apps: [] });
  });

  it("lets the free plan register 2 apps and refuses the third with a plan message", async () => {
    const service = serviceOn(fixture as OtaFixture);
    await service.saveApp({ slug: "first-app", name: "First", enabled: true });
    await service.saveApp({ slug: "second-app", name: "Second", enabled: true });
    await expectPlanLimit(service.saveApp({ slug: "third-app", name: "Third", enabled: true }), /allows 2 apps/);
    assert.deepEqual(
      (await service.listApps()).map((app) => app.slug),
      ["first-app", "second-app"],
    );
  });

  it("does not count renaming or disabling an existing app against the cap", async () => {
    const service = serviceOn(fixture as OtaFixture);
    await service.saveApp({ slug: "first-app", name: "First", enabled: true });
    await service.saveApp({ slug: "second-app", name: "Second", enabled: true });
    const renamed = await service.saveApp({ slug: "second-app", name: "Renamed", enabled: false });
    assert.equal(renamed.name, "Renamed");
    assert.equal(renamed.enabled, false);
  });

  it("gives the pro plan 20 apps", async () => {
    const pro = await setupOta({ plan: "pro", apps: [], slug: "pro-apps" });
    try {
      const service = serviceOn(pro);
      for (let index = 0; index < 20; index += 1) {
        await service.saveApp({ slug: `app-${index}`, name: `App ${index}`, enabled: true });
      }
      await expectPlanLimit(service.saveApp({ slug: "app-20", name: "Over", enabled: true }), /allows 20 apps/);
    } finally {
      pro.close();
    }
  });
});

describe("monthly releases", () => {
  beforeEach(async () => {
    fixture = await setupOta({ apps: [{ slug: "my-app", name: "My app" }] });
  });

  it("allows 50 new releases a month on the free plan, then asks to upgrade", async () => {
    let clock = Date.UTC(2026, 9, 8, 2, 15, 0);
    const service = serviceOn(fixture as OtaFixture, { now: () => clock });
    let last = "";
    for (let index = 0; index < 50; index += 1) {
      clock += 1000;
      last = `build-${index}`;
      await push(service, last);
    }
    clock += 1000;
    await expectPlanLimit(push(service, "build-over-the-limit"), /50 new releases per month/);
    // A retry of the build that is already current is not a new release.
    const replay = await push(service, last);
    assert.equal(replay.selected, true);
    const count = await (fixture as OtaFixture).inspect
      .prepare("SELECT COUNT(*) AS n FROM ota_releases")
      .first<{ n: number }>();
    assert.ok((count?.n ?? 0) >= 2, "earlier builds stay available");
  });

  it("hands the unit back when the bundle could not be stored", async () => {
    const target = fixture as OtaFixture;
    const failing: OtaBlobStore = {
      ...memoryStore().store,
      put: async () => {
        throw new OtaError("STORAGE_FAILED", "disk full", 502);
      },
    };
    const service = serviceOn(target, { blobs: failing });
    await assert.rejects(push(service, "never stored"), /disk full/);
    const used = await target.db.first<{ used: number }>(
      "SELECT used FROM workspace_usage WHERE workspace_id = ? AND key = 'releases.perMonth'",
      [target.workspace.id],
    );
    assert.equal(used?.used ?? 0, 0);
  });

  it("does not cap releases on the pro plan but still counts them", async () => {
    const pro = await setupOta({ plan: "pro", apps: [{ slug: "my-app", name: "My app" }], slug: "pro-releases" });
    try {
      let clock = Date.UTC(2026, 9, 8, 2, 15, 0);
      const service = serviceOn(pro, { now: () => clock });
      for (let index = 0; index < 55; index += 1) {
        clock += 1000;
        await push(service, `pro-build-${index}`);
      }
      const used = await pro.db.first<{ used: number }>(
        "SELECT SUM(used) AS used FROM workspace_usage WHERE workspace_id = ? AND key = 'releases.perMonth'",
        [pro.workspace.id],
      );
      assert.equal(used?.used, 55);
    } finally {
      pro.close();
    }
  });
});

describe("bundle size", () => {
  it("derives each workspace's ceiling from its plan and the deployment limit", async () => {
    const free = await setupOta({ slug: "size-free" });
    try {
      const pro = await addOtaWorkspace(free, { plan: "pro", slug: "size-pro", apps: [] });
      const ceiling = async (workspace: typeof pro, env: Record<string, string>) =>
        (await otaRuntime({ env: env as unknown as Env, db: free.db, workspace })).maxBundleBytes;
      const MiB = 1024 * 1024;
      assert.equal(await ceiling(free.workspace, {}), 100 * MiB, "free: 100 MB");
      assert.equal(await ceiling(free.workspace, { OTA_MAX_BUNDLE_BYTES: String(300 * MiB) }), 100 * MiB);
      assert.equal(
        await ceiling(pro, { OTA_MAX_BUNDLE_BYTES: String(300 * MiB) }),
        300 * MiB,
        "pro: up to the deployment limit",
      );
      assert.equal(
        await ceiling(pro, { OTA_MAX_BUNDLE_BYTES: String(900 * MiB) }),
        512 * MiB,
        "never above the in-memory ceiling",
      );
    } finally {
      free.close();
    }
  });

  it("refuses a bundle above the plan limit with a plan message", async () => {
    fixture = await setupOta({ apps: [{ slug: "my-app", name: "My app" }] });
    const target = fixture;
    // An override lowers this workspace to 1 MB without touching the plan definition.
    await target.db.run(
      "INSERT INTO workspace_entitlements (workspace_id, key, limit_value, source) VALUES (?, 'bundle.maxMb', 1, 'override')",
      [target.workspace.id],
    );
    const service = serviceOn(target, { maxBundleBytes: 8 * 1024 * 1024 });
    await expectPlanLimit(push(service, "x".repeat(2 * 1024 * 1024)), /bundles up to 1 MB/);
    const stored = await target.inspect.prepare("SELECT COUNT(*) AS n FROM ota_releases").first<{ n: number }>();
    assert.equal(stored?.n, 0);
  });
});

describe("retention", () => {
  beforeEach(async () => {
    fixture = await setupOta({ apps: [{ slug: "my-app", name: "My app" }] });
  });

  it("caps the retention a workspace may choose at its plan", async () => {
    const service = serviceOn(fixture as OtaFixture);
    await expectPlanLimit(service.saveRetention({ days: 31 }), /up to 30 days/);
    const saved = await service.saveRetention({ days: 30 });
    assert.deepEqual({ ...saved }, { days: 30, planLimit: 30, custom: true });
  });

  it("narrows the deployment default to the plan when nothing was chosen", async () => {
    const service = serviceOn(fixture as OtaFixture, { retentionDays: 90 });
    assert.equal(await service.retentionDays(), 30);
    const short = serviceOn(fixture as OtaFixture, { retentionDays: 14 });
    assert.equal(await short.retentionDays(), 14);
  });

  it("lets the pro plan keep builds for a year", async () => {
    const pro = await setupOta({ plan: "pro", slug: "pro-retention", apps: [] });
    try {
      const service = serviceOn(pro);
      await service.saveRetention({ days: 365 });
      await expectPlanLimit(service.saveRetention({ days: 366 }), /up to 365 days/);
    } finally {
      pro.close();
    }
  });
});

describe("bring your own bucket", () => {
  const r2Settings = {
    mode: "r2",
    r2: { endpoint: "https://account.r2.cloudflarestorage.com", bucket: "ota", accessKeyId: "k", secret: "s" },
  };

  it("is refused on the free plan and allowed on pro", async () => {
    fixture = await setupOta();
    const free = serviceOn(fixture);
    await expectPlanLimit(free.saveStorageSettings(r2Settings), /Pro plan/);
    await free.saveStorageSettings({ mode: "platform" });

    const pro = await setupOta({ plan: "pro", slug: "pro-byo", apps: [] });
    try {
      const service = new OtaService({
        db: pro.db,
        workspace: pro.workspace,
        actor: admin,
        blobs: async () => memoryStore().store,
        maxBundleBytes: 1024 * 1024,
        secretKey: new Uint8Array(32).fill(7),
        platformAvailable: true,
      });
      const saved = await service.saveStorageSettings(r2Settings);
      assert.equal(saved.mode, "r2");
      assert.equal(saved.r2.hasSecret, true);
    } finally {
      pro.close();
    }
  });
});

describe("downgrade", () => {
  it("never deletes apps, tokens, releases or a chosen retention window", async () => {
    fixture = await setupOta({ plan: "pro", apps: [], slug: "downgrade-me" });
    const target = fixture;
    const r2 = memoryR2();
    const env = { MEDIA: r2.bucket, OTA_RETENTION_DAYS: "14" } as unknown as Env;
    const old = Date.now() - 100 * DAY;

    const proRuntime = { ...(await otaRuntime({ env, db: target.db, workspace: target.workspace })), now: () => old };
    const proService = serviceFor(proRuntime, admin).service;
    for (const slug of ["app-a", "app-b", "app-c", "app-d"]) {
      await proService.saveApp({ slug, name: slug, enabled: true });
    }
    await proService.saveRetention({ days: 200 });
    const { token } = await proService.createToken({ app: "app-a", name: "CI" });
    const bytes = encoder.encode("old build");
    await proService.push("app-a", "android", {
      channel: "main",
      binary: "1.0.0",
      sha256: await sha256Hex(bytes),
      note: "",
      commit: "",
      bytes,
    });

    const downgraded = await setWorkspacePlan(target.db, target.workspace, "free");
    const freeRuntime = await otaRuntime({ env, db: target.db, workspace: downgraded });
    const freeService = serviceFor(freeRuntime, admin).service;

    // Everything made on the paid plan is still there and still works.
    assert.equal((await freeService.listApps()).length, 4, "4 apps survive a plan that allows 2");
    assert.equal(Object.keys((await freeService.manifest("app-a", "android")).channels).length, 1);
    await freeService.authenticatePush("app-a", `Bearer ${token}`);
    assert.equal((await freeService.getRetention()).days, 200, "the chosen window stays in force");

    // The nightly sweep respects it: a 100-day-old build is inside the 200-day window.
    const swept = await sweepExpiredBuilds(target.db, env);
    assert.equal(swept.failed, 0);
    assert.equal(swept.removed, 0);
    assert.equal(r2.objects.size, 1);

    // Only new growth is blocked.
    await expectPlanLimit(freeService.saveApp({ slug: "app-e", name: "E", enabled: true }), /allows 2 apps/);
    await expectPlanLimit(freeService.saveRetention({ days: 100 }), /up to 30 days/);
  });

  it("sweeps each workspace with its own window", async () => {
    fixture = await setupOta({ apps: [{ slug: "my-app", name: "My app" }], slug: "sweep-short" });
    const target = fixture;
    const longer = await addOtaWorkspace(target, {
      plan: "pro",
      slug: "sweep-long",
      apps: [{ slug: "my-app", name: "My app" }],
    });
    const r2 = memoryR2();
    const env = { MEDIA: r2.bucket, OTA_RETENTION_DAYS: "14" } as unknown as Env;
    const old = Date.now() - 20 * DAY;

    for (const workspace of [target.workspace, longer]) {
      const runtime = { ...(await otaRuntime({ env, db: target.db, workspace })), now: () => old };
      const service = serviceFor(runtime, admin).service;
      if (workspace.id === longer.id) await service.saveRetention({ days: 60 });
      await push(service, `bytes-${workspace.slug}`);
    }
    assert.equal(r2.objects.size, 2);

    const swept = await sweepExpiredBuilds(target.db, env);
    assert.equal(swept.workspaces, 2);
    assert.equal(swept.removed, 1, "only the workspace on the 14-day default loses its 20-day-old build");
    const remaining = [...r2.objects.keys()];
    assert.equal(remaining.length, 1);
    assert.ok(remaining[0]?.startsWith(`ota/${longer.id}/`));
    const left = await scoped(target.db, longer.id).first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM ota_releases WHERE workspace_id = :ws",
    );
    assert.equal(left?.n, 1);
  });
});
