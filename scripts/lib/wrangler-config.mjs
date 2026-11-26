/** Shared helpers for reading an app's `wrangler.jsonc` from the deploy scripts. */

/** Parse the JSON-with-comments dialect Wrangler accepts for `wrangler.jsonc`. */
export function parseJsonc(text) {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 1;
      continue;
    }
    out += char;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

/** All-zero UUIDs and bare placeholder tokens are what the generator leaves behind. */
export function isPlaceholder(value) {
  if (typeof value !== "string" || value.trim() === "") return true;
  const token = value.replace(/[-_]/g, "");
  return /^0+$/.test(token) || /^<.*>$/.test(value.trim());
}
