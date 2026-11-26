import assert from "node:assert/strict";
import { test } from "node:test";
import { EMPTY_STATE, homeStateHref, isPrivateState, readHomeState } from "../src/lib/home-state";

const read = (query: string) => readHomeState(new URLSearchParams(query));

test("reads each landing state from the query string", () => {
  assert.deepEqual(read(""), EMPTY_STATE);
  assert.equal(read("job=job_abc123").job, "job_abc123");
  assert.equal(read("payment=pay_1").payment, "pay_1");
  assert.deepEqual(
    { topup: read("topup=1&checkout=cancelled").topup, cancelled: read("topup=1&checkout=cancelled").cancelled },
    { topup: true, cancelled: true },
  );
  assert.equal(read("account=api").account, "api");
  assert.equal(read("account=settings").account, "settings");
  assert.equal(read("account=wallet").account, "wallet");
  assert.equal(read("signin=1&next=/admin").next, "/admin");
});

test("drops malformed ids, unknown panels and unsafe sign-in targets", () => {
  assert.equal(read("job=../../etc").job, null);
  assert.equal(read(`job=${"a".repeat(65)}`).job, null);
  assert.equal(read("account=admin").account, null);
  assert.equal(read("checkout=cancelled").cancelled, false);
  assert.equal(read("signin=1&next=//evil.com").next, "/");
  assert.equal(read("signin=1&next=https://evil.com").next, "/");
  assert.equal(read("signin=1&next=/\\evil.com").next, "/");
});

test("writes a state back to a URL that reads the same", () => {
  const cases = [
    "/",
    "/?job=j1",
    "/?topup=1",
    "/?topup=1&checkout=cancelled",
    "/?account=api",
    "/?signin=1&next=%2Fadmin",
  ];
  for (const href of cases) {
    const state = read(href.slice(2));
    assert.equal(homeStateHref(state), href);
  }
  assert.equal(homeStateHref({ ...EMPTY_STATE, next: "/admin" }), "/", "next only travels with sign-in");
});

test("personal states are not indexable, the plain landing page is", () => {
  assert.equal(isPrivateState(new URLSearchParams("")), false);
  assert.equal(isPrivateState(new URLSearchParams("link=https://youtu.be/x")), false);
  for (const query of ["job=1", "payment=1", "account=api", "topup=1", "signin=1"]) {
    assert.equal(isPrivateState(new URLSearchParams(query)), true, query);
  }
});
