// Vẽ câu trả lời của agent thành nội dung giàu: Markdown (tiêu đề, danh sách, bảng, khối mã, trích dẫn, đường kẻ) và
// tập thẻ HTML kiểu tin nhắn Telegram (<b> <i> <u> <s> <code> <pre> <a> <blockquote> <tg-spoiler>). Chỉ dựng phần tử
// React từ danh sách cho phép, không bao giờ chèn HTML thô, nên chữ agent viết ra không chạy được script.
import { useState, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';
import { cx } from '@shell/components/ui/cx';

export type Block =
  | { kind: 'p'; text: string }
  | { kind: 'h'; level: 1 | 2 | 3; text: string }
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'quote'; text: string }
  | { kind: 'list'; ordered: boolean; start: number; items: string[] }
  | { kind: 'table'; head: string[]; rows: string[][] }
  | { kind: 'hr' };

const FENCE = /^\s*```\s*([\w+-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*+•]\s+(.*)$/;
const ORDERED = /^\s*(\d{1,4})[.)]\s+(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());

/** Tách chữ thành khối. Thuần, test độc lập. */
export function parseBlocks(src: string): Block[] {
  // <pre>/<blockquote> của Telegram đổi về cú pháp Markdown tương đương trước khi tách dòng.
  const text = src
    .replace(/\r\n?/g, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<pre>(?:\s*<code(?:\s+class="language-([\w+-]+)")?>)?([\s\S]*?)(?:<\/code>\s*)?<\/pre>/gi, (_, lang: string | undefined, body: string) => `\n\`\`\`${lang ?? ''}\n${body.replace(/^\n|\n$/g, '')}\n\`\`\`\n`)
    .replace(/<blockquote(?:\s+expandable)?>([\s\S]*?)<\/blockquote>/gi, (_, body: string) => `\n${body.trim().split('\n').map((l) => `> ${l}`).join('\n')}\n`);
  const lines = text.split('\n');
  const out: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push({ kind: 'p', text: para.join('\n') });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      for (i++; i < lines.length && !FENCE.test(lines[i]); i++) body.push(lines[i]);
      out.push({ kind: 'code', lang: fence[1], text: body.join('\n') });
      continue;
    }
    if (line.trim() === '') {
      flush();
      continue;
    }
    if (RULE.test(line)) {
      flush();
      out.push({ kind: 'hr' });
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      flush();
      out.push({ kind: 'h', level: Math.min(h[1].length, 3) as 1 | 2 | 3, text: h[2].replace(/\s+#+\s*$/, '') });
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      flush();
      const head = cells(line);
      const rows: string[][] = [];
      for (i += 2; i < lines.length && lines[i].includes('|') && lines[i].trim() !== ''; i++) rows.push(cells(lines[i]));
      i--;
      out.push({ kind: 'table', head, rows });
      continue;
    }
    if (/^\s*>/.test(line)) {
      flush();
      const body: string[] = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) body.push(lines[i].replace(/^\s*>\s?/, ''));
      i--;
      out.push({ kind: 'quote', text: body.join('\n') });
      continue;
    }
    const b = BULLET.exec(line);
    const o = ORDERED.exec(line);
    if (b || o) {
      flush();
      const ordered = !b;
      const items: string[] = [];
      const re = ordered ? ORDERED : BULLET;
      for (; i < lines.length; i++) {
        const m = re.exec(lines[i]);
        if (m) items.push(ordered ? m[2] : m[1]);
        else if (/^\s{2,}\S/.test(lines[i]) && items.length) items[items.length - 1] += `\n${lines[i].trim()}`;
        else break;
      }
      i--;
      out.push({ kind: 'list', ordered, start: o ? Number(o[1]) : 1, items });
      continue;
    }
    para.push(line);
  }
  flush();
  return out;
}

const safeHref = (h: string) => (/^(https?:|mailto:)/i.test(h.trim()) ? h.trim() : '');

const decode = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

