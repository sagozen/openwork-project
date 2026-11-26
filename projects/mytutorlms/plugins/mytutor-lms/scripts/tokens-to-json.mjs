#!/usr/bin/env node
// Mirrors src/design/tokens.css to tokens.json (the hand-off file for design
// tools). The CSS stays the single source; never edit the JSON by hand.
//
//   node scripts/tokens-to-json.mjs [out-file]
import { readFileSync, writeFileSync } from "node:fs";

export function parseTokens(css) {
  const blocks = { light: {}, dark: {}, vi: {} };
  const rule = /([^{}]+)\{([^{}]*)\}/g;
  for (const [, selector, body] of css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .matchAll(rule)) {
    const scheme = selector.includes('data-mt-scheme="dark"')
      ? "dark"
      : selector.includes(":lang(vi)")
        ? "vi"
        : selector.includes('data-mt-scheme="auto"') ||
            selector.includes("prefers-reduced")
          ? null
          : "light";
    if (!scheme) continue;
    for (const [, name, value] of body.matchAll(
      /(--mt-[\w-]+)\s*:\s*([^;]+);/g,
    ))
      blocks[scheme][name] = value.replace(/\s+/g, " ").trim();
  }
  return blocks;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const css = readFileSync(
    new URL("../src/design/tokens.css", import.meta.url),
    "utf8",
  );
  const out = process.argv[2] ?? "tokens.json";
  writeFileSync(out, `${JSON.stringify(parseTokens(css), null, 2)}\n`);
  console.log(`Wrote ${out}.`);
}
