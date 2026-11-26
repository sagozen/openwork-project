import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const run = (script) => execFileSync(process.execPath, [join(root, "scripts", script)], { cwd: root });

test("contract linter passes", () => {
  const output = run("validate.mjs").toString();
  assert.match(output, /all checks pass/);
});

test("error catalogue is stable and bilingual", () => {
  const errors = JSON.parse(readFileSync(join(root, "catalogue", "errors.json"), "utf8"));
  assert.equal(errors.codes.length, 15);
  for (const entry of errors.codes) {
    assert.ok(entry.title.vi.length > 0, `${entry.code} needs a VI title`);
    assert.ok(entry.detail.vi.length > 0, `${entry.code} needs a VI detail`);
  }
});

test("analytics events never allow document content", () => {
  const analytics = JSON.parse(readFileSync(join(root, "catalogue", "analytics-events.json"), "utf8"));
  const forbidden = new Set(analytics.forbiddenProperties);
  const used = new Set(analytics.events.flatMap((event) => event.props));
  for (const prop of used) assert.ok(!forbidden.has(prop), `${prop} must stay out of analytics`);
});

test("openapi paths cover the V1 core surface", () => {
  const yaml = readFileSync(join(root, "openapi", "openapi.yaml"), "utf8");
  for (const path of ["/jobs", "/jobs/{id}", "/outputs/{id}/download", "/templates/{id}", "/capabilities", "/health"]) {
    assert.ok(yaml.includes(`  ${path}:`), `missing ${path}`);
  }
});

test("template profile forbids non-allowlisted element types", () => {
  const schema = JSON.parse(readFileSync(join(root, "schemas", "template-profile.schema.json"), "utf8"));
  const types = schema.$defs.element.properties.type.enum;
  assert.deepEqual(types, [
    "text",
    "image",
    "line",
    "rect",
    "ellipse",
    "qrcode",
    "code128",
    "pagenum",
    "band",
    "cfo-flow",
  ]);
  assert.ok(!types.includes("script"));
});

test("event checker runs against the UI tree", () => {
  const output = execFileSync(process.execPath, [join(root, "scripts", "check-events.mjs")], { cwd: root }).toString();
  assert.match(output, /allowlist OK/);
});
