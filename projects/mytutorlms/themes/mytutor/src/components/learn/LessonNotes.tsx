import { linkify, paragraphs } from "../../lib/linkify";

const BULLET = /^\s*[-*•]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;

type Block =
  | { kind: "p"; lines: string[] }
  | { kind: "ul" | "ol"; items: string[] };

// Lines starting with "- " or "1." become real lists; other lines stay a
// paragraph with its line breaks kept.
function blocks(paragraph: string): Block[] {
  const result: Block[] = [];
  for (const line of paragraph.split("\n")) {
    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    const kind = bullet ? "ul" : numbered ? "ol" : "p";
    const text = (bullet ?? numbered)?.[1] ?? line;
    const last = result[result.length - 1];
    if (last && last.kind === kind) {
      if (last.kind === "p") last.lines.push(text);
      else last.items.push(text);
    } else if (kind === "p") result.push({ kind, lines: [text] });
    else result.push({ kind, items: [text] });
  }
  return result;
}

function Text({ text }: { text: string }) {
  return (
    <>
      {linkify(text).map((segment, position) =>
        segment.kind === "link" ? (
          <a
            key={position}
            href={segment.href}
            target="_blank"
            rel="noopener noreferrer"
          >
            {segment.text}
          </a>
        ) : (
          segment.text
        ),
      )}
    </>
  );
}

// A section wrapped in "+++ Title" ... "+++" lines is optional material (for
// example an exercise) and is shown collapsed.
const FENCE = /^\+\+\+(?:[ \t]+(.*))?$/;

type Part = { title: string | null; text: string };

function parts(text: string): Part[] {
  const result: Part[] = [];
  let current: Part = { title: null, text: "" };
  for (const line of text.split("\n")) {
    const fence = FENCE.exec(line.trim());
    if (!fence) {
      current.text += `${line}\n`;
      continue;
    }
    if (current.text.trim()) result.push(current);
    current = current.title === null ? { title: fence[1]?.trim() || "Tuỳ chọn", text: "" } : { title: null, text: "" };
  }
  if (current.text.trim()) result.push(current);
  return result;
}

function Body({ text }: { text: string }) {
  return (
    <>
      {paragraphs(text).flatMap((paragraph, index) =>
        blocks(paragraph).map((block, position) => {
          const key = `${index}-${position}`;
          if (block.kind === "p")
            return (
              <p key={key}>
                <Text text={block.lines.join("\n")} />
              </p>
            );
          const Tag = block.kind;
          return (
            <Tag key={key}>
              {block.items.map((item, i) => (
                <li key={i}>
                  <Text text={item} />
                </li>
              ))}
            </Tag>
          );
        }),
      )}
    </>
  );
}

/**
 * Plain-text lesson notes: paragraphs at blank lines, "- " and "1." runs as
 * lists, line breaks kept, and bare https:// addresses as links. "+++ Title"
 * fences wrap optional material shown collapsed. Everything is rendered as
 * text by React, so notes can never inject HTML.
 */
export default function LessonNotes({ text }: { text: string }) {
  return (
    <div className="prose lesson-notes">
      {parts(text).map((part, index) =>
        part.title === null ? (
          <Body key={index} text={part.text} />
        ) : (
          <details key={index} className="lesson-optional">
            <summary>{part.title}</summary>
            <Body text={part.text} />
          </details>
        ),
      )}
    </div>
  );
}
