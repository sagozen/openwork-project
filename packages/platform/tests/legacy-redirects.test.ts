import assert from "node:assert/strict";
import { test } from "node:test";
import { type LegacyApp, legacyRedirect, safeNext } from "../src/legacy-redirects";

const go = (path: string, app: LegacyApp) => legacyRedirect(new URL(path, "https://example.test"), app);

const both: Array<[string, string]> = [
  ["/app", "/"],
  ["/app/jobs", "/"],
  ["/app/jobs/job_1", "/?job=job_1"],
  ["/app/credits", "/?topup=1"],
  ["/app/credits?checkout=cancelled", "/?topup=1&checkout=cancelled"],
  ["/app/credits/return?payment=pay_9", "/?payment=pay_9"],
  ["/app/developers", "/?account=api"],
  ["/app/settings", "/?account=settings"],
  ["/pricing", "/#pricing"],
  ["/auth/sign-in", "/?signin=1"],
  ["/auth/check-email", "/?signin=1"],
  ["/auth/sign-in?next=%2Fapp%2Fcredits", "/?signin=1&next=%2Fapp%2Fcredits"],
  ["/docs/webhooks", "/docs#webhooks"],
  ["/docs/unknown-page", "/docs"],
  ["/legal/terms", "/legal#terms"],
  ["/legal/privacy", "/legal#privacy"],
];

for (const app of ["web", "transcript"] as const) {
  for (const [from, to] of both) {
    test(`${app}: ${from} -> ${to}`, () => assert.deepEqual(go(from, app), { location: to }));
  }
}

const web: Array<[string, string]> = [
  ["/app/templates", "/"],
  ["/app/assets", "/"],
  ["/app/use/invoice", "/?template=invoice"],
  ["/app/batch/invoice", "/?batch=invoice"],
  ["/app/editor/tpl_1", "/?edit=tpl_1"],
  ["/share/tok", "/?share=tok"],
  ["/share/tok/report", "/?share=tok&report=1"],
  ["/templates/certificates", "/templates"],
];
for (const [from, to] of web) {
  test(`web: ${from} -> ${to}`, () => assert.deepEqual(go(from, "web"), { location: to }));
}

test("web: /vi routes go to the English route and set the locale", () => {
  assert.deepEqual(go("/vi", "web"), { location: "/", setLocale: "vi" });
  assert.deepEqual(go("/vi/mau", "web"), { location: "/templates", setLocale: "vi" });
  assert.deepEqual(go("/vi/mau/invoice", "web"), { location: "/templates/invoice", setLocale: "vi" });
  assert.deepEqual(go("/vi/pricing", "web"), { location: "/#pricing", setLocale: "vi" });
});

test("transcript: /transcript/:id goes to the job state", () => {
  assert.deepEqual(go("/transcript/abc", "transcript"), { location: "/?job=abc" });
});

test("kept and unrelated routes are not redirected", () => {
  for (const path of [
    "/",
    "/docs",
    "/legal",
    "/templates",
    "/templates/invoice",
    "/admin/users",
    "/api/v1/health",
    "/llms.txt",
  ]) {
    assert.equal(go(path, "web"), null, path);
  }
  assert.equal(go("/share/tok", "transcript"), null);
});

test("open redirects are neutralised", () => {
  for (const bad of ["//evil.com", "https://evil.com", "/\\evil.com", "javascript:alert(1)", "", "/ok\n//evil"]) {
    assert.equal(safeNext(bad), "/", JSON.stringify(bad));
  }
  assert.equal(safeNext("/app/credits"), "/app/credits");
  const hit = go(`/auth/sign-in?next=${encodeURIComponent("//evil.com")}`, "web");
  assert.deepEqual(hit, { location: "/?signin=1" });
});
