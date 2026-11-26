import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { ArtifactError, type ArtifactErrorCode } from "../src/lib/artifacts/errors";
import { createUpload, deleteArtifact, putInline, setExpiry } from "../src/lib/artifacts/service";
import {
  PBKDF2_ITERATIONS,
  SHARE_COOKIE_SECONDS,
  shareCookieName,
  signShareCookie,
  verifyShareCookie,
} from "../src/lib/shares/crypto";
import {
  PASSWORD_ATTEMPTS_PER_HOUR,
  PASSWORD_ATTEMPTS_PER_MINUTE,
  redirectToFile,
  renderSharePage,
  SHARE_LINK_SECONDS,
  submitSharePassword,
} from "../src/lib/shares/public";
import {
  createShare,
  getShare,
  listShares,
  resolveShare,
  revokeShare,
  ShareUnavailableError,
  updateShare,
} from "../src/lib/shares/service";
import { A, B, NO_SCOPE, ORIGIN, READ_ONLY, SECRET, STORAGE_ORIGIN, setupArtifacts } from "./support/artifacts";

const DAY = 24 * 60 * 60 * 1000;

const rejectsWith = (promise: Promise<unknown>, code: ArtifactErrorCode) =>
  assert.rejects(promise, (error) => error instanceof ArtifactError && error.code === code, code);

type Setup = Awaited<ReturnType<typeof setupArtifacts>>;

const get = (path: string, headers: Record<string, string> = {}) => new Request(`${ORIGIN}${path}`, { headers });
const post = (path: string, password: string, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams({ password }).toString(),
  });

async function file(t: Setup, name: string, content = "content of the file", extra: Record<string, unknown> = {}) {
  return putInline(t.deps, A, { name, content, ...extra });
}

/** The cookie a browser would send back after a correct password. */
function cookieFrom(response: Response): string {
  const header = response.headers.get("set-cookie") ?? "";
  return header.split(";")[0];
}

async function unlock(t: Setup, token: string, password: string, ip = "198.51.100.7") {
  const response = await submitSharePassword(
    t.shareDeps,
    post(`/s/${token}`, password, { "cf-connecting-ip": ip }),
    token,
  );
  assert.equal(response.status, 303);
  return cookieFrom(response);
}

// ---------------------------------------------------------------------------------- creating

test("createShare needs the caller's own ready files, 1 to 50 of them, each once", async () => {
  const t = await setupArtifacts();
  try {
    const mine = await file(t, "mine.txt");
    const theirs = await putInline(t.deps, B, { name: "theirs.txt", content: "b" });
    const other = await file(t, "other.txt");

    const share = await createShare(t.shareDeps, A, {
      artifact_ids: [mine.id, other.id],
      title: "Pack",
      expires_in_days: 7,
    });
    assert.match(share.share_id, /^[a-z2-7]{26}$/);
    assert.equal(share.url, `${ORIGIN}/s/${share.share_id}`);
    assert.equal(share.has_password, false);
    assert.equal(share.expires_at, "2026-11-29T10:00:00.000Z");
    assert.equal("password" in share, false);

    await assert.rejects(createShare(t.shareDeps, A, { artifact_ids: [theirs.id] }), (error) => {
      assert.ok(error instanceof ArtifactError);
      assert.equal(error.code, "NOT_FOUND");
      assert.deepEqual(error.details, { missing_ids: [theirs.id] });
      return true;
    });
    await rejectsWith(
      createShare(t.shareDeps, A, { artifact_ids: [mine.id, "abcdefghijklmnopqrstuvwxyz"] }),
      "NOT_FOUND",
    );

    await assert.rejects(createShare(t.shareDeps, A, { artifact_ids: [] }), z.ZodError);
    await assert.rejects(createShare(t.shareDeps, A, { artifact_ids: [mine.id, mine.id] }), z.ZodError);
    await assert.rejects(
      createShare(t.shareDeps, A, {
        artifact_ids: Array.from({ length: 51 }, (_, i) => `a${String(i).padStart(25, "b")}`),
      }),
      z.ZodError,
    );
    await assert.rejects(createShare(t.shareDeps, A, { artifact_ids: [mine.id], password: "short" }), z.ZodError);
    await assert.rejects(
      createShare(t.shareDeps, A, { artifact_ids: [mine.id], tenant_id: "ten_b" } as never),
      z.ZodError,
    );
  } finally {
    t.close();
  }
});

