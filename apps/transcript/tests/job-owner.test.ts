import assert from "node:assert/strict";
import { test } from "node:test";
import { browserActor, canViewJob } from "../src/lib/job-owner";

const user = { id: "u1", email: "a@example.com", name: "A", emailVerified: true };
const tenantJob = { tenant_id: "t1", guest_id: null };
const guestJob = { tenant_id: null, guest_id: "gst_1" };

test("a signed-in visitor sees only their tenant's jobs", () => {
  const locals = { user, tenantId: "t1", guestId: "gst_1" };
  assert.equal(canViewJob(locals, tenantJob), true);
  assert.equal(canViewJob({ ...locals, tenantId: "t2" }, tenantJob), false);
  // Same rule as the job API, so downloads and polling work for whatever the page shows.
  assert.equal(canViewJob(locals, guestJob), false);
  assert.equal(browserActor(locals).guestId, null);
});

test("a guest sees only jobs made with their guest cookie", () => {
  assert.equal(canViewJob({ guestId: "gst_1" }, guestJob), true);
  assert.equal(canViewJob({ guestId: "gst_2" }, guestJob), false);
  assert.equal(canViewJob({ guestId: "gst_1" }, tenantJob), false);
  assert.equal(canViewJob({}, { tenant_id: null, guest_id: null }), false);
});
