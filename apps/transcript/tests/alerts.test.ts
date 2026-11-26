import assert from "node:assert/strict";
import { test } from "node:test";
import "../src/lib/platform";
import { alertOperators, WORKER_OFFLINE_THROTTLE } from "@templatedesign/platform/alerts";
import type { Db } from "@templatedesign/platform/db";
import { createTestDb } from "./support/db";
import { testEnv } from "./support/fixtures";

async function alertEmails(db: Db): Promise<number> {
  const row = await db.first<{ count: number }>(
    "SELECT COUNT(*) AS count FROM email_outbox WHERE template = 'billing_alert'",
  );
  return row?.count ?? 0;
}

test("an alert without a throttle keeps the default of one email per hour", async () => {
  const { db, close } = createTestDb();
  try {
    const env = testEnv();
    const outcomes: boolean[] = [];
    for (let index = 0; index < 3; index += 1) {
      const result = await alertOperators(env, db, {
        kind: "transcript_failure_rate",
        summary: "too many failures",
        detail: { failures: 3, total: 10 },
      });
      outcomes.push(result.emailed);
    }
    assert.deepEqual(outcomes, [true, false, false]);
    assert.equal(await alertEmails(db), 1);
  } finally {
    close();
  }
});

test("every worker-offline symptom draws from one budget of three emails", async () => {
  const { db, close } = createTestDb();
  try {
    const env = testEnv();
    const kinds = ["transcript_no_workers", "transcript_no_primary", "transcript_queue_age"];
    const outcomes: boolean[] = [];
    for (let index = 0; index < 6; index += 1) {
      const result = await alertOperators(env, db, {
        kind: kinds[index % kinds.length],
        summary: "worker offline",
        detail: { last_heartbeat_at: "never" },
        throttle: WORKER_OFFLINE_THROTTLE,
      });
      outcomes.push(result.emailed);
    }
    assert.deepEqual(outcomes, [true, true, true, false, false, false]);
    assert.equal(await alertEmails(db), 3);
  } finally {
    close();
  }
});
