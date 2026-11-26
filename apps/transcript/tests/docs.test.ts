import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { docsHeadings, docsPlainText, renderDocs } from "@templatedesign/platform/docs-markdown";
import { DOCS_ANCHORS } from "@templatedesign/platform/legacy-redirects";
import { docsSource } from "../src/lib/docs";
import { CREDIT_PACKS, formatUsd } from "../src/lib/packs";
import { PRICING } from "../src/lib/pricing-core";

const raw = readFileSync(new URL("../src/content/docs.md", import.meta.url), "utf8");
const source = docsSource(raw);
const ids = new Set(docsHeadings(source).map((heading) => heading.id));

test("every old /docs/* page redirects to a heading that exists", () => {
  for (const [path, anchor] of Object.entries(DOCS_ANCHORS.transcript)) {
    assert.ok(ids.has(anchor), `/docs/${path} -> #${anchor} has no heading`);
  }
});

test("the page has the sections people and agents look for", () => {
  for (const id of [
    "quickstart",
    "authentication",
    "endpoints",
    "webhooks",
    "limits",
    "errors",
    "n8n",
    "sources",
    "add-ons",
    "changelog",
  ]) {
    assert.ok(ids.has(id), id);
  }
});

test("prices and caps are rendered from PRICING and the pack list, not typed into the Markdown", () => {
  assert.doesNotMatch(raw, /\$\d/, "no dollar amounts in the Markdown source");
  assert.doesNotMatch(raw, /\d+ credits?\b/, "no credit amounts in the Markdown source");
  for (const pack of CREDIT_PACKS) {
    assert.ok(source.includes(`| ${pack.name.en} | ${formatUsd(pack.priceCents)} |`), pack.id);
  }
  assert.ok(source.includes(`${PRICING.creditsPerMinute} credits per started minute`));
  assert.doesNotMatch(source, /\{\{\s*[A-Za-z]/, "no placeholder is left unfilled");
});

test("the HTML ids match the headings and the text output drops render hints", () => {
  const { headings } = renderDocs(source);
  assert.deepEqual(new Set(headings.map((heading) => heading.id)), ids);
  assert.doesNotMatch(docsPlainText(source), /\{#[a-z-]+\}/);
});