test("createShare refuses a pending upload, a deleted file and an expired file", async () => {
  const t = await setupArtifacts();
  try {
    const pending = await createUpload(t.deps, A, { name: "p.bin", size: 1 });
    const deleted = await file(t, "d.txt");
    await deleteArtifact(t.deps, A, deleted.id);
    const expiring = await file(t, "e.txt", "x", { expires_in_days: 1 });
    t.time.advance(2 * DAY);
    for (const id of [pending.artifact_id, deleted.id, expiring.id]) {
      await rejectsWith(createShare(t.shareDeps, A, { artifact_ids: [id] }), "NOT_FOUND");
    }
  } finally {
    t.close();
  }
});

test("a generated password is returned once, stored only as a PBKDF2 hash, and a chosen one is never echoed", async () => {
  const t = await setupArtifacts();
  try {
    const mine = await file(t, "mine.txt");
    const generated = await createShare(t.shareDeps, A, { artifact_ids: [mine.id], password: "generate" });
    assert.match(generated.password ?? "", /^[A-HJ-NP-Z2-9]{16}$/);
    assert.equal(generated.has_password, true);
    const row = await t.db.first<{ password_hash: string; password_salt: string }>(
      "SELECT password_hash, password_salt FROM shares WHERE id = ?",
      [generated.share_id],
    );
    assert.ok(row?.password_hash && row.password_salt);
    assert.ok(!JSON.stringify(row).includes(generated.password as string), "the password is not stored");
    assert.equal(PBKDF2_ITERATIONS, 100_000);

    const chosen = await createShare(t.shareDeps, A, { artifact_ids: [mine.id], password: "correct horse" });
    assert.equal(chosen.has_password, true);
    assert.equal("password" in chosen, false);

    const second = await createShare(t.shareDeps, A, { artifact_ids: [mine.id], password: "generate" });
    assert.notEqual(second.password, generated.password);
    const salts = await t.db.all<{ password_salt: string }>(
      "SELECT password_salt FROM shares WHERE password_salt IS NOT NULL",
    );
    assert.equal(new Set(salts.map((s) => s.password_salt)).size, 3, "every share has its own salt");

    const detail = await getShare(t.shareDeps, A, generated.share_id);
    assert.equal(detail.has_password, true);
    assert.ok(!JSON.stringify(detail).includes(row.password_hash));
    assert.ok(!JSON.stringify(await listShares(t.shareDeps, A)).includes(row.password_hash));
  } finally {
    t.close();
  }
});

// ------------------------------------------------------------------------- owner management

test("getShare, listShares, updateShare and revokeShare work on the caller's own shares only", async () => {
  const t = await setupArtifacts();
  try {
    const a = await file(t, "a.txt");
    const b = await file(t, "b.txt");
    const first = await createShare(t.shareDeps, A, { artifact_ids: [a.id, b.id], title: "Both" });
    t.time.advance(1000);
    const second = await createShare(t.shareDeps, A, { artifact_ids: [a.id] });

    const detail = await getShare(t.shareDeps, A, first.share_id);
    assert.equal(detail.state, "active");
    assert.equal(detail.item_count, 2);
    assert.deepEqual(
      detail.items.map((item) => item.name),
      ["a.txt", "b.txt"],
      "in the order they were shared",
    );
    assert.equal(detail.view_count, 0);

    const listed = await listShares(t.shareDeps, A);
    assert.deepEqual(
      listed.items.map((s) => s.id),
      [second.share_id, first.share_id],
    );
    const paged = await listShares(t.shareDeps, A, { limit: 1 });
    assert.equal(paged.items.length, 1);
    assert.ok(paged.next_cursor);
    assert.deepEqual(
      (await listShares(t.shareDeps, A, { limit: 1, cursor: paged.next_cursor as string })).items.map((s) => s.id),
      [first.share_id],
    );
    await rejectsWith(listShares(t.shareDeps, A, { cursor: "garbage" }), "INVALID_INPUT");

    const retitled = await updateShare(t.shareDeps, A, first.share_id, { title: "Renamed", expires_in_days: 3 });
    assert.equal(retitled.title, "Renamed");
    assert.equal(retitled.expires_at, "2026-11-25T10:00:01.000Z", "three days from now");
    assert.equal(
      (await updateShare(t.shareDeps, A, first.share_id, { expires_in_days: null, title: null })).expires_at,
      null,
    );
    await assert.rejects(updateShare(t.shareDeps, A, first.share_id, {}), z.ZodError);
    await assert.rejects(updateShare(t.shareDeps, A, first.share_id, { password: "short" }), z.ZodError);

    for (const call of [
      () => getShare(t.shareDeps, B, first.share_id),
      () => updateShare(t.shareDeps, B, first.share_id, { title: "hijacked" }),
      () => revokeShare(t.shareDeps, B, first.share_id),
    ]) {
      await rejectsWith(call(), "NOT_FOUND");
    }
    assert.equal((await listShares(t.shareDeps, B)).items.length, 0);
    assert.equal((await getShare(t.shareDeps, A, first.share_id)).title, null);

    const revoked = await revokeShare(t.shareDeps, A, second.share_id);
    assert.equal(revoked.state, "revoked");
    const again = await revokeShare(t.shareDeps, A, second.share_id);
    assert.equal(again.revoked_at, revoked.revoked_at, "revoking twice keeps the first time");
    assert.deepEqual(
      (await listShares(t.shareDeps, A)).items.map((s) => s.id),
      [first.share_id],
      "revoked shares are hidden by default",
    );
    assert.equal((await listShares(t.shareDeps, A, { include_revoked: true })).items.length, 2);
    await rejectsWith(revokeShare(t.shareDeps, A, "abcdefghijklmnopqrstuvwxyz"), "NOT_FOUND");
  } finally {
    t.close();
  }
});

