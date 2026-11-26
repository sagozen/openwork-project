import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import {
  contrastRatio as contrast,
  isReadableAccent,
} from "../src/design/contrast.js";
import { parseTokens } from "../scripts/tokens-to-json.mjs";

const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");
const tokens = parseTokens(read("../src/design/tokens.css")) as Record<
  "light" | "dark" | "vi",
  Record<string, string>
>;

const PAIRS: Array<[string, string, number]> = [
  ["text", "bg", 12],
  ["text", "surface", 12],
  ["text-muted", "bg", 5],
  ["text-muted", "surface", 5],
  ["text-muted", "surface-sunken", 4.5],
  ["accent", "bg", 4.5],
  ["accent", "surface", 4.5],
  ["on-accent", "accent", 4.5],
  ["on-accent", "accent-hover", 4.5],
  ["accent", "accent-soft", 4.5],
  ["border-strong", "bg", 3],
  ["border-strong", "surface", 3],
  ["success", "success-soft", 4.5],
  ["warning", "warning-soft", 4.5],
  ["danger", "danger-soft", 4.5],
  ["info", "info-soft", 4.5],
  ["danger", "surface", 4.5],
];

for (const scheme of ["light", "dark"] as const) {
  test(`${scheme} tokens meet their contrast targets`, () => {
    const color = (name: string) =>
      tokens[scheme][`--mt-color-${name}`] ??
      tokens.light[`--mt-color-${name}`];
    for (const [foreground, background, target] of PAIRS) {
      const ratio = contrast(color(foreground), color(background));
      assert.ok(
        ratio >= target,
        `${foreground} on ${background}: ${ratio.toFixed(2)} < ${target}`,
      );
    }
  });
}

test("dark mode overrides every semantic colour that changes", () => {
  for (const name of Object.keys(tokens.dark))
    assert.ok(name in tokens.light, `${name} has no light value`);
  assert.ok(Object.keys(tokens.dark).length >= 18);
  const css = read("../src/design/tokens.css");
  const declarations = (selector: string) =>
    css
      .slice(css.indexOf(selector))
      .split("}")[0]
      .split("\n")
      .filter((line) => line.includes("--mt-"))
      .map((line) => line.trim());
  assert.deepEqual(
    declarations(':root[data-mt-scheme="auto"]'),
    declarations(':root[data-mt-scheme="dark"]'),
    "the auto scheme must repeat the dark values exactly",
  );
});

test("Vietnamese gets more leading than latin at every size", () => {
  for (const [name, value] of Object.entries(tokens.vi))
    assert.ok(Number(value) > Number(tokens.light[name]), name);
});

test("the stylesheets use tokens instead of colour literals", () => {
  for (const path of [
    "../../../themes/mytutor/src/styles/site.css",
    "../src/ui/ui.css",
    "../src/admin/styles.css",
  ]) {
    // The theme stylesheet is absent when the plugin is vendored on its own.
    if (!existsSync(new URL(path, import.meta.url))) continue;
    const css = read(path);
    assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i, `${path} has a hex colour`);
    assert.doesNotMatch(css, /\brgba?\(/, `${path} has an rgb() colour`);
  }
});

test("the accent guardrail rejects colours buttons cannot use", () => {
  assert.ok(isReadableAccent("oklch(0.38 0.07 155)"));
  assert.ok(isReadableAccent("oklch(45% 0.12 260)"));
  assert.equal(isReadableAccent("oklch(0.8 0.15 90)"), false);
  assert.equal(isReadableAccent("not a colour"), false);
});
