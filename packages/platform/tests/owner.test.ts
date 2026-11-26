import assert from "node:assert/strict";
import test from "node:test";
import { isOwnerEmail, ownerEmails } from "../src/owner";

test("owner-only mode is off unless OWNER_EMAILS is set", () => {
  assert.equal(ownerEmails({}), null);
  assert.deepEqual(ownerEmails({ OWNER_EMAILS: "" }), []);
  assert.deepEqual(ownerEmails({ OWNER_EMAILS: " Owner@Example.com , second@example.com,junk" }), [
    "owner@example.com",
    "second@example.com",
  ]);
});

test("only a listed address is an owner, and an empty list admits nobody", () => {
  const owners = ["owner@example.com"];
  assert.equal(isOwnerEmail("Owner@Example.com ", owners), true);
  assert.equal(isOwnerEmail("owner@example.com.evil.test", owners), false);
  assert.equal(isOwnerEmail("other@example.com", owners), false);
  assert.equal(isOwnerEmail(undefined, owners), false);
  assert.equal(isOwnerEmail(["owner@example.com"], owners), false);
  assert.equal(isOwnerEmail("owner@example.com", []), false);
});