test("sharing needs the write scope, and listing the read scope", async () => {
  const t = await setupArtifacts();
  try {
    const mine = await file(t, "mine.txt");
    const share = await createShare(t.shareDeps, A, { artifact_ids: [mine.id] });
    await assert.doesNotReject(listShares(t.shareDeps, READ_ONLY));
    await assert.doesNotReject(getShare(t.shareDeps, READ_ONLY, share.share_id));
    await rejectsWith(createShare(t.shareDeps, READ_ONLY, { artifact_ids: [mine.id] }), "INSUFFICIENT_SCOPE");
    await rejectsWith(updateShare(t.shareDeps, READ_ONLY, share.share_id, { title: "x" }), "INSUFFICIENT_SCOPE");
    await rejectsWith(revokeShare(t.shareDeps, READ_ONLY, share.share_id), "INSUFFICIENT_SCOPE");
    await rejectsWith(listShares(t.shareDeps, NO_SCOPE), "INSUFFICIENT_SCOPE");
  } finally {
    t.close();
  }
});

// -------------------------------------------------------------------------------- resolving

test("resolveShare: unknown tokens are 404; revoked, expired and emptied shares are 410", async () => {
  const t = await setupArtifacts();
  try {
    const x = await file(t, "x.txt");
    const y = await file(t, "y.txt");
    const status = async (token: string) => {
      try {
        await resolveShare(t.shareDeps, token);
        return 200;
      } catch (error) {
        if (error instanceof ShareUnavailableError) return error.status;
        throw error;
      }
    };
    const live = await createShare(t.shareDeps, A, { artifact_ids: [x.id, y.id] });
    const doomed = await createShare(t.shareDeps, A, { artifact_ids: [x.id] });
    const timed = await createShare(t.shareDeps, A, { artifact_ids: [x.id], expires_in_days: 1 });

    assert.equal(await status(live.share_id), 200);
    assert.equal(await status("abcdefghijklmnopqrstuvwxyz"), 404);
    assert.equal(await status("not a token"), 404);
    assert.equal(await status("' OR 1=1 --"), 404);
    assert.equal(await status(""), 404);

    await revokeShare(t.shareDeps, A, live.share_id);
    assert.equal(await status(live.share_id), 410);

    assert.equal(await status(timed.share_id), 200);
    t.time.advance(2 * DAY);
    assert.equal(await status(timed.share_id), 410);

    assert.equal(await status(doomed.share_id), 200);
    await deleteArtifact(t.deps, A, x.id);
    assert.equal(await status(doomed.share_id), 410, "a share whose every file is gone");
  } finally {
    t.close();
  }
});

// ---------------------------------------------------------------------------- the public page

