import assert from "node:assert/strict";
import { test } from "node:test";
import { docsHeadings, docsPlainText, fillPlaceholders, renderDocs, slugify } from "../src/docs-markdown";

const sample = `# Docs

## Limits and pricing {#limits}

Costs **{{credits}}** credits. See [the API](/docs#endpoints) or [bad](javascript:alert(1)).

### Limits and pricing

| Plan | Price |
|---|---|
| Starter | \`$10\` |

\`\`\`bash
# not a heading
curl -H "x: <y>" https://example.test
\`\`\`

- one
- two

1. first
2. second

> Note with <b>html</b>
`;

test("placeholders are filled and unknown names fail loudly", () => {
  assert.equal(fillPlaceholders("{{a}} and {{ b }}", { a: 1, b: "two" }), "1 and two");
  assert.throws(() => fillPlaceholders("{{missing}}", {}), /missing/);
});

test("headings get explicit or slugged ids, deduplicated, ignoring code fences", () => {
  assert.deepEqual(
    docsHeadings(sample).map((heading) => heading.id),
    ["docs", "limits", "limits-and-pricing"],
  );
  assert.equal(slugify("n8n / automation"), "n8n-automation");
  assert.equal(slugify("`Idempotency-Key` header"), "idempotency-key-header");
});

test("the renderer escapes HTML, keeps safe links only and wraps code for copying", () => {
  const { html, headings } = renderDocs(fillPlaceholders(sample, { credits: 3 }));
  assert.deepEqual(
    headings.map((heading) => heading.id),
    docsHeadings(sample).map((heading) => heading.id),
  );
  assert.match(html, /<h2 id="limits">Limits and pricing /);
  assert.match(html, /<strong>3<\/strong>/);
  assert.match(html, /<a href="\/docs#endpoints">the API<\/a>/);
  assert.doesNotMatch(html, /javascript:/);
  assert.match(html, /<td><code>\$10<\/code><\/td>/);
  assert.match(html, /data-copy-code/);
  assert.match(html, /x: &lt;y&gt;/);
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(html, /<ol><li>first<\/li><li>second<\/li><\/ol>/);
  assert.match(html, /<blockquote><p>Note with &lt;b&gt;html&lt;\/b&gt;<\/p><\/blockquote>/);
  assert.doesNotMatch(html, /<h1 id="not-a-heading"/);
});

test("plain text drops explicit heading ids", () => {
  assert.match(docsPlainText(sample), /^## Limits and pricing$/m);
  assert.doesNotMatch(docsPlainText(sample), /\{#limits\}/);
});
