import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Note } from '../testing/bridge';
import { noteDraft, NoteDialogView, notesByReq, NotesList } from './NoteDialog';

describe('ghi chú nguồn có thể sai', () => {
  it('điền sẵn lượt chạy, flow và yêu cầu đầu tiên của flow', () => {
    expect(noteDraft({ runId: '261119-1000-ab12', flow: '01_login.spec.ts', reqs: ['REQ-001', 'REQ-002'] })).toEqual({
      req: 'REQ-001',
      runId: '261119-1000-ab12',
      flow: '01_login.spec.ts',
      text: '',
    });
    expect(noteDraft({ runId: 'r', flow: 'f', reqs: ['REQ-001', 'REQ-002'], req: 'REQ-002' }).req).toBe('REQ-002');
    expect(noteDraft({ runId: 'r', flow: 'f', reqs: ['REQ-001'], req: 'REQ-404' }).req).toBe('REQ-001');
  });

  it('hộp ghi chú hiện lượt, flow, yêu cầu đã chọn; chưa có nội dung thì chưa lưu được', () => {
    const draft = noteDraft({ runId: '261119-1000-ab12', flow: '01_login.spec.ts', reqs: ['REQ-001', 'REQ-002'], req: 'REQ-002' });
    const html = renderToStaticMarkup(<NoteDialogView draft={draft} reqs={['REQ-001', 'REQ-002']} />);
    expect(html).toContain('Nguồn có thể sai');
    expect(html).toContain('261119-1000-ab12');
    expect(html).toContain('01_login.spec.ts');
    expect(html).toContain('<option value="REQ-002" selected="">REQ-002</option>');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Lưu ghi chú<\/button>/);
    const filled = renderToStaticMarkup(<NoteDialogView draft={{ ...draft, text: 'Tài liệu ghi sai nhãn nút' }} reqs={['REQ-001', 'REQ-002']} error="Không có quyền" />);
    expect(filled).not.toMatch(/<button[^>]*disabled=""[^>]*>Lưu ghi chú<\/button>/);
    expect(filled).toContain('Không có quyền');
  });

  const notes: Note[] = [
    { id: 'n3', req: 'REQ-002', runId: 'r3', flow: '03_lock.yaml', text: 'Đã sửa tài liệu', author: 'Lan', at: '2026-11-19T03:00:00Z', status: 'resolved' },
    { id: 'n2', req: 'REQ-001', runId: 'r2', flow: '01_login.spec.ts', text: 'Nút tên Xác nhận chứ không phải Gửi', author: 'Minh', at: '2026-11-19T02:00:00Z', status: 'open' },
    { id: 'n1', req: 'REQ-001', runId: '', flow: '', text: 'OTP 6 số hay 4 số?', author: 'Lan', at: '2026-11-19T01:00:00Z', status: 'resolved' },
  ];

  it('danh sách theo yêu cầu: nhóm có ghi chú mở lên trước, đánh dấu đã xử lý chỉ khi có quyền', () => {
    expect(notesByReq(notes).map(([req, list]) => [req, list.map((n) => n.id)])).toEqual([
      ['REQ-001', ['n2', 'n1']],
      ['REQ-002', ['n3']],
    ]);
    const html = renderToStaticMarkup(<NotesList notes={notes} onResolve={() => undefined} />);
    expect(html).toContain('1 đang mở');
    expect(html.match(/Đánh dấu đã xử lý/g)).toHaveLength(1);
    expect(html.match(/>Đã xử lý</g)).toHaveLength(2);
    expect(html).toContain('lượt r2 · 01_login.spec.ts');
    expect(renderToStaticMarkup(<NotesList notes={notes} />)).not.toContain('Đánh dấu đã xử lý');
    expect(renderToStaticMarkup(<NotesList notes={[]} />)).toContain('Chưa có ghi chú');
  });
});