test("before the password nothing about the share is shown, and the page cannot be cached, indexed or framed", async () => {
  const t = await setupArtifacts();
  try {
    const secret = await file(t, "Top-secret-merger-plan.pdf", "x", { mime: "application/pdf" });
    const share = await createShare(t.shareDeps, A, {
      artifact_ids: [secret.id],
      title: "Confidential Q3 numbers",
      password: "open sesame",
    });
    const response = await renderSharePage(t.shareDeps, get(`/s/${share.share_id}`), share.share_id);
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.match(body, /This link is password-protected/);
    assert.match(body, /<form[^>]*method="post"/);
    for (const hidden of [
      "Top-secret",
      "merger",
      "Confidential",
      "Q3",
      "application/pdf",
      ".pdf",
      "19 B",
      "Download",
      STORAGE_ORIGIN,
    ]) {
      assert.ok(!body.includes(hidden), `the page leaks ${hidden}`);
    }
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.match(response.headers.get("x-robots-tag") ?? "", /noindex/);
    assert.match(body, /<meta name="robots" content="noindex/);
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    const csp = response.headers.get("content-security-policy") ?? "";
    assert.match(csp, /default-src 'none'/);
    assert.ok(!/script-src/.test(csp) && !csp.includes("'unsafe-eval'"), "no script is allowed at all");
    for (const directive of ["img-src", "media-src", "frame-src"]) {
      assert.ok(csp.includes(`${directive} ${STORAGE_ORIGIN};`), `${directive} is limited to the object store`);
    }
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /form-action 'self'/);
    assert.match(csp, /base-uri 'none'/);
    assert.equal(t.store.log.puts.length, 1);

    // The file routes do not hand anything out without the cookie either.
    for (const kind of ["view", "download"] as const) {
      const redirect = await redirectToFile(
        t.shareDeps,
        get(`/s/${share.share_id}/d/${secret.id}`),
        share.share_id,
        secret.id,
        kind,
      );
      assert.equal(redirect.status, 302);
      assert.equal(redirect.headers.get("location"), `/s/${share.share_id}`);
    }
    const detail = await t.db.first<{ view_count: number; download_count: number }>(
      "SELECT view_count, download_count FROM shares WHERE id = ?",
      [share.share_id],
    );
    assert.deepEqual({ ...detail }, { view_count: 0, download_count: 0 });
  } finally {
    t.close();
  }
});

test("a wrong password is refused; the right one sets an HttpOnly cookie scoped to this one share for 12 hours", async () => {
  const t = await setupArtifacts();
  try {
    const f = await file(t, "doc.txt", "hello");
    const share = await createShare(t.shareDeps, A, { artifact_ids: [f.id], password: "open sesame" });
    const path = `/s/${share.share_id}`;

    const wrong = await submitSharePassword(t.shareDeps, post(path, "open sesamee"), share.share_id);
    assert.equal(wrong.status, 401);
    assert.equal(wrong.headers.get("set-cookie"), null);
    const wrongBody = await wrong.text();
    assert.match(wrongBody, /not right/);
    assert.ok(!wrongBody.includes("doc.txt"));
    assert.equal((await submitSharePassword(t.shareDeps, post(path, ""), share.share_id)).status, 401);
    assert.equal((await submitSharePassword(t.shareDeps, post(path, "x".repeat(20_000)), share.share_id)).status, 401);

    const right = await submitSharePassword(t.shareDeps, post(path, "  open sesame  "), share.share_id);
    assert.equal(right.status, 303, "surrounding spaces from a copy-paste are ignored");
    assert.equal(right.headers.get("location"), path);
    const setCookie = right.headers.get("set-cookie") ?? "";
    assert.match(setCookie, new RegExp(`^ms_${share.share_id}=\\d+\\.[A-Za-z0-9_-]+;`));
    assert.ok(setCookie.includes(`Path=/s/${share.share_id};`));
    assert.ok(setCookie.includes(`Max-Age=${SHARE_COOKIE_SECONDS};`) && SHARE_COOKIE_SECONDS === 43_200);
    assert.ok(setCookie.includes("HttpOnly") && setCookie.includes("SameSite=Lax") && setCookie.includes("Secure"));
    assert.ok(!setCookie.includes("open sesame"));
    assert.ok(!/Domain=/i.test(setCookie), "bound to the exact host");

    const viewer = await renderSharePage(t.shareDeps, get(path, { cookie: cookieFrom(right) }), share.share_id);
    const body = await viewer.text();
    assert.equal(viewer.status, 200);
    assert.match(body, /doc\.txt/);
    assert.match(body, new RegExp(`/s/${share.share_id}/d/${f.id}`));
  } finally {
    t.close();
  }
});

