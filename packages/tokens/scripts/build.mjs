#!/usr/bin/env node
import { createHash } from "node:crypto";
/**
 * Build the design-token package.
 *
 * Input : tokens/td.tokens.json  (W3C DTCG, three tiers)
 *         themes/registry.json   (restaurant themes: identity, plus a token file when authored)
 * Output: dist/css/tokens.css    (light + dark custom properties, one block per authored theme)
 *         dist/ts/tokens.ts      (resolved values, typed)
 *         dist/typst/tokens.typ  (document style for the Go/Typst renderer)
 *         dist/json/tokens.json  (fully resolved, for tools)
 *
 * The build is deterministic: the same input always produces byte-identical output.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sourcePath = join(root, "tokens", "td.tokens.json");
const dist = join(root, "dist");

const source = JSON.parse(await readFile(sourcePath, "utf8"));
const tree = source.td;

const isToken = (node) =>
  node !== null && typeof node === "object" && !Array.isArray(node) && Object.hasOwn(node, "$value");

/** Resolve `{a.b.c}` aliases against the raw tree. */
function resolveValue(value, seen = []) {
  if (typeof value === "string" && value.startsWith("{") && value.endsWith("}")) {
    const path = value.slice(1, -1).split(".");
    const key = path.join(".");
    if (seen.includes(key)) throw new Error(`Circular token alias: ${[...seen, key].join(" -> ")}`);
    const target = path.reduce((node, part) => node?.[part], source);
    if (!target || !isToken(target)) throw new Error(`Unresolved token alias: {${key}}`);
    return resolveValue(target.$value, [...seen, key]);
  }
  if (Array.isArray(value)) return value.map((item) => resolveValue(item, seen));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveValue(v, seen)]));
  }
  return value;
}

/** Walk the token tree, yielding { path, type, value }. */
function* walk(node, path = []) {
  if (isToken(node)) {
    yield { path, type: node.$type ?? "unknown", value: resolveValue(node.$value) };
    return;
  }
  if (node !== null && typeof node === "object" && !Array.isArray(node)) {
    for (const [key, child] of Object.entries(node)) {
      if (key.startsWith("$")) continue;
      yield* walk(child, [...path, key]);
    }
  }
}

const tokens = [...walk(tree)];

/* --------------------------------------------------------------- themes */

const themesDir = join(root, "themes");
const registry = JSON.parse(await readFile(join(themesDir, "registry.json"), "utf8"));
const HEX = /^#[0-9a-fA-F]{6}$/;
const THEME_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Validates the registry and loads every authored theme. A theme carries the declared colour roles
 * and font pair and nothing else, so an extra, missing or malformed entry fails the build rather
 * than shipping a half-themed screen.
 */
