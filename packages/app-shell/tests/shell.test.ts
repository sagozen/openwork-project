import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPlatform, resetPlatformConfig } from "@templatedesign/platform/config";
import type { Db } from "@templatedesign/platform/db";
import { HttpError } from "@templatedesign/platform/http";
import { addMember, createWorkspace, setWorkspaceStatus, updateBranding } from "@templatedesign/platform/workspaces";
import { serveBrandAsset } from "../src/branding/serve";
import {
  BRAND_KEY_PATTERN,
  checkLogo,
  MAX_LOGO_BYTES,
  removeLogo,
  sniffLogoType,
  storeLogo,
} from "../src/branding/upload";
import { bindWorkspace, scoped, UnscopedQueryError } from "../src/db/scoped";
import { CONTENT_SECURITY_POLICY, withSecurityHeaders } from "../src/security";
import { runIsolationSuite } from "../src/testing/isolation";
import { findUnscopedSql } from "../src/testing/unscoped-sql";
import { loadWorkspaceRequest, splitWorkspacePath } from "../src/workspace-context";
import { asBucket, createTestDb, MemoryBucket } from "./support/db";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 1, 2]);
const WEBP = Uint8Array.from([
  ...new TextEncoder().encode("RIFF"),
  9,
  0,
  0,
  0,
  ...new TextEncoder().encode("WEBPVP8 "),
]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

function configure() {
  createPlatform({
    brand: { name: "Shell Test", appOrigin: "https://shell.example", emailFrom: "Shell <no-reply@shell.example>" },
    packs: [],
    guestPolicy: {
      dailyCredits: 0,
      exceedingMessage: () => "",
      exhaustedMessage: () => "",
      signupPath: "/auth/sign-in",
    },
    copy: { welcomeBody: { en: [""], vi: [""] }, dataNoun: { en: "data", vi: "dữ liệu" } },
    locales: ["en", "vi"],
    scopes: { available: [], default: [] },
    appId: "restaurant",
    reservedSlugs: ["privacy"],
  });
}

async function account(db: Db, index: number) {
  const now = "2026-01-01T00:00:00.000Z";
  await db.run('INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)', [
    `usr_${index}`,
    `User ${index}`,
    `u${index}@example.com`,
    now,
    now,
  ]);
  await db.run("INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)", [`ten_${index}`, `T${index}`, now]);
  return { userId: `usr_${index}`, tenantId: `ten_${index}` };
}

test("only well-formed, non-reserved first segments are workspace slugs", () => {
  configure();
  assert.deepEqual(splitWorkspacePath("/pho-24/admin/floor"), { slug: "pho-24", rest: "/admin/floor" });
  assert.deepEqual(splitWorkspacePath("/pho-24"), { slug: "pho-24", rest: "/" });
  for (const path of [
    "/admin",
    "/api/v1/x",
    "/pricing",
    "/robots.txt",
    "/_astro/a.js",
    "/privacy",
    "/ab",
    "/",
    "/brand/x",
  ]) {
    assert.equal(splitWorkspacePath(path).slug, null, path);
  }
});

test("loadWorkspaceRequest: 404, locked, sign-in, forbidden, member and public", async () => {
  configure();
  const { db, close } = createTestDb();
  try {
    const owner = await account(db, 1);
    const stranger = await account(db, 2);
    const ws = await createWorkspace(db, { app: "restaurant", slug: "pho-24", ...owner, name: "Phở 24" });
    const load = (pathname: string, userId?: string) =>
      loadWorkspaceRequest({ db, app: "restaurant", pathname, userId });

    assert.equal((await load("/pricing")).kind, "none");
    assert.equal((await load("/unknown-site/admin", owner.userId)).kind, "not-found");
    assert.equal((await load("/pho-24/admin")).kind, "sign-in-required");
    assert.equal((await load("/pho-24/admin", stranger.userId)).kind, "forbidden");

    const publicPage = await load("/pho-24/order/abc");
    assert.equal(publicPage.kind, "ok");
    if (publicPage.kind === "ok") {
      assert.equal(publicPage.member, null);
      assert.equal(publicPage.brand.displayName, "Phở 24");
      assert.equal(publicPage.rest, "/order/abc");
    }
    const admin = await load("/pho-24/admin/floor", owner.userId);
    assert.equal(admin.kind === "ok" && admin.member?.role, "owner");

    // The same slug in another app is a different (here: missing) workspace.
    const other = await loadWorkspaceRequest({ db, app: "erp", pathname: "/pho-24", userId: owner.userId });
    assert.equal(other.kind, "not-found");

    await setWorkspaceStatus(db, ws, "locked");
    assert.equal((await load("/pho-24/order/abc")).kind, "locked");
    assert.equal((await load("/pho-24/admin", owner.userId)).kind, "locked");
  } finally {
    close();
  }
});

test("logos: only PNG, JPEG and WebP by magic bytes; SVG, fakes and oversize are refused", () => {
  assert.equal(sniffLogoType(PNG), "image/png");
  assert.equal(sniffLogoType(JPEG), "image/jpeg");
  assert.equal(sniffLogoType(WEBP), "image/webp");
  assert.equal(sniffLogoType(SVG), null);

  const refused = (action: () => unknown, code: string) =>
    assert.throws(action, (error: unknown) => error instanceof HttpError && error.code === code);
  refused(() => checkLogo(SVG, "image/svg+xml"), "invalid_input");
  // A file renamed to look like an image but holding script or HTML.
  refused(
    () => checkLogo(new TextEncoder().encode("<html><script>alert(1)</script></html>"), "image/png"),
    "invalid_input",
  );
  // The browser's claim must agree with the bytes.
  refused(() => checkLogo(PNG, "image/jpeg"), "invalid_input");
  refused(() => checkLogo(new Uint8Array(0)), "invalid_input");
  refused(() => checkLogo(new Uint8Array(MAX_LOGO_BYTES + 1).fill(0x41)), "payload_too_large");
  const big = new Uint8Array(MAX_LOGO_BYTES + 1);
  big.set(PNG);
  refused(() => checkLogo(big), "payload_too_large");
  assert.equal(checkLogo(PNG, "image/png").extension, "png");
  assert.equal(checkLogo(JPEG).extension, "jpg");
});

test("stored logos get a content-hash key under the workspace and are served safely", async () => {
  const bucket = new MemoryBucket();
  const workspaceId = `ws_${"a".repeat(32)}`;
  const key = await storeLogo(asBucket(bucket), workspaceId, PNG, "image/png");
  assert.match(key, BRAND_KEY_PATTERN);
  assert.ok(key.startsWith(`brand/${workspaceId}/`));
  assert.equal(bucket.objects.get(key)?.contentType, "image/png");
  assert.equal(await storeLogo(asBucket(bucket), workspaceId, PNG), key, "same bytes, same key");

  const response = await serveBrandAsset(asBucket(bucket), key);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(response.headers.get("cache-control") ?? "", /immutable/);
  assert.match(response.headers.get("content-security-policy") ?? "", /sandbox/);

  // Only keys of the exact stored shape are answered; anything else is a 404.
  for (const probe of [
    "brand/../secret.png",
    `brand/${workspaceId}/x.svg`,
    "other/file.png",
    `brand/${workspaceId}/zz.png`,
  ]) {
    assert.equal((await serveBrandAsset(asBucket(bucket), probe)).status, 404, probe);
  }

  // A workspace may only delete its own objects.
  await removeLogo(asBucket(bucket), `ws_${"b".repeat(32)}`, key);
  assert.ok(bucket.objects.has(key));
  await removeLogo(asBucket(bucket), workspaceId, key);
  assert.ok(!bucket.objects.has(key));
});

test("security headers are added without overriding explicit ones", async () => {
  const plain = withSecurityHeaders(new Response("ok"));
  assert.equal(plain.headers.get("content-security-policy"), CONTENT_SECURITY_POLICY);
  assert.equal(plain.headers.get("x-frame-options"), "DENY");
  assert.equal(plain.headers.get("x-content-type-options"), "nosniff");
  assert.match(CONTENT_SECURITY_POLICY, /object-src 'none'/);
  assert.match(CONTENT_SECURITY_POLICY, /frame-ancestors 'none'/);
  const custom = withSecurityHeaders(
    new Response("ok", { headers: { "content-security-policy": "default-src 'none'" } }),
  );
  assert.equal(custom.headers.get("content-security-policy"), "default-src 'none'");
  assert.equal(await custom.text(), "ok");
});

test("brand strings round-trip as data: nothing in a display name is interpreted", async () => {
  configure();
  const { db, close } = createTestDb();
  try {
    const owner = await account(db, 1);
    const ws = await createWorkspace(db, { app: "restaurant", slug: "xss-site", ...owner });
    const hostile = `<img src=x onerror=alert(1)>`;
    await updateBranding(db, ws.id, { displayName: hostile });
    const result = await loadWorkspaceRequest({ db, app: "restaurant", pathname: "/xss-site", userId: owner.userId });
    // Stored verbatim; rendering escapes it (Astro does so for every `{expression}`).
    assert.equal(result.kind === "ok" && result.brand.displayName, hostile);
    await assert.rejects(() => updateBranding(db, ws.id, { accentColor: "#000;background:url(//evil)" }));
  } finally {
    close();
  }
});

test("scoped queries inject the workspace id and refuse unscoped SQL", async () => {
  assert.deepEqual(bindWorkspace("SELECT * FROM t WHERE workspace_id = :ws AND id = ? AND x = ?", [7, 8], "ws_1"), {
    sql: "SELECT * FROM t WHERE workspace_id = ? AND id = ? AND x = ?",
    params: ["ws_1", 7, 8],
  });
  assert.throws(() => bindWorkspace("SELECT * FROM t WHERE id = ?", [1], "ws_1"), UnscopedQueryError);
  assert.throws(
    () => bindWorkspace("SELECT * FROM t WHERE workspace_id = :ws AND id = ?", [], "ws_1"),
    /Missing parameter/,
  );
  assert.throws(() => bindWorkspace("SELECT 1 WHERE workspace_id = :ws", [1], "ws_1"), /Expected 0 parameters/);

  const { db, close } = createTestDb([
    "CREATE TABLE notes (workspace_id text NOT NULL, id text NOT NULL, body text NOT NULL, PRIMARY KEY (workspace_id, id));",
  ]);
  try {
    const a = scoped(db, "ws_a");
    const b = scoped(db, "ws_b");
    await a.insert("notes", { id: "n1", body: "alpha" });
    await b.insert("notes", { id: "n1", body: "bravo" });
    assert.equal(
      (await a.first<{ body: string }>("SELECT body FROM notes WHERE workspace_id = :ws AND id = ?", ["n1"]))?.body,
      "alpha",
    );
    assert.equal((await b.all("SELECT * FROM notes WHERE workspace_id = :ws")).length, 1);
    assert.equal((await a.run("DELETE FROM notes WHERE workspace_id = :ws AND id = ?", ["n1"])).changes, 1);
    assert.equal(
      (await b.all("SELECT * FROM notes WHERE workspace_id = :ws")).length,
      1,
      "B's note survives A's delete",
    );
    await assert.rejects(
      () => a.insert("notes", { workspace_id: "ws_b", id: "x", body: "y" }),
      /set by the scoped helper/,
    );
    await assert.rejects(() => a.insert("notes; DROP TABLE notes", { id: "x" }), /Bad table name/);
    await assert.rejects(() => a.first("SELECT * FROM notes WHERE id = ?", ["n1"]), UnscopedQueryError);
  } finally {
    close();
  }
});

const NOTES =
  "CREATE TABLE notes (workspace_id text NOT NULL, id text NOT NULL, body text NOT NULL, PRIMARY KEY (workspace_id, id));";

async function seedNotes(as: ReturnType<typeof scoped>, _workspace: unknown, label: "A" | "B") {
  const body = `secret-${label}-${as.workspaceId}`;
  await as.insert("notes", { id: `note-${label}`, body });
  return { markers: [body], ids: { notes: [`note-${label}`] } };
}

test("the isolation harness passes a correctly scoped app", async () => {
  configure();
  const { db, close } = createTestDb([NOTES]);
  try {
    await runIsolationSuite({
      db,
      app: "restaurant",
      seed: seedNotes,
      actions: [
        {
          name: "read note by B's id",
          run: ({ as, foreign }) =>
            as.first("SELECT * FROM notes WHERE workspace_id = :ws AND id = ?", [foreign.ids.notes[0]]),
        },
        { name: "list notes", run: ({ as }) => as.all("SELECT * FROM notes WHERE workspace_id = :ws") },
        {
          name: "delete B's note",
          run: ({ as, foreign }) =>
            as.run("DELETE FROM notes WHERE workspace_id = :ws AND id = ?", [foreign.ids.notes[0]]),
        },
        {
          name: "rewrite B's note",
          run: ({ as, foreign }) =>
            as.run("UPDATE notes SET body = 'pwned' WHERE workspace_id = :ws AND id = ?", [foreign.ids.notes[0]]),
        },
      ],
    });
  } finally {
    close();
  }
});

test("the isolation harness catches a leaking read and a cross-tenant write", async () => {
  configure();
  const leaky = async (kind: "read" | "write") => {
    const { db, close } = createTestDb([NOTES]);
    try {
      await runIsolationSuite({
        db,
        app: "restaurant",
        seed: seedNotes,
        actions: [
          kind === "read"
            ? {
                name: "leaky read",
                run: ({ foreign }) => db.all("SELECT * FROM notes WHERE id = ?", [foreign.ids.notes[0]]),
              }
            : {
                name: "leaky write",
                run: ({ foreign }) => db.run("DELETE FROM notes WHERE id = ?", [foreign.ids.notes[0]]),
              },
        ],
      });
    } finally {
      close();
    }
  };
  await assert.rejects(() => leaky("read"), /received B's data/);
  await assert.rejects(() => leaky("write"), /changed workspace B's rows/);
});

test("findUnscopedSql flags raw queries on tenant tables and honours waivers", () => {
  const dir = mkdtempSync(join(tmpdir(), "unscoped-"));
  try {
    writeFileSync(
      join(dir, "ok.ts"),
      [
        'as.first("SELECT * FROM rc_orders WHERE workspace_id = :ws AND id = ?", [id]);',
        'db.first("SELECT * FROM rc_orders WHERE id = ?", [id]); // unscoped-ok: webhook lookup by signed token',
        'db.all("SELECT * FROM tenants");',
      ].join("\n"),
    );
    writeFileSync(join(dir, "bad.ts"), 'db.first("SELECT * FROM rc_orders WHERE id = ?", [id]);\n');
    const hits = findUnscopedSql(dir, ["rc_orders"]);
    assert.deepEqual(
      hits.map((hit) => `${hit.file}:${hit.line}:${hit.table}`),
      ["bad.ts:1:rc_orders"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    resetPlatformConfig();
  }
});

test("members are added, listed through roles, and the owner stays the owner", async () => {
  configure();
  const { db, close } = createTestDb();
  try {
    const owner = await account(db, 1);
    const staff = await account(db, 2);
    const ws = await createWorkspace(db, { app: "restaurant", slug: "pho-24", ...owner });
    await addMember(db, ws.id, staff.userId, "cashier");
    const result = await loadWorkspaceRequest({
      db,
      app: "restaurant",
      pathname: "/pho-24/admin",
      userId: staff.userId,
    });
    assert.equal(result.kind === "ok" && result.member?.role, "cashier");
  } finally {
    close();
  }
});
