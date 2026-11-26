import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  abuseOverview,
  abuseSubjects,
  assertNotBlocked,
  blockSubject,
  extendAbuseBlock,
  findActiveBlock,
  recordAbuseSignal,
  releaseAbuseBlock,
} from "../src/abuse";
import { renderEmail } from "../src/emails/templates";
import { HttpError } from "../src/http";
import type { PlatformEnv } from "../src/types";
import { createTestDb } from "./support/db";
import { configureTestPlatform } from "./support/platform";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const abuseSql = readFileSync(join(root, "sql", "abuse_blocks.sql"), "utf8");

const env = {
  APP_ORIGIN: "https://test.example",
  BETTER_AUTH_URL: "https://test.example",
  ADMIN_EMAILS: "ops@test.example",
  EMAIL_PROVIDER: "log",
} as unknown as PlatformEnv;

function abuseDb() {
  configureTestPlatform();
  const testDb = createTestDb();
  testDb.raw.exec(abuseSql);
  return testDb;
}

test("a tenant is judged alone; a guest by guest id and IP", () => {
  assert.deepEqual(abuseSubjects({ tenantId: "t1", guestId: "g1", ip: "1.2.3.4" }), [{ kind: "tenant", id: "t1" }]);
  assert.deepEqual(abuseSubjects({ guestId: "g1", ip: " 1.2.3.4 " }), [
    { kind: "guest", id: "g1" },
    { kind: "ip", id: "1.2.3.4" },
  ]);
  assert.deepEqual(abuseSubjects({}), []);
});

test("crossing the hourly job threshold blocks, cancels queued jobs and emails once", async () => {
  const { db, close } = abuseDb();
  try {
    const subjects = abuseSubjects({ guestId: "g1", ip: "9.9.9.9" });
    const cancelled: string[] = [];
    const hooks = {
      policy: { jobsPerHour: 3, blockMinutes: 30 },
      cancelQueuedJobs: async (subject: { kind: string; id: string }) => {
        cancelled.push(`${subject.kind}:${subject.id}`);
        return 2;
      },
    };
    const now = Date.parse("2026-10-30T10:05:00Z");
    for (let index = 0; index < 3; index += 1) {
      assert.equal(await recordAbuseSignal(env, db, subjects, "job_created", hooks, 1, now), null);
    }
    const block = await recordAbuseSignal(env, db, subjects, "job_created", hooks, 1, now);
    assert.ok(block);
    assert.equal(block.subject_kind, "guest");
    assert.equal(block.reason, "too_many_jobs");
    assert.equal(block.cancelled_jobs, 2);
    assert.deepEqual(cancelled, ["guest:g1"]);
    assert.equal(block.blocked_until, new Date(now + 30 * 60 * 1000).toISOString());

    await assert.rejects(
      () => assertNotBlocked(db, subjects, now + 60_000),
      (error: unknown) =>
        error instanceof HttpError &&
        error.status === 429 &&
        error.details?.blocked === true &&
        new Headers(error.headers).get("retry-after") === String(29 * 60),
    );
    await assertNotBlocked(db, subjects, now + 31 * 60 * 1000);

    const emails = await db.all<{ template: string; payload_json: string }>(
      "SELECT template, payload_json FROM email_outbox WHERE template = 'abuse_alert'",
    );
    assert.equal(emails.length, 1);
    assert.match(JSON.parse(emails[0].payload_json).url, /^https:\/\/test\.example\/admin\/abuse\/\?block=abuse_/);
  } finally {
    close();
  }
});

test("rate-limit hits have their own threshold and an active block is not duplicated", async () => {
  const { db, close } = abuseDb();
  try {
    const subjects = abuseSubjects({ tenantId: "t1" });
    const hooks = { policy: { rateLimitedPerHour: 1 } };
    const now = Date.parse("2026-10-30T10:05:00Z");
    assert.equal(await recordAbuseSignal(env, db, subjects, "rate_limited", hooks, 1, now), null);
    const first = await recordAbuseSignal(env, db, subjects, "rate_limited", hooks, 1, now);
    assert.equal(first?.reason, "too_many_rate_limited");
    assert.equal(await recordAbuseSignal(env, db, subjects, "rate_limited", hooks, 1, now), null);
    const rows = await db.all("SELECT id FROM abuse_blocks");
    assert.equal(rows.length, 1);
  } finally {
    close();
  }
});

test("admins release, extend and block until released", async () => {
  const { db, close } = abuseDb();
  try {
    const subject = { kind: "tenant" as const, id: "t2" };
    const block = await blockSubject(env, db, subject, {
      reason: "manual",
      source: "admin",
      minutes: 10,
      createdBy: "admin-1",
    });
    assert.ok(await findActiveBlock(db, [subject]));
    const adminEmails = await db.all("SELECT id FROM email_outbox WHERE template = 'abuse_alert'");
    assert.equal(adminEmails.length, 0, "manual blocks do not email operators");

    assert.equal(await extendAbuseBlock(db, block.id, null), true);
    assert.ok(await findActiveBlock(db, [subject], Date.now() + 365 * 86400_000));

    assert.equal(await releaseAbuseBlock(db, block.id, "admin-1"), true);
    assert.equal(await releaseAbuseBlock(db, block.id, "admin-1"), false);
    assert.equal(await findActiveBlock(db, [subject]), null);
    await assertNotBlocked(db, [subject]);
  } finally {
    close();
  }
});

test("the overview lists active blocks and the hour's top job creators", async () => {
  const { db, close } = abuseDb();
  try {
    const now = Date.parse("2026-10-30T10:05:00Z");
    for (let index = 0; index < 4; index += 1) {
      await recordAbuseSignal(env, db, abuseSubjects({ tenantId: "busy" }), "job_created", {}, 1, now);
    }
    await recordAbuseSignal(env, db, abuseSubjects({ guestId: "g:7", ip: "2001:db8::1" }), "job_created", {}, 1, now);
    await blockSubject(env, db, { kind: "ip", id: "5.5.5.5" }, { reason: "manual", source: "admin", minutes: 5, now });

    const overview = await abuseOverview(db, now);
    assert.equal(overview.active.length, 1);
    assert.deepEqual(overview.topCreators[0], { kind: "tenant", id: "busy", jobs: 4 });
    assert.ok(overview.topCreators.some((row) => row.kind === "ip" && row.id === "2001:db8::1"));
    assert.ok(overview.topCreators.some((row) => row.kind === "guest" && row.id === "g:7"));
    assert.equal((await abuseOverview(db, now + 6 * 60 * 1000)).active.length, 0);
  } finally {
    close();
  }
});

test("operator emails carry the admin action link", () => {
  configureTestPlatform();
  const abuse = renderEmail("abuse_alert", "en", {
    subject: "ip 1.2.3.4",
    url: "https://test.example/admin/abuse/?block=x",
  });
  assert.ok(abuse.links.includes("https://test.example/admin/abuse/?block=x"));
  assert.match(abuse.text, /Review in Admin: https:\/\/test\.example\/admin\/abuse\/\?block=x/);

  const worker = renderEmail("worker_alert", "en", {
    worker: "home-gpu",
    metric: "GPU temperature",
    url: "https://test.example/admin/workers/?worker=w1&action=disable",
  });
  assert.ok(worker.links.includes("https://test.example/admin/workers/?worker=w1&action=disable"));
  assert.match(worker.text, /TestProduct worker fleet/);
  assert.equal(renderEmail("worker_alert", "en", { worker: "w" }).links.length, 1, "no action link without a url");
});