test("the password cookie opens one share only, cannot be forged, and ends after 12 hours", async () => {
  const t = await setupArtifacts();
  try {
    const f = await file(t, "doc.txt");
    const one = await createShare(t.shareDeps, A, { artifact_ids: [f.id], password: "shared password" });
    const two = await createShare(t.shareDeps, A, { artifact_ids: [f.id], password: "shared password" });
    const cookieOne = await unlock(t, one.share_id, "shared password");
    const [name, value] = cookieOne.split("=");
    assert.equal(name, shareCookieName(one.share_id));

    const page = async (token: string, cookie: string) =>
      (await (await renderSharePage(t.shareDeps, get(`/s/${token}`, { cookie }), token)).text()).includes(
        "password-protected",
      )
        ? "locked"
        : "open";
    assert.equal(await page(one.share_id, cookieOne), "open");
    // The same value under the other share's cookie name, and the other share's own name, both fail.
    assert.equal(await page(two.share_id, `${shareCookieName(two.share_id)}=${value}`), "locked");
    assert.equal(await page(two.share_id, cookieOne), "locked");

    const [expires, mac] = value.split(".");
    const forged = [
      `${name}=${Number(expires) + 86_400}.${mac}`,
      `${name}=${expires}.${mac.slice(0, -2)}AA`,
      `${name}=${expires}`,
      `${name}=${mac}`,
      `${name}=${expires}.`,
      `${name}=9999999999.${mac}`,
      `${name}=0.${mac}`,
      `${name}=${expires}.${mac}x`,
      `${name}=`,
    ];
    for (const cookie of forged) assert.equal(await page(one.share_id, cookie), "locked", cookie);

    // A cookie signed with another secret, or for another salt, is refused.
    const row = await t.db.first<{ password_salt: string }>("SELECT password_salt FROM shares WHERE id = ?", [
      one.share_id,
    ]);
    const now = Math.floor(t.time.now().getTime() / 1000);
    const salt = row?.password_salt as string;
    assert.equal(
      await verifyShareCookie(SECRET, one.share_id, salt, await signShareCookie(SECRET, one.share_id, salt, now), now),
      true,
    );
    assert.equal(
      await verifyShareCookie(
        SECRET,
        one.share_id,
        salt,
        await signShareCookie("another secret", one.share_id, salt, now),
        now,
      ),
      false,
    );
    assert.equal(
      await verifyShareCookie(
        SECRET,
        one.share_id,
        salt,
        await signShareCookie(SECRET, one.share_id, "other-salt", now),
        now,
      ),
      false,
    );
    assert.equal(
      await verifyShareCookie(SECRET, two.share_id, salt, await signShareCookie(SECRET, one.share_id, salt, now), now),
      false,
    );

    t.time.advance(12 * 60 * 60 * 1000 - 1000);
    assert.equal(await page(one.share_id, cookieOne), "open");
    t.time.advance(2000);
    assert.equal(await page(one.share_id, cookieOne), "locked", "the cookie ends after 12 hours");
  } finally {
    t.close();
  }
});

test("changing or removing the password signs every visitor out", async () => {
  const t = await setupArtifacts();
  try {
    const f = await file(t, "doc.txt");
    const share = await createShare(t.shareDeps, A, { artifact_ids: [f.id], password: "first password" });
    const cookie = await unlock(t, share.share_id, "first password");
    const locked = async () =>
      (
        await (await renderSharePage(t.shareDeps, get(`/s/${share.share_id}`, { cookie }), share.share_id)).text()
      ).includes("password-protected");
    assert.equal(await locked(), false);

    await updateShare(t.shareDeps, A, share.share_id, { password: "second password" });
    assert.equal(await locked(), true);
    assert.equal(
      (await submitSharePassword(t.shareDeps, post(`/s/${share.share_id}`, "first password"), share.share_id)).status,
      401,
    );
    const fresh = await unlock(t, share.share_id, "second password");
    assert.equal(
      (
        await (
          await renderSharePage(t.shareDeps, get(`/s/${share.share_id}`, { cookie: fresh }), share.share_id)
        ).text()
      ).includes("password-protected"),
      false,
    );

    const generated = await updateShare(t.shareDeps, A, share.share_id, { password: "generate" });
    assert.match(generated.password ?? "", /^[A-HJ-NP-Z2-9]{16}$/);
    await unlock(t, share.share_id, generated.password as string);

    const open = await updateShare(t.shareDeps, A, share.share_id, { password: null });
    assert.equal(open.has_password, false);
    const page = await (await renderSharePage(t.shareDeps, get(`/s/${share.share_id}`), share.share_id)).text();
    assert.ok(!page.includes("password-protected"), "no password: the viewer is shown to anyone with the link");
    assert.equal(
      (await submitSharePassword(t.shareDeps, post(`/s/${share.share_id}`, "anything"), share.share_id)).status,
      303,
    );
  } finally {
    t.close();
  }
});