async function loadThemes() {
  const roles = registry.roles;
  const fontRoles = registry.fonts;
  const seen = new Set();
  const themes = [];
  for (const record of registry.themes) {
    const where = `themes/registry.json (${record.id})`;
    if (!THEME_ID.test(record.id ?? "")) throw new Error(`${where}: id must be kebab-case`);
    if (record.id === "light" || record.id === "dark") throw new Error(`${where}: id clashes with the platform theme`);
    if (seen.has(record.id)) throw new Error(`${where}: duplicate theme id`);
    seen.add(record.id);
    if (record.scheme !== "light" && record.scheme !== "dark")
      throw new Error(`${where}: scheme must be light or dark`);
    for (const key of ["name", "description"]) {
      if (typeof record[key] !== "string" || !record[key].trim()) throw new Error(`${where}: missing ${key}`);
    }
    for (const tag of record.tags ?? []) {
      if (!Object.hasOwn(registry.tags, tag)) throw new Error(`${where}: unknown tag ${tag}`);
    }
    for (const role of fontRoles) {
      if (typeof record.fonts?.[role] !== "string") throw new Error(`${where}: missing font name ${role}`);
    }
    for (const key of ["bg", "primary"]) {
      if (!HEX.test(record.swatch?.[key] ?? "")) throw new Error(`${where}: swatch.${key} must be #rrggbb`);
    }
    for (const key of ["bg", "line", "bar"]) {
      if (!HEX.test(record.thumb?.[key] ?? "")) throw new Error(`${where}: thumb.${key} must be #rrggbb`);
    }
    if (!HEX.test(record.ink ?? "")) throw new Error(`${where}: ink must be #rrggbb`);

    let palette = null;
    let fontStacks = null;
    if (record.tokens) {
      const file = JSON.parse(await readFile(join(themesDir, record.tokens), "utf8"));
      const theme = file.theme ?? {};
      const fileWhere = `themes/${record.tokens}`;
      for (const key of Object.keys(theme)) {
        if (key !== "color" && key !== "font")
          throw new Error(`${fileWhere}: a theme carries only color and font (${key})`);
      }
      palette = {};
      for (const key of Object.keys(theme.color ?? {})) {
        if (!roles.includes(key)) throw new Error(`${fileWhere}: unknown colour role ${key}`);
      }
      for (const role of roles) {
        const token = theme.color?.[role];
        if (!isToken(token) || token.$type !== "color" || !HEX.test(token.$value)) {
          throw new Error(`${fileWhere}: colour role ${role} must be a #rrggbb color token`);
        }
        palette[role] = token.$value;
      }
      fontStacks = {};
      for (const key of Object.keys(theme.font ?? {})) {
        if (!fontRoles.includes(key)) throw new Error(`${fileWhere}: unknown font role ${key}`);
      }
      for (const role of fontRoles) {
        const token = theme.font?.[role];
        if (!isToken(token) || token.$type !== "fontFamily" || !Array.isArray(token.$value) || !token.$value.length) {
          throw new Error(`${fileWhere}: font role ${role} must be a non-empty fontFamily token`);
        }
        fontStacks[role] = token.$value;
      }
    }
    themes.push({
      id: record.id,
      name: record.name,
      description: record.description,
      tags: record.tags ?? [],
      scheme: record.scheme,
      fonts: record.fonts,
      swatch: record.swatch,
      thumb: record.thumb,
      ink: record.ink,
      available: palette !== null,
      palette,
      fontStacks,
    });
  }
  const fallback = themes.find((theme) => theme.id === registry.default);
  if (!fallback?.available) throw new Error(`themes/registry.json: default theme ${registry.default} is not authored`);
  return themes;
}

const themes = await loadThemes();
const authoredThemes = themes.filter((theme) => theme.available);
const themeSelector = (theme) => `[data-theme="${theme.id}"]`;
const lightSelectors = [
  '[data-theme="light"]',
  ...authoredThemes.filter((t) => t.scheme === "light").map(themeSelector),
];
const darkSelectors = ['[data-theme="dark"]', ...authoredThemes.filter((t) => t.scheme === "dark").map(themeSelector)];

/* ------------------------------------------------------------------ CSS */

function cssName(path) {
  const parts = path.filter((part) => part !== "light" && part !== "dark");
  return `--td-${parts.join("-").replaceAll("_", "-")}`;
}

function cssValue(token) {
  const { value, type } = token;
  if (type === "fontFamily") return fontStack(value);
  if (type === "cubicBezier") return `cubic-bezier(${value.join(", ")})`;
  if (type === "dimension") return String(value);
  if (type === "duration") return String(value);
  if (type === "shadow") return String(value);
  if (type === "color") return String(value);
  if (type === "number" || type === "fontWeight") return String(value);
  return String(value);
}

