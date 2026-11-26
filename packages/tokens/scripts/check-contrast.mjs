#!/usr/bin/env node
/**
 * Enforce the contrast contract declared in tokens/td.tokens.json for the platform light and dark
 * sets, and the pairs declared in themes/registry.json for every authored restaurant theme.
 * Fails if a declared pair is below its target. Run after `npm run build`.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = JSON.parse(await readFile(join(root, "tokens", "td.tokens.json"), "utf8"));
const registry = JSON.parse(await readFile(join(root, "themes", "registry.json"), "utf8"));
const built = JSON.parse(await readFile(join(root, "dist", "json", "tokens.json"), "utf8"));
const resolved = built.tokens;

const BASE = { light: "color.light.surface", dark: "color.dark.surface" };

function parseColor(input) {
  const value = input.trim();
  const hex = value.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = Number.parseInt(hex[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  const rgba = value.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i);
  if (rgba) {
    return {
      r: Number(rgba[1]),
      g: Number(rgba[2]),
      b: Number(rgba[3]),
      a: rgba[4] === undefined ? 1 : Number(rgba[4]),
    };
  }
  throw new Error(`Unsupported colour value: ${value}`);
}

function composite(fg, bg) {
  if (fg.a >= 1) return fg;
  return {
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  };
}

function channel(value) {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance({ r, g, b }) {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function ratio(fg, bg) {
  const l1 = luminance(fg);
  const l2 = luminance(bg);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

let failures = 0;
let checked = 0;
const rows = [];

for (const theme of ["light", "dark"]) {
  const base = parseColor(resolved[BASE[theme]]);
  for (const pair of source.contrast[theme]) {
    const fgRaw = resolved[`color.${theme}.${pair.fg}`];
    const bgRaw = resolved[`color.${theme}.${pair.bg}`];
    if (!fgRaw || !bgRaw) throw new Error(`Contrast pair references an unknown colour: ${theme}/${pair.fg}/${pair.bg}`);
    const bg = composite(parseColor(bgRaw), base);
    const fg = composite(parseColor(fgRaw), bg);
    const value = ratio(fg, bg);
    checked += 1;
    const pass = value >= pair.min;
    if (!pass) failures += 1;
    rows.push({
      theme,
      pair: `${pair.fg} on ${pair.bg}`,
      ratio: value.toFixed(2),
      min: pair.min.toFixed(1),
      result: pass ? "PASS" : "FAIL",
    });
  }
}

// Every authored theme is held to the same pairs: the ones the component kit renders. A theme
// cannot opt out, and an empty contract would make the gate pass vacuously.
const authored = registry.themes.filter((theme) => theme.tokens).map((theme) => theme.id);
if (!registry.contrast?.length) throw new Error("themes/registry.json declares no contrast pairs");
for (const id of authored) {
  const palette = built.themes?.[id]?.color;
  if (!palette) throw new Error(`Theme ${id} is authored but missing from the build; run the build first`);
  const base = parseColor(palette.surface);
  for (const pair of registry.contrast) {
    if (!palette[pair.fg] || !palette[pair.bg]) {
      throw new Error(`Contrast pair references an unknown theme colour: ${id}/${pair.fg}/${pair.bg}`);
    }
    const bg = composite(parseColor(palette[pair.bg]), base);
    const fg = composite(parseColor(palette[pair.fg]), bg);
    const value = ratio(fg, bg);
    checked += 1;
    const pass = value >= pair.min;
    if (!pass) failures += 1;
    rows.push({
      theme: id,
      pair: `${pair.fg} on ${pair.bg}`,
      ratio: value.toFixed(2),
      min: pair.min.toFixed(1),
      result: pass ? "PASS" : "FAIL",
    });
  }
}

const width = Math.max(...rows.map((row) => row.pair.length));
const themeWidth = Math.max(...rows.map((row) => row.theme.length));
for (const row of rows) {
  const line = `${row.theme.padEnd(themeWidth)} ${row.pair.padEnd(width)}  ${row.ratio.padStart(6)} : ${row.min}  ${row.result}`;
  if (row.result === "FAIL") console.error(line);
  else console.log(line);
}

if (failures > 0) {
  console.error(`\ncontrast: ${failures} of ${checked} pairs failed`);
  process.exit(1);
}
console.log(`\ncontrast: ${checked} pairs pass`);
