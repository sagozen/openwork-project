import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
execFileSync(process.execPath, [join(root, "scripts", "build.mjs")], { cwd: root, stdio: "pipe" });

const css = readFileSync(join(root, "dist", "css", "tokens.css"), "utf8");
const ts = readFileSync(join(root, "dist", "ts", "tokens.ts"), "utf8");
const typst = readFileSync(join(root, "dist", "typst", "tokens.typ"), "utf8");
const json = JSON.parse(readFileSync(join(root, "dist", "json", "tokens.json"), "utf8"));
const source = JSON.parse(readFileSync(join(root, "tokens", "td.tokens.json"), "utf8"));
const registry = JSON.parse(readFileSync(join(root, "themes", "registry.json"), "utf8"));
const thanhVi = JSON.parse(readFileSync(join(root, "themes", "thanh-vi.tokens.json"), "utf8"));

/**
 * Runs the build and the contrast gate on a private copy of the package after `mutate` edits its
 * theme files, so a deliberately broken theme never touches the package's own build output.
 */
function runOnCopy(mutate) {
  const copy = mkdtempSync(join(tmpdir(), "td-tokens-"));
  try {
    for (const dir of ["scripts", "tokens", "themes"]) cpSync(join(root, dir), join(copy, dir), { recursive: true });
    mutate(copy);
    const build = spawnSync(process.execPath, [join(copy, "scripts", "build.mjs")], { cwd: copy, encoding: "utf8" });
    if (build.status !== 0) return { stage: "build", status: build.status, output: build.stdout + build.stderr };
    const check = spawnSync(process.execPath, [join(copy, "scripts", "check-contrast.mjs")], {
      cwd: copy,
      encoding: "utf8",
    });
    return { stage: "check", status: check.status, output: check.stdout + check.stderr };
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}

function editTheme(copy, edit) {
  const path = join(copy, "themes", "thanh-vi.tokens.json");
  const theme = JSON.parse(readFileSync(path, "utf8"));
  edit(theme.theme);
  writeFileSync(path, JSON.stringify(theme));
}

test("every semantic token reaches CSS", () => {
  const semantic = Object.keys(json.tokens).filter((path) => {
    const [group, theme] = path.split(".");
    return group !== "color" || theme === "light" || theme === "dark";
  });
  for (const path of semantic) {
    if (path.startsWith("color.light.") || path.startsWith("color.dark.")) continue;
    if (path.startsWith("chart.") && path.endsWith("dash")) continue;
    if (json.tokens[path] && typeof json.tokens[path] === "object") continue;
    const name = `--td-${path
      .split(".")
      .filter((part) => part !== "light" && part !== "dark")
      .join("-")
      .replaceAll("_", "-")}`;
    if (path.startsWith("color.primitive")) continue;
    assert.ok(css.includes(`${name}:`), `CSS is missing ${name} for ${path}`);
  }
});

test("light and dark blocks contain their semantic colours", () => {
  assert.match(css, /--td-color-bg:\s*#FAF8F4/);
  assert.match(css, /\[data-theme="dark"\][\s\S]*--td-color-bg:\s*#121110/);
  assert.match(css, /prefers-color-scheme:\s*dark/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
});

test("aliases are resolved, never leaked", () => {
  assert.ok(!css.includes("{td."), "CSS contains an unresolved alias");
  assert.ok(!ts.includes("{td."), "TypeScript contains an unresolved alias");
});

test("typst output is generated for documents", () => {
  assert.match(typst, /#let td-color-light = \(/);
  assert.match(typst, /"primary": rgb\("#0F5C57"\)/);
  assert.match(typst, /"series-1": rgb\("#0F5C57"\)/);
});

test("build is deterministic", () => {
  const first = readFileSync(join(root, "dist", "json", "tokens.json"), "utf8");
  execFileSync(process.execPath, [join(root, "scripts", "build.mjs")], { cwd: root, stdio: "pipe" });
  const second = readFileSync(join(root, "dist", "json", "tokens.json"), "utf8");
  assert.equal(first, second);
});

test("contrast contract passes", () => {
  const out = execFileSync(process.execPath, [join(root, "scripts", "check-contrast.mjs")], { cwd: root });
  assert.match(out.toString(), /pairs pass/);
});

test("token source has the required groups", () => {
  for (const group of [
    "color",
    "font",
    "space",
    "radius",
    "elevation",
    "motion",
    "breakpoint",
    "z",
    "chart",
    "component",
  ]) {
    assert.ok(source.td[group], `missing token group: ${group}`);
  }
});

test("generated files exist", () => {
  for (const file of ["css/tokens.css", "ts/tokens.ts", "typst/tokens.typ", "json/tokens.json"]) {
    assert.ok(existsSync(join(root, "dist", file)), `missing dist/${file}`);
  }
});

test("each authored theme is one data-theme block with every colour role and both fonts", () => {
  // The selector also closes the platform light block's list; the theme block is the one with roles.
  const block = [...css.matchAll(/^\[data-theme="thanh-vi"\] \{([^}]*)\}/gm)].find((match) =>
    match[1].includes("--td-theme-"),
  );
  assert.ok(block, "missing the thanh-vi block");
  for (const role of registry.roles) {
    const value = thanhVi.theme.color[role].$value;
    assert.match(block[1], new RegExp(`--td-theme-${role}: ${value};`), `thanh-vi block is missing ${role}`);
  }
  assert.match(block[1], /--td-theme-font-display: "Lora Variable", Lora,/);
  assert.match(block[1], /--td-theme-font-ui: "Be Vietnam Pro",/);
  assert.match(block[1], /color-scheme: light;/);
});

test("a light theme keeps the platform's light palette when the device prefers dark", () => {
  assert.match(css, /:root:not\(\[data-theme="light"\]\):not\(\[data-theme="thanh-vi"\]\)/);
  assert.match(css, /^:root,\n\[data-theme="light"\],\n\[data-theme="thanh-vi"\] \{/m);
});

test("identity-only themes reach the registry but never the stylesheet", () => {
  const unauthored = registry.themes.filter((theme) => !theme.tokens);
  assert.equal(unauthored.length, 5);
  for (const theme of unauthored) {
    assert.ok(!css.includes(`[data-theme="${theme.id}"]`), `${theme.id} should have no CSS`);
    assert.ok(!(theme.id in json.themes), `${theme.id} should have no palette`);
    assert.match(ts, new RegExp(`id: "${theme.id}",[\\s\\S]*?available: false,\\s*palette: null`));
  }
  assert.match(ts, /export type AvailableThemeId = "thanh-vi";/);
});

test("the contrast gate covers every authored theme", () => {
  const out = execFileSync(process.execPath, [join(root, "scripts", "check-contrast.mjs")], { cwd: root }).toString();
  for (const pair of registry.contrast) {
    assert.match(out, new RegExp(`thanh-vi\\s+${pair.fg} on ${pair.bg}\\s+[\\d.]+ : [\\d.]+\\s+PASS`));
  }
});

test("a theme token that breaks a contrast pair fails the gate", () => {
  const result = runOnCopy((copy) =>
    editTheme(copy, (theme) => {
      theme.color["ink-3"].$value = "#B8BAB2";
    }),
  );
  assert.equal(result.stage, "check");
  assert.equal(result.status, 1);
  assert.match(result.output, /thanh-vi\s+ink-3 on surface-2\s+[\d.]+ : 4\.5\s+FAIL/);
});

test("a theme missing a colour role, or carrying layout, fails the build", () => {
  const missing = runOnCopy((copy) =>
    editTheme(copy, (theme) => {
      delete theme.color["amber-soft"];
    }),
  );
  assert.equal(missing.stage, "build");
  assert.notEqual(missing.status, 0);
  assert.match(missing.output, /colour role amber-soft/);

  const layout = runOnCopy((copy) =>
    editTheme(copy, (theme) => {
      theme.radius = { card: { $type: "dimension", $value: "20px" } };
    }),
  );
  assert.equal(layout.stage, "build");
  assert.match(layout.output, /carries only color and font/);
});
