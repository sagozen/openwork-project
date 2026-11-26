import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentTranscriptView, PinnedBar, SuggestionChips } from './AgentChatPane';
import { parseBlocks, RichText } from './RichText';
import { pinKey, pinPreview, togglePin } from './pins';
import { followUps } from './suggestions';
import { emptyState, reduce, sendUser, type Msg } from './state';

const load = () => Promise.resolve('');
const html = (text: string) => renderToStaticMarkup(<RichText text={text} />);

describe('nội dung giàu của câu trả lời agent', () => {
  it('tách khối: tiêu đề, danh sách, bảng, khối mã, trích dẫn, đường kẻ', () => {
    const src = '# Kết quả\n- a\n- b\n\n1. một\n2. hai\n\n| Flow | KQ |\n|---|---|\n| login | đạt |\n\n```yaml\nappId: x\n```\n> ghi chú\n\n---\nhết';
    expect(parseBlocks(src).map((b) => b.kind)).toEqual(['h', 'list', 'list', 'table', 'code', 'quote', 'hr', 'p']);
  });

  it('định dạng trong dòng kiểu Markdown và thẻ HTML Telegram', () => {
    const out = html('**đậm** <i>nghiêng</i> `mã` ~~gạch~~ <tg-spoiler>bí</tg-spoiler> [tài liệu](https://example.com)');
    expect(out).toContain('<strong class="font-semibold">đậm</strong>');
    expect(out).toContain('<em>nghiêng</em>');
    expect(out).toMatch(/<code[^>]*>mã<\/code>/);
    expect(out).toContain('<s>gạch</s>');
    expect(out).toContain('data-testid="spoiler"');
    expect(out).toContain('href="https://example.com"');
  });

  it('không chèn HTML thô: thẻ lạ hiện thành chữ, liên kết javascript bị bỏ', () => {
    const out = html('<script>alert(1)</script> <a href="javascript:alert(1)">bấm</a> <img src=x onerror=alert(1)>');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('<img');
    expect(out).not.toContain('javascript:');
    expect(out).toContain('&lt;script&gt;');
  });

  it('<pre> và <blockquote> của Telegram thành khối mã và trích dẫn', () => {
    expect(parseBlocks('<pre><code class="language-json">{"a":1}</code></pre>')).toEqual([{ kind: 'code', lang: 'json', text: '{"a":1}' }]);
    expect(parseBlocks('<blockquote>trích</blockquote>')).toEqual([{ kind: 'quote', text: 'trích' }]);
  });
});

describe('tin ghim', () => {
  const reply: Msg = { type: 'text', author: 'reporter', text: '**Báo cáo**: 3 đạt', streaming: false };

  it('ghim theo nội dung, bấm lần nữa bỏ ghim; tin đang hiện dần không ghim được', () => {
    const one = togglePin([], reply);
    expect(one).toEqual([{ key: pinKey(reply), author: 'reporter', preview: 'Báo cáo: 3 đạt' }]);
    expect(togglePin(one, reply)).toEqual([]);
    expect(pinKey({ ...reply, streaming: true })).toBeNull();
    expect(pinKey({ type: 'error', text: 'x' })).toBeNull();
  });

  it('xem trước bỏ định dạng và cắt ngắn', () => {
    expect(pinPreview('```\ncode\n``` <b>xin</b> chào')).toBe('[mã] xin chào');
    expect(pinPreview('a'.repeat(200))).toHaveLength(140);
  });

  it('thanh ghim hiện tin mới nhất và số thứ tự; tin ghim được đánh dấu trong lịch sử', () => {
    const pins = togglePin(togglePin([], { type: 'user', text: 'chạy login' }), reply);
    const bar = renderToStaticMarkup(<PinnedBar pins={pins} onJump={() => undefined} onUnpin={() => undefined} />);
    expect(bar).toContain('Tin đã ghim #2/2');
    expect(bar).toContain('Báo cáo: 3 đạt');
    expect(renderToStaticMarkup(<PinnedBar pins={[]} onJump={() => undefined} onUnpin={() => undefined} />)).toBe('');
    const view = renderToStaticMarkup(<AgentTranscriptView msgs={[reply]} busy={false} load={load} pinned={new Set(pins.map((p) => p.key))} onPin={() => undefined} />);
    expect(view).toContain('aria-label="Bỏ ghim"');
    expect(view).toContain(`data-pin="${pinKey(reply)}"`);
  });
});

describe('gợi ý', () => {
  it('phiên trống hiện thẻ khởi đầu', () => {
    const out = renderToStaticMarkup(<AgentTranscriptView msgs={[]} busy={false} load={load} onSuggest={() => undefined} />);
    expect(out).toContain('data-testid="agent-starters"');
    expect(out).toContain('Chạy flow đăng nhập trên Android');
  });

  it('trả lời nhanh theo kết quả: có lỗi, tất cả đạt, lỗi máy chủ; không hiện khi đang chạy', () => {
    const base = sendUser(emptyState, 'chạy');
    const failed = reduce(base, { sessionId: 's', kind: 'text', author: 'runner', text: '✗ a lỗi\n✓ b đạt' });
    expect(followUps(failed.msgs, false)).toContain('Phân loại các lỗi vừa gặp');
    const passed = reduce(base, { sessionId: 's', kind: 'text', author: 'runner', text: '✓ a đạt' });
    expect(followUps(passed.msgs, false)).toContain('Viết báo cáo lượt chạy');
    expect(followUps(passed.msgs, true)).toEqual([]);
    const err = reduce(base, { sessionId: 's', kind: 'error', text: 'x' });
    expect(followUps(err.msgs, false)[0]).toBe('Thử lại');
    expect(renderToStaticMarkup(<SuggestionChips items={['Thử lại']} onPick={() => undefined} />)).toContain('Thử lại');
  });

  it('các tool liền nhau gom một thẻ đếm số bước', () => {
    const s = [
      { sessionId: 's', kind: 'tool_call' as const, toolName: 'a', toolCallId: '1' },
      { sessionId: 's', kind: 'tool_result' as const, toolName: 'a', toolCallId: '1' },
      { sessionId: 's', kind: 'tool_call' as const, toolName: 'b', toolCallId: '2' },
    ].reduce(reduce, sendUser(emptyState, 'x'));
    const out = renderToStaticMarkup(<AgentTranscriptView msgs={s.msgs} busy load={load} />);
    expect(out.match(/data-testid="tool-group"/g)).toHaveLength(1);
    expect(out).toContain('2 bước');
  });
});
