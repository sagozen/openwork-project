/**
 * The public docs are one Markdown file per app, rendered as HTML at `/docs` and served as text at
 * `/llms-full.txt`. The file uses a small, predictable subset of Markdown, so this renderer stays
 * dependency free and runs the same in the Worker and in tests:
 *
 * - `#`..`####` headings, with an optional explicit id: `## Limits and pricing {#limits}`
 * - paragraphs, `-` and `1.` lists, `>` notes, pipe tables, fenced code blocks
 * - inline `code`, **bold**, and `[links](/path)`
 * - `{{name}}` placeholders, filled from app data before anything else happens
 *
 * Every piece of text is HTML-escaped; link targets are limited to same-site paths, anchors,
 * https and mailto.
 */

export interface DocsHeading {
  depth: number;
  text: string;
  id: string;
}

export interface RenderedDocs {
  html: string;
  headings: DocsHeading[];
}

const PLACEHOLDER = /\{\{\s*([A-Za-z][\w.]*)\s*\}\}/g;
const HEADING = /^(#{1,4})\s+(.+?)\s*$/;
const EXPLICIT_ID = /\s*\{#([a-z0-9][a-z0-9-]*)\}$/;
const FENCE = /^```\s*([\w-]*)\s*$/;
const LIST_ITEM = /^(\s*)([-*]|\d+\.)\s+(.*)$/;
const TABLE_DIVIDER = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?$/;

/** Replaces every `{{name}}`. An unknown name throws, so a typo fails the build instead of shipping. */
export function fillPlaceholders(markdown: string, values: Record<string, string | number>): string {
  return markdown.replace(PLACEHOLDER, (_match, name: string) => {
    if (!Object.hasOwn(values, name)) throw new Error(`Unknown docs placeholder {{${name}}}`);
    return String(values[name]);
  });
}

/** The Markdown as people and LLMs should read it: explicit heading ids are render hints only. */
export function docsPlainText(markdown: string): string {
  return markdown
    .split("\n")
    .map((line) => (HEADING.test(line) ? line.replace(EXPLICIT_ID, "") : line))
    .join("\n");
}

export function slugify(text: string): string {
  return stripInline(text)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/[\s-]+/g, "-");
}

/** Headings outside code fences, with the same ids the HTML renderer assigns. */
export function docsHeadings(markdown: string): DocsHeading[] {
  const headings: DocsHeading[] = [];
  const used = new Map<string, number>();
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (FENCE.test(line)) fenced = !fenced;
    if (fenced) continue;
    const match = HEADING.exec(line);
    if (match) headings.push(heading(match[1].length, match[2], used));
  }
  return headings;
}

export function renderDocs(markdown: string): RenderedDocs {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const headings: DocsHeading[] = [];
  const used = new Map<string, number>();
  const out: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !FENCE.test(lines[index])) body.push(lines[index++]);
      index += 1;
      out.push(codeBlock(body.join("\n"), fence[1]));
      continue;
    }

    const title = HEADING.exec(line);
    if (title) {
      const entry = heading(title[1].length, title[2], used);
      headings.push(entry);
      const tag = `h${entry.depth}`;
      out.push(
        `<${tag} id="${entry.id}">${inline(entry.text)} <a class="docs-anchor" href="#${entry.id}" aria-label="Link to this section">#</a></${tag}>`,
      );
      index += 1;
      continue;
    }

    if (line.startsWith("|") && TABLE_DIVIDER.test(lines[index + 1] ?? "")) {
      const rows: string[] = [line];
      index += 2;
      while (index < lines.length && lines[index].startsWith("|")) rows.push(lines[index++]);
      out.push(table(rows));
      continue;
    }

    if (LIST_ITEM.test(line)) {
      const items: string[] = [];
      const ordered = /^\s*\d+\./.test(line);
      while (index < lines.length) {
        const item = LIST_ITEM.exec(lines[index]);
        if (item) {
          items.push(item[3]);
        } else if (/^\s{2,}\S/.test(lines[index]) && items.length) {
          items[items.length - 1] += ` ${lines[index].trim()}`;
        } else {
          break;
        }
        index += 1;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${items.map((item) => `<li>${inline(item)}</li>`).join("")}</${tag}>`);
      continue;
    }

    if (line.startsWith(">")) {
      const quote: string[] = [];
      while (index < lines.length && lines[index].startsWith(">")) quote.push(lines[index++].replace(/^>\s?/, ""));
      out.push(`<blockquote><p>${inline(quote.join(" "))}</p></blockquote>`);
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length && lines[index].trim() && !startsBlock(lines, index)) {
      paragraph.push(lines[index++].trim());
    }
    out.push(`<p>${inline(paragraph.join(" "))}</p>`);
  }

  return { html: out.join("\n"), headings };
}

function startsBlock(lines: string[], index: number): boolean {
  const line = lines[index];
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    LIST_ITEM.test(line) ||
    line.startsWith(">") ||
    (line.startsWith("|") && TABLE_DIVIDER.test(lines[index + 1] ?? ""))
  );
}

function heading(depth: number, raw: string, used: Map<string, number>): DocsHeading {
  const explicit = EXPLICIT_ID.exec(raw);
  const text = explicit ? raw.slice(0, explicit.index) : raw;
  const base = explicit ? explicit[1] : slugify(text) || "section";
  const seen = used.get(base) ?? 0;
  used.set(base, seen + 1);
  return { depth, text, id: seen ? `${base}-${seen}` : base };
}

function codeBlock(code: string, language: string): string {
  const label = language ? ` data-language="${escapeHtml(language)}"` : "";
  return `<div class="docs-code"${label}><button type="button" class="docs-copy" data-copy-code>Copy</button><pre><code>${escapeHtml(code)}</code></pre></div>`;
}

function table(rows: string[]): string {
  const cells = (row: string) =>
    row
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split(/(?<!\\)\|/)
      .map((cell) => cell.trim().replace(/\\\|/g, "|"));
  const [head, ...body] = rows.map(cells);
  const thead = `<thead><tr>${head.map((cell) => `<th scope="col">${inline(cell)}</th>`).join("")}</tr></thead>`;
  const tbody = `<tbody>${body
    .map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join("")}</tr>`)
    .join("")}</tbody>`;
  return `<div class="td-table-wrap"><table class="td-table td-table--dense">${thead}${tbody}</table></div>`;
}

/** Code spans first (their content is literal), then links and bold on the escaped remainder. */
function inline(text: string): string {
  return text
    .split(/(`[^`]+`)/)
    .map((part) => {
      if (part.length > 1 && part.startsWith("`") && part.endsWith("`")) {
        return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
      }
      return escapeHtml(part)
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_match, label: string, href: string) => link(label, href))
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    })
    .join("");
}

function link(label: string, href: string): string {
  const target = href.replace(/&amp;/g, "&");
  const safe = /^(\/(?!\/)|#|https:\/\/|mailto:)/.test(target);
  return safe ? `<a href="${escapeHtml(target)}">${label}</a>` : label;
}

function stripInline(text: string): string {
  return text
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