// Thứ tự quan trọng: mã trước (bên trong mã không định dạng), rồi thẻ HTML, liên kết, đậm, nghiêng.
const INLINE =
  /(`[^`\n]+`)|<(b|strong|i|em|u|ins|s|strike|del|code|tg-spoiler)>([\s\S]*?)<\/\2>|<span class="tg-spoiler">([\s\S]*?)<\/span>|<a\s+href="([^"]*)">([\s\S]*?)<\/a>|\[([^\]\n]+)\]\(([^)\s]+)\)|\*\*([^*\n]+)\*\*|__([^_\n]+)__|~~([^~\n]+)~~|\|\|([^|\n]+)\|\||(?<![\w*])\*([^*\n]+)\*(?!\w)|(?<![\w_])_([^_\n]+)_(?!\w)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/;

function Spoiler({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState(false);
  return (
    <span
      role="button"
      tabIndex={0}
      title={shown ? undefined : 'Bấm để xem'}
      onClick={() => setShown(true)}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setShown(true)}
      className={cx('rounded-[3px] px-[2px] transition-colors', shown ? 'bg-muted-box' : 'cursor-pointer select-none bg-text-3 text-transparent')}
      data-testid="spoiler"
    >
      {children}
    </span>
  );
}

const codeCls = 'rounded-[4px] bg-muted-box px-[4px] py-[1px] font-mono text-[12px] text-accent-ink';

/** Định dạng trong dòng; đệ quy cho phần chữ bên trong thẻ đậm/nghiêng. */
export function renderInline(text: string, key = 'i'): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  let n = 0;
  while (rest) {
    const m = INLINE.exec(rest);
    if (!m) {
      out.push(decode(rest));
      break;
    }
    if (m.index > 0) out.push(decode(rest.slice(0, m.index)));
    const k = `${key}.${n++}`;
    const [all, code, tag, tagBody, spoilerSpan, aHref, aText, mdText, mdHref, bold, bold2, strike, spoiler, it, it2, url] = m;
    if (code) out.push(<code key={k} className={codeCls}>{decode(code.slice(1, -1))}</code>);
    else if (tag) {
      const t = tag.toLowerCase();
      const inner = t === 'code' ? decode(tagBody) : renderInline(tagBody, k);
      if (t === 'b' || t === 'strong') out.push(<strong key={k} className="font-semibold">{inner}</strong>);
      else if (t === 'i' || t === 'em') out.push(<em key={k}>{inner}</em>);
      else if (t === 'u' || t === 'ins') out.push(<u key={k}>{inner}</u>);
      else if (t === 'code') out.push(<code key={k} className={codeCls}>{inner}</code>);
      else if (t === 'tg-spoiler') out.push(<Spoiler key={k}>{inner}</Spoiler>);
      else out.push(<s key={k}>{inner}</s>);
    } else if (spoilerSpan !== undefined) out.push(<Spoiler key={k}>{renderInline(spoilerSpan, k)}</Spoiler>);
    else if (aHref !== undefined || mdHref !== undefined) {
      const href = safeHref(decode(aHref ?? mdHref));
      const label = renderInline(aText ?? mdText, k);
      out.push(
        href ? (
          <a key={k} href={href} target="_blank" rel="noreferrer noopener" className="font-medium text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent">
            {label}
          </a>
        ) : (
          <span key={k}>{label}</span>
        ),
      );
    } else if (bold || bold2) out.push(<strong key={k} className="font-semibold">{renderInline(bold ?? bold2, k)}</strong>);
    else if (strike) out.push(<s key={k}>{renderInline(strike, k)}</s>);
    else if (spoiler) out.push(<Spoiler key={k}>{renderInline(spoiler, k)}</Spoiler>);
    else if (it || it2) out.push(<em key={k}>{renderInline(it ?? it2, k)}</em>);
    else if (url)
      out.push(
        <a key={k} href={url} target="_blank" rel="noreferrer noopener" className="break-all text-accent underline decoration-accent/40 underline-offset-2">
          {url}
        </a>,
      );
    else out.push(all);
    rest = rest.slice(m.index + all.length);
  }
  return out;
}

/** Xuống dòng trong một đoạn giữ nguyên như tin nhắn. */
const lines = (text: string, key: string) =>
  text.split('\n').flatMap((l, i) => (i === 0 ? renderInline(l, `${key}.${i}`) : [<br key={`${key}.br${i}`} />, ...renderInline(l, `${key}.${i}`)]));

function CodeBlock({ lang, text }: { lang: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="overflow-hidden rounded-[8px] border border-border bg-[#0f1a2b]" data-testid="code-block">
      <div className="flex items-center justify-between bg-white/5 px-[10px] py-[4px] text-[10.5px]/[14px] text-white/60">
        <span className="font-mono uppercase tracking-[0.5px]">{lang || 'code'}</span>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(text).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            });
          }}
          className="flex items-center gap-[4px] rounded-[4px] px-[4px] py-[1px] hover:bg-white/10 hover:text-white"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? 'Đã chép' : 'Chép'}
        </button>
      </div>
      <pre className="overflow-x-auto px-[12px] py-[10px] font-mono text-[12px]/[18px] text-[#e6edf7]">
        <code>{text}</code>
      </pre>
    </div>
  );
}

/** Nội dung giàu của một tin. */
export function RichText({ text, className }: { text: string; className?: string }) {
  const blocks = parseBlocks(text);
  return (
    <div className={cx('flex min-w-0 flex-col gap-[8px] break-words text-[13.5px]/[20px] text-text', className)} data-testid="rich-text">
      {blocks.map((b, i) => {
        const k = `b${i}`;
        switch (b.kind) {
          case 'p':
            return <p key={k}>{lines(b.text, k)}</p>;
          case 'h':
            return b.level === 1 ? (
              <h3 key={k} className="text-[16px]/[22px] font-bold">{renderInline(b.text, k)}</h3>
            ) : b.level === 2 ? (
              <h4 key={k} className="text-[14.5px]/[20px] font-bold">{renderInline(b.text, k)}</h4>
            ) : (
              <h5 key={k} className="text-[13.5px]/[19px] font-semibold text-text-2">{renderInline(b.text, k)}</h5>
            );
          case 'code':
            return <CodeBlock key={k} lang={b.lang} text={b.text} />;
          case 'quote':
            return (
              <blockquote key={k} className="rounded-r-[6px] border-l-[3px] border-accent bg-accent-soft/60 px-[10px] py-[6px] text-text-2">
                {lines(b.text, k)}
              </blockquote>
            );
          case 'list': {
            const items = b.items.map((it, j) => (
              <li key={j} className="pl-[2px]">
                {lines(it, `${k}.${j}`)}
              </li>
            ));
            return b.ordered ? (
              <ol key={k} start={b.start} className="flex list-decimal flex-col gap-[3px] pl-[22px] marker:font-semibold marker:text-text-3">
                {items}
              </ol>
            ) : (
              <ul key={k} className="flex list-disc flex-col gap-[3px] pl-[20px] marker:text-accent">
                {items}
              </ul>
            );
          }
          case 'table':
            return (
              <div key={k} className="overflow-x-auto rounded-[8px] border border-border" data-testid="rich-table">
                <table className="w-full border-collapse text-[12.5px]/[17px]">
                  <thead className="bg-table-head">
                    <tr>
                      {b.head.map((c, j) => (
                        <th key={j} className="border-b border-border px-[10px] py-[6px] text-left font-semibold text-text-2">
                          {renderInline(c, `${k}.h${j}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, ri) => (
                      <tr key={ri} className="even:bg-muted-box">
                        {b.head.map((_, j) => (
                          <td key={j} className="border-b border-divider px-[10px] py-[5px] align-top">
                            {renderInline(r[j] ?? '', `${k}.${ri}.${j}`)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case 'hr':
            return <hr key={k} className="border-divider" />;
        }
      })}
    </div>
  );
}
