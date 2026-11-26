import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { COMPANY, fillCompany } from "@templatedesign/platform/company";

const source = readFileSync(new URL("../src/content/legal.md", import.meta.url), "utf8");

test("legal text has no unresolved placeholders", () => {
  for (const marker of ["TODO", "TBD", "{{"]) assert.ok(!source.includes(marker), `legal.md contains ${marker}`);
});

test("legal text has the six anchored sections, in order", () => {
  // Astro derives heading ids by lower-casing and hyphenating the heading text.
  const anchors = [...source.matchAll(/^## (.+)$/gm)].map((match) =>
    match[1].trim().toLowerCase().replace(/\s+/g, "-"),
  );
  assert.deepEqual(anchors, ["terms", "privacy", "refunds", "acceptable-use", "cookies", "contact"]);
});

test("company tokens resolve to the single company constant", () => {
  const html = fillCompany(source);
  assert.ok(!/COMPANY_/.test(html));
  for (const value of [COMPANY.name, COMPANY.address, COMPANY.phone, COMPANY.email, COMPANY.byline]) {
    assert.ok(html.includes(value), `legal text is missing ${value}`);
  }
  assert.ok(html.includes("tel:+13074242696"));
  assert.throws(() => fillCompany("COMPANY_UNKNOWN"), /Unknown company token/);
});
