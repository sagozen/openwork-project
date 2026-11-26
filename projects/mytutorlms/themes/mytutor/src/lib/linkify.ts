// Lesson notes are plain text. This finds bare https:// addresses so the
// classroom can render them as links through React (never as HTML), and
// splits the notes into paragraphs at blank lines.

export type TextSegment =
  { kind: "text"; text: string } | { kind: "link"; text: string; href: string };

const URL_PATTERN = /https:\/\/[^\s<>"'`]+/gi;
const TRAILING = /[.,;:!?'"]$/;

/** Drops sentence punctuation and unbalanced closing brackets from the end of a match. */
function trimMatch(match: string): string {
  let value = match;
  for (;;) {
    const last = value.at(-1);
    if (!last) return value;
    if (TRAILING.test(last)) {
      value = value.slice(0, -1);
      continue;
    }
    const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
    const open = pairs[last];
    if (open && value.split(last).length - 1 > value.split(open).length - 1) {
      value = value.slice(0, -1);
      continue;
    }
    return value;
  }
}

/** An HTTPS URL with a host and no credentials, or null. */
export function safeHttpsUrl(value: string): string | null {
  if (value.length > 2048 || /[\u0000-\u001f\u007f\s\\]/.test(value))
    return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.hostname &&
      !url.username &&
      !url.password
      ? value
      : null;
  } catch {
    return null;
  }
}

export function linkify(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let cursor = 0;
  const push = (value: string) => {
    if (!value) return;
    const last = segments.at(-1);
    if (last?.kind === "text") last.text += value;
    else segments.push({ kind: "text", text: value });
  };
  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index;
    const candidate = trimMatch(match[0]);
    const href = safeHttpsUrl(candidate);
    push(text.slice(cursor, start));
    if (href) segments.push({ kind: "link", text: candidate, href });
    else push(candidate);
    cursor = start + candidate.length;
  }
  push(text.slice(cursor));
  return segments;
}

/** Paragraphs separated by blank lines; single line breaks stay inside a paragraph. */
export function paragraphs(text: string): string[] {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n(?:[ \t]*\n)+/)
    .map((paragraph) => paragraph.replace(/^\n+|\n+$/g, ""))
    .filter((paragraph) => paragraph.trim().length > 0);
}