test("wrong guesses are rate limited per visitor and per share", async () => {
  const t = await setupArtifacts();
  try {
    const f = await file(t, "doc.txt");
    const share = await createShare(t.shareDeps, A, { artifact_ids: [f.id], password: "the real one" });
    const guess = (ip: string, password = "nope") =>
      submitSharePassword(
        t.shareDeps,
        post(`/s/${share.share_id}`, password, { "cf-connecting-ip": ip }),
        share.share_id,
      );
    // The window is aligned to the clock, so start at a fresh minute for a stable count.
    const realNow = Date.now;
    Date.now = () => Math.floor(realNow() / 3_600_000) * 3_600_000 + 5_000;
    try {
      for (let attempt = 0; attempt < PASSWORD_ATTEMPTS_PER_MINUTE; attempt += 1) {
        assert.equal((await guess("203.0.113.1")).status, 401, `attempt ${attempt + 1}`);
      }
      const blocked = await guess("203.0.113.1");
      assert.equal(blocked.status, 429);
      assert.ok(Number(blocked.headers.get("retry-after")) >= 1);
      assert.match(await blocked.text(), /Too many attempts/);
      assert.equal((await guess("203.0.113.1", "the real one")).status, 429, "even the right password waits");
      assert.equal(blocked.headers.get("set-cookie"), null);

      // Another visitor has their own allowance, until the share-wide limit is spent.
      assert.equal((await guess("203.0.113.2")).status, 401);
      assert.equal((await guess("203.0.113.2", "the real one")).status, 303);
      let status = 401;
      for (let visitor = 0; visitor < PASSWORD_ATTEMPTS_PER_HOUR && status === 401; visitor += 1) {
        status = (await guess(`198.51.100.${visitor}`)).status;
      }
      assert.equal(status, 429, "the share-wide hourly limit applies across visitors");
    } finally {
      Date.now = realNow;
    }
  } finally {
    t.close();
  }
});

// ------------------------------------------------------------------------------ the viewer