function blockFor(theme) {
  const lines = [];
  const seen = new Set();
  for (const token of tokens) {
    const [color, maybeTheme] = token.path;
    const themed = color === "color" && (maybeTheme === "light" || maybeTheme === "dark");
    const elevationThemed = token.path[0] === "elevation" && (token.path[1] === "light" || token.path[1] === "dark");
    if (themed && maybeTheme !== theme) continue;
    if (elevationThemed && token.path[1] !== theme) continue;
    if (color === "color" && maybeTheme === "primitive") continue;
    if (token.type === "strokeStyle") continue;
    const name = cssName(token.path);
    if (seen.has(name)) continue;
    seen.add(name);
    lines.push(`  ${name}: ${cssValue(token)};`);
  }
  return lines.join("\n");
}

const fontStack = (families) => families.map((family) => (family.includes(" ") ? `"${family}"` : family)).join(", ");

/** One block per authored theme: the colour roles and font pair as --td-theme-* properties. */
function themeBlock(theme) {
  const lines = [`  color-scheme: ${theme.scheme};`];
  for (const role of registry.roles) lines.push(`  --td-theme-${role}: ${theme.palette[role]};`);
  for (const role of registry.fonts) lines.push(`  --td-theme-font-${role}: ${fontStack(theme.fontStacks[role])};`);
  return `${themeSelector(theme)} {\n${lines.join("\n")}\n}`;
}

const css = `/* Generated by @templatedesign/tokens. Do not edit by hand. */
/* Source: packages/tokens/tokens/td.tokens.json, packages/tokens/themes/ */

:root,
${lightSelectors.join(",\n")} {
  color-scheme: light;
${blockFor("light")}
}

@media (prefers-color-scheme: dark) {
  :root${lightSelectors.map((selector) => `:not(${selector})`).join("")} {
    color-scheme: dark;
${blockFor("dark")
  .split("\n")
  .map((line) => `  ${line}`)
  .join("\n")}
  }
}

${darkSelectors.join(",\n")} {
  color-scheme: dark;
${blockFor("dark")}
}

/* Restaurant themes. Switching theme is one attribute on the document element. */
${authoredThemes.map(themeBlock).join("\n\n")}

@media (prefers-reduced-motion: reduce) {
  :root {
    --td-motion-duration-instant: 0ms;
    --td-motion-duration-fast: 0ms;
    --td-motion-duration-base: 0ms;
    --td-motion-duration-slow: 0ms;
    --td-motion-duration-deliberate: 0ms;
  }
}
`;

/* ------------------------------------------------------------------- TS */

function toJs(value) {
  return JSON.stringify(value, null, 2)
    .replace(/"([A-Za-z_$][\w$]*)":/g, "$1:")
    .replaceAll('"', '"');
}

function nested(paths) {
  const out = {};
  for (const token of tokens) {
    if (paths && !paths(token)) continue;
    let node = out;
    for (const part of token.path.slice(0, -1)) node = node[part] ??= {};
    node[token.path.at(-1)] = token.value;
  }
  return out;
}

const ts = `/* Generated by @templatedesign/tokens. Do not edit by hand. */

export const tokens = ${toJs(nested())} as const;

export const lightColors = ${toJs(nested((t) => t.path[0] === "color" && t.path[1] === "light"))}.light as const;
export const darkColors = ${toJs(nested((t) => t.path[0] === "color" && t.path[1] === "dark"))}.dark as const;

export const cssVariables = {
${tokens
  .filter((t) => !(t.path[0] === "color" && t.path[1] === "primitive") && t.type !== "strokeStyle")
  .map((t) => `  ${JSON.stringify(t.path.join("."))}: ${JSON.stringify(cssName(t.path))},`)
  .join("\n")}
} as const;

export type TokenPath = keyof typeof cssVariables;
export type ThemeName = "light" | "dark";

/** Returns a CSS custom-property name for a token path, e.g. cssVar("color.bg"). */
export function cssVar(path: TokenPath): string {
  return \`var(\${cssVariables[path]})\`;
}

/**
 * Restaurant themes. \`available\` is false for identity-only records: they are shown in the picker
 * as coming soon and carry no palette.
 */
export const themeRegistry = ${toJs({ default: registry.default, roles: registry.roles, tags: registry.tags, themes })} as const;

export type ThemeId = ${themes.map((theme) => JSON.stringify(theme.id)).join(" | ")};
export type AvailableThemeId = ${authoredThemes.map((theme) => JSON.stringify(theme.id)).join(" | ")};
export type ThemeRole = (typeof themeRegistry.roles)[number];
`;

