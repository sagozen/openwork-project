import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test("i18n parity and placeholder contract", () => {
  const output = execFileSync(
    process.execPath,
    ["--experimental-strip-types", join(root, "scripts", "check-i18n.mjs")],
    { cwd: root },
  );
  assert.match(output.toString(), /parity OK/);
});

test("CSS uses defined tokens only", () => {
  execFileSync(process.execPath, [join(root, "..", "tokens", "scripts", "build.mjs")], {
    cwd: join(root, "..", "tokens"),
  });
  const output = execFileSync(process.execPath, [join(root, "scripts", "check-css.mjs")], { cwd: root });
  assert.match(output.toString(), /all defined/);
});

test("every component group is exported", () => {
  const index = readFileSync(join(root, "src", "index.ts"), "utf8");
  for (const group of ["actions", "forms", "data", "feedback", "layout", "marketing", "editor"]) {
    assert.ok(index.includes(`./components/${group}.js`), `missing export for ${group}`);
  }
});

test("no secrets or document content in analytics helper", () => {
  const source = readFileSync(join(root, "src", "analytics.ts"), "utf8");
  assert.match(source, /isAllowedEvent/);
  assert.match(source, /eventPropErrors/);
  assert.ok(!source.includes("localStorage"));
});

test("all component files are finite and readable", () => {
  const dir = join(root, "src", "components");
  for (const file of readdirSync(dir)) {
    const source = readFileSync(join(dir, file), "utf8");
    assert.ok(source.length > 100, `${file} looks empty`);
    assert.ok(source.includes("export function") || source.includes("export interface"), `${file} exports something`);
  }
});