test("a single file shows a preview from the object store, a download button and a short-lived link", async () => {
  const t = await setupArtifacts();
  try {
    const png = await file(t, "Ảnh đẹp.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"), {
      encoding: "base64",
    });
    const share = await createShare(t.shareDeps, A, { artifact_ids: [png.id], title: "My <b>picture</b>" });
    const response = await renderSharePage(t.shareDeps, get(`/s/${share.share_id}`), share.share_id);
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.match(body, /<img src="https:\/\/s3\.test\//);
    const preview = new URL((body.match(/<img src="([^"]+)"/) as RegExpMatchArray)[1].replace(/&amp;/g, "&"));
    assert.equal(preview.origin, STORAGE_ORIGIN);
    assert.equal(preview.searchParams.get("X-Amz-Expires"), String(SHARE_LINK_SECONDS));
    assert.equal(SHARE_LINK_SECONDS, 300);
    assert.match(preview.searchParams.get("response-content-disposition") ?? "", /^inline;/);
    assert.match(body, new RegExp(`href="/s/${share.share_id}/d/${png.id}"`));
    assert.ok(body.includes("My &lt;b&gt;picture&lt;/b&gt;"), "the title is escaped");
    assert.ok(!body.includes("<b>picture"));
    assert.ok(!body.includes("<script"));
    const counters = await t.db.first<{ view_count: number; last_viewed_at: string }>(
      "SELECT view_count, last_viewed_at FROM shares WHERE id = ?",
      [share.share_id],
    );
    assert.equal(counters?.view_count, 1);
    assert.equal(counters?.last_viewed_at, "2026-11-22T10:00:00.000Z");
  } finally {
    t.close();
  }
});

test("each kind of file gets the right preview element, and a type a browser could run gets none", async () => {
  const t = await setupArtifacts();
  try {
    const render = async (name: string, mime: string) => {
      const f = await file(t, name, "x", { mime });
      const share = await createShare(t.shareDeps, A, { artifact_ids: [f.id] });
      return (await renderSharePage(t.shareDeps, get(`/s/${share.share_id}`), share.share_id)).text();
    };
    assert.match(await render("v.mp4", "video/mp4"), /<video src="https:\/\/s3\.test\/[^"]+" controls/);
    assert.match(await render("a.mp3", "audio/mpeg"), /<audio src="https:\/\/s3\.test\//);
    assert.match(await render("d.pdf", "application/pdf"), /<iframe src="https:\/\/s3\.test\/[^"]+" title="d\.pdf">/);
    assert.match(await render("t.txt", "text/plain"), /<iframe [^>]*sandbox>/);
    for (const [name, mime] of [
      ["page.html", "text/html"],
      ["pic.svg", "image/svg+xml"],
      ["data.xml", "application/xml"],
      ["a.zip", "application/zip"],
      ["run.exe", "application/x-msdownload"],
    ]) {
      const body = await render(name, mime);
      assert.ok(!/<(img|video|audio|iframe|object|embed)/.test(body), `${mime} is not previewed`);
      assert.match(body, /Download/);
      assert.ok(
        !body.includes(STORAGE_ORIGIN),
        `${mime} page mints no object-store link until the download is clicked`,
      );
    }
  } finally {
    t.close();
  }
});

test("a bundle lists its files with view only for the safe ones; names are escaped", async () => {
  const t = await setupArtifacts();
  try {
    const png = await file(t, "a.png", "x", { mime: "image/png" });
    const html = await file(t, `<img src=x onerror=alert(1)>.html`, "<h1>", { mime: "text/html" });
    const share = await createShare(t.shareDeps, A, { artifact_ids: [png.id, html.id], title: "Pack" });
    const body = await (await renderSharePage(t.shareDeps, get(`/s/${share.share_id}`), share.share_id)).text();
    assert.match(body, /<h1>Pack<\/h1>/);
    assert.match(body, new RegExp(`/s/${share.share_id}/v/${png.id}`));
    assert.ok(!body.includes(`/v/${html.id}`), "no view link for a file a browser could run");
    assert.match(body, new RegExp(`/s/${share.share_id}/d/${html.id}`));
    assert.ok(body.includes("&lt;img src=x onerror=alert(1)&gt;.html"));
    assert.ok(!body.includes("<img src=x"));
    assert.ok(body.indexOf("a.png") < body.indexOf("&lt;img"), "in the shared order");
  } finally {
    t.close();
  }
});

test("a deleted file leaves the bundle, and a bundle with nothing left is gone (410)", async () => {
  const t = await setupArtifacts();
  try {
    const keep = await file(t, "keep.txt");
    const drop = await file(t, "drop.txt");
    const share = await createShare(t.shareDeps, A, { artifact_ids: [keep.id, drop.id] });
    const page = async () => renderSharePage(t.shareDeps, get(`/s/${share.share_id}`), share.share_id);
    assert.ok((await (await page()).text()).includes("drop.txt"));
    await deleteArtifact(t.deps, A, drop.id);
    const after = await (await page()).text();
    assert.ok(!after.includes("drop.txt"));
    assert.match(after, /Download|keep\.txt/);
    const gone = await redirectToFile(t.shareDeps, get("/"), share.share_id, drop.id, "download");
    assert.equal(gone.status, 404);

    // An expired file drops out the same way, before any cleanup job runs.
    await setExpiry(t.deps, A, keep.id, { expires_in_days: 1 });
    t.time.advance(2 * DAY);
    const last = await page();
    assert.equal(last.status, 410);
    const text = await last.text();
    assert.ok(!text.includes("keep.txt"));
    assert.match(text, /no longer available/);
  } finally {
    t.close();
  }
});

test("revoked and expired links answer 410 on the page, the password form and the file routes", async () => {
  const t = await setupArtifacts();
  try {
    const f = await file(t, "doc.txt");
    const plain = await createShare(t.shareDeps, A, { artifact_ids: [f.id] });
    const locked = await createShare(t.shareDeps, A, {
      artifact_ids: [f.id],
      password: "a password",
      expires_in_days: 1,
    });
    const cookie = await unlock(t, locked.share_id, "a password");

    await revokeShare(t.shareDeps, A, plain.share_id);
    t.time.advance(2 * DAY);
    for (const token of [plain.share_id, locked.share_id]) {
      const headers = { cookie };
      assert.equal(
        (await renderSharePage(t.shareDeps, get(`/s/${token}`, headers), token)).status,
        410,
        `page ${token}`,
      );
      assert.equal((await submitSharePassword(t.shareDeps, post(`/s/${token}`, "a password"), token)).status, 410);
      for (const kind of ["view", "download"] as const) {
        const response = await redirectToFile(t.shareDeps, get("/", headers), token, f.id, kind);
        assert.equal(response.status, 410);
        assert.equal(response.headers.get("location"), null, "no download link is handed out");
      }
    }
    assert.equal(
      (await renderSharePage(t.shareDeps, get("/s/abcdefghijklmnopqrstuvwxyz"), "abcdefghijklmnopqrstuvwxyz")).status,
      404,
    );
    assert.equal((await renderSharePage(t.shareDeps, get("/s/x"), "x")).status, 404);
    const body = await (await renderSharePage(t.shareDeps, get(`/s/${plain.share_id}`), plain.share_id)).text();
    assert.ok(!body.includes("doc.txt"));
  } finally {
    t.close();
  }
});

test("download and view redirect to a 5-minute presigned link, and a file a browser could run is always an attachment", async () => {
  const t = await setupArtifacts();
  try {
    const html = await file(t, "page.html", "<script>alert(1)</script>", { mime: "text/html" });
    const png = await file(t, "pic.png", "x", { mime: "image/png" });
    const share = await createShare(t.shareDeps, A, { artifact_ids: [html.id, png.id] });
    const token = share.share_id;
    const go = async (id: string, kind: "view" | "download") => {
      const response = await redirectToFile(t.shareDeps, get(`/s/${token}/x/${id}`), token, id, kind);
      assert.equal(response.status, 302);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("referrer-policy"), "no-referrer");
      assert.match(response.headers.get("x-robots-tag") ?? "", /noindex/);
      return new URL(response.headers.get("location") as string);
    };

    const htmlView = await go(html.id, "view");
    assert.equal(htmlView.origin, STORAGE_ORIGIN, "served from the object store, never from this origin");
    assert.match(
      htmlView.searchParams.get("response-content-disposition") ?? "",
      /^attachment;/,
      "view of HTML is still an attachment",
    );
    assert.equal(htmlView.searchParams.get("X-Amz-Expires"), "300");
    assert.match(
      (await go(html.id, "download")).searchParams.get("response-content-disposition") ?? "",
      /^attachment;/,
    );

    const pngView = await go(png.id, "view");
    assert.match(pngView.searchParams.get("response-content-disposition") ?? "", /^inline;/);
    assert.equal(pngView.searchParams.get("response-content-type"), "image/png");
    assert.match((await go(png.id, "download")).searchParams.get("response-content-disposition") ?? "", /^attachment;/);

    const counters = await t.db.first<{ view_count: number; download_count: number }>(
      "SELECT view_count, download_count FROM shares WHERE id = ?",
      [token],
    );
    assert.deepEqual({ ...counters }, { view_count: 2, download_count: 2 }, "counted, with no limit on either");
    for (let n = 0; n < 5; n += 1) assert.equal((await go(png.id, "download")).origin, STORAGE_ORIGIN);

    // A file that is not in this share cannot be fetched through it, even another of the owner's files.
    const outsider = await file(t, "outsider.txt");
    for (const id of [outsider.id, "abcdefghijklmnopqrstuvwxyz", "../../etc/passwd", ""]) {
      const response = await redirectToFile(t.shareDeps, get("/"), token, id, "download");
      assert.equal(response.status, 404, id);
      assert.equal(response.headers.get("location"), null);
    }
  } finally {
    t.close();
  }
});

test("a share cannot be used to reach another account's file", async () => {
  const t = await setupArtifacts();
  try {
    const mine = await file(t, "mine.txt");
    const theirs = await putInline(t.deps, B, { name: "theirs.txt", content: "b" });
    const share = await createShare(t.shareDeps, A, { artifact_ids: [mine.id] });
    // Even a share row that was tampered with to point at another tenant's file serves nothing of it.
    await t.db.run("INSERT INTO share_items (share_id, tenant_id, artifact_id, position) VALUES (?, 'ten_a', ?, 1)", [
      share.share_id,
      theirs.id,
    ]);
    const resolved = await resolveShare(t.shareDeps, share.share_id);
    assert.deepEqual(
      resolved.items.map((item) => item.name),
      ["mine.txt"],
    );
    const response = await redirectToFile(t.shareDeps, get("/"), share.share_id, theirs.id, "download");
    assert.equal(response.status, 404);
  } finally {
    t.close();
  }
});

test("a share link works with no sign-in", async () => {
  const t = await setupArtifacts();
  try {
    const f = await file(t, "doc.txt");
    const share = await createShare(t.shareDeps, A, { artifact_ids: [f.id] });
    // The public handlers take no caller or session at all: the token is the whole credential.
    const response = await renderSharePage(t.shareDeps, get(`/s/${share.share_id}`), share.share_id);
    assert.equal(response.status, 200);
    assert.ok((await response.text()).includes("doc.txt"));
  } finally {
    t.close();
  }
});