/* --------------------------------------------------------------- Typst */

const typstKey = (path) => path.join("-");

function typstValue(token) {
  if (token.type === "color") return `rgb("${token.value}")`;
  if (token.type === "dimension" || token.type === "duration") return `"${token.value}"`;
  if (token.type === "fontFamily") return `(${token.value.map((f) => `"${f}"`).join(", ")},)`;
  if (token.type === "number" || token.type === "fontWeight") return String(token.value);
  if (token.type === "cubicBezier") return `(${token.value.join(", ")},)`;
  return `"${String(token.value).replaceAll('"', '\\"')}"`;
}

function typstDict(theme) {
  const lines = [];
  for (const token of tokens) {
    if (token.path[0] === "color" && token.path[1] === "primitive") continue;
    if (token.path[0] === "color" && token.path[1] !== theme) continue;
    if (token.path[0] === "elevation" && token.path[1] !== theme) continue;
    if (token.path[0] === "color") {
      lines.push(`  "${typstKey(token.path.slice(2))}": ${typstValue(token)},`);
    }
  }
  return lines.join("\n");
}

function typstChart() {
  const lines = [];
  for (const token of tokens) {
    if (token.path[0] !== "chart") continue;
    if (token.type === "color") lines.push(`  "${typstKey(token.path.slice(1))}": ${typstValue(token)},`);
  }
  return lines.join("\n");
}

const typst = `// Generated by @templatedesign/tokens. Do not edit by hand.
// Pinned into the render core. Changing a value changes published output only
// after a deliberate render-core release.

#let td-color-light = (
${typstDict("light")}
)

#let td-color-dark = (
${typstDict("dark")}
)

#let td-chart = (
${typstChart()}
)

#let td-font = (
  sans: ("Be Vietnam Pro",),
  serif: ("Source Serif 4",),
  mono: ("JetBrains Mono",),
  body: 10pt,
  caption: 7pt,
  title: 11pt,
)

#let td-space = (
  "1": 4pt, "2": 8pt, "3": 12pt, "4": 16pt, "6": 24pt, "8": 32pt,
)
`;

/* ---------------------------------------------------------------- write */

await mkdir(join(dist, "css"), { recursive: true });
await mkdir(join(dist, "ts"), { recursive: true });
await mkdir(join(dist, "typst"), { recursive: true });
await mkdir(join(dist, "json"), { recursive: true });

await writeFile(join(dist, "css", "tokens.css"), css);
await writeFile(join(dist, "ts", "tokens.ts"), ts);
await writeFile(join(dist, "typst", "tokens.typ"), typst);

const resolved = Object.fromEntries(tokens.map((token) => [token.path.join("."), token.value]));
const resolvedThemes = Object.fromEntries(
  authoredThemes.map((theme) => [theme.id, { color: theme.palette, font: theme.fontStacks }]),
);
const hash = createHash("sha256").update(JSON.stringify({ resolved, resolvedThemes })).digest("hex");
await writeFile(
  join(dist, "json", "tokens.json"),
  `${JSON.stringify({ $hash: hash, tokens: resolved, themes: resolvedThemes }, null, 2)}\n`,
);

const counts = {
  total: tokens.length,
  css: tokens.filter((t) => !(t.path[0] === "color" && t.path[1] === "primitive") && t.type !== "strokeStyle").length,
  typst: tokens.filter((t) => t.path[0] === "chart" || t.path[0] === "color").length,
};
console.log(
  `tokens: ${counts.total} total, ${counts.css} CSS declarations, ${authoredThemes.length} of ${themes.length} themes authored, hash ${hash.slice(0, 12)}`,
);
