import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Doc, Revision } from '../testing/bridge';
import { DocEditorView, draftOf, draftProblem, saveDraft, type EditorDraft } from './DocEditor';
import { DiffView, DocHistoryView } from './DocHistory';
import { DocList } from './DocsPage';
import { AffectedCases } from './AffectedCases';
import { ANCHOR_HINT, assignedIds, composeDoc, diffLines, docErrorText, regenReqs, splitDoc } from './docs-api';

afterEach(() => vi.unstubAllGlobals());

const savedDoc: Doc = {
  id: 'prd-login',
  type: 'PRD',
  title: 'Đăng nhập',
  rev: 1,
  markdown: '---\ntype: PRD\ntitle: Đăng nhập\nrev: 1\nowner: Lan\n---\n## OTP {#REQ-001}\nNhập mã.\n## Khoá {#REQ-002}\n- Sai 5 lần {#REQ-003}\n',
  requirements: [
    { id: 'REQ-001', doc: 'prd-login', title: 'OTP', body: 'Nhập mã.', hash: 'h1', line: 7 },
    { id: 'REQ-002', doc: 'prd-login', title: 'Khoá', body: '', hash: 'h2', line: 9 },
    { id: 'REQ-003', doc: 'prd-login', title: 'Sai 5 lần', body: '', hash: 'h3', line: 10 },
  ],
};

describe('front-matter tài liệu', () => {
  it('tách loại, tiêu đề, dòng khác; bỏ rev; ghép lại giữ dòng khác', () => {
    const p = splitDoc(savedDoc.markdown);
    expect(p).toEqual({ type: 'PRD', title: 'Đăng nhập', extra: ['owner: Lan'], body: '## OTP {#REQ-001}\nNhập mã.\n## Khoá {#REQ-002}\n- Sai 5 lần {#REQ-003}\n' });
    expect(composeDoc({ ...p, title: ' Đăng  nhập\nmới ' })).toBe(`---\ntype: PRD\ntitle: Đăng nhập mới\nowner: Lan\n---\n${p.body}`);
    expect(splitDoc('# Không có front-matter')).toEqual({ type: 'other', title: '', extra: [], body: '# Không có front-matter' });
  });

  it('bản nháp: tài liệu mới mặc định PRD; kiểm mã tài liệu, trùng mã, nội dung trống', () => {
    const fresh = draftOf(null);
    expect(fresh.type).toBe('PRD');
    expect(draftProblem({ ...fresh, id: 'PRD Login', body: 'x' }, true, [])).toContain('chữ thường');
    expect(draftProblem({ ...fresh, id: 'prd-login', body: 'x' }, true, ['prd-login'])).toContain('Đã có');
    expect(draftProblem({ ...fresh, id: 'prd-login', body: '  ' }, true, [])).toBe('Nội dung trống.');
    expect(draftProblem(draftOf(savedDoc), false, ['prd-login'])).toBe('');
  });
});

describe('lưu tài liệu', () => {
  it('lưu gửi Markdown có front-matter qua SaveDoc và hiện các mã app vừa gán', async () => {
    const calls: unknown[][] = [];
    vi.stubGlobal('window', {
      go: {
        test: {
          Service: {
            SaveDoc: (...a: unknown[]) => {
              calls.push(a);
              return Promise.resolve(savedDoc);
            },
          },
        },
      },
    });
    const draft: EditorDraft = { id: 'prd-login', type: 'PRD', title: 'Đăng nhập', extra: [], body: '## OTP {#REQ-001}\nNhập mã.\n## Khoá\n- Sai 5 lần\n' };
    const { doc, assigned } = await saveDraft('mexpress', draft);
    expect(calls).toEqual([['mexpress', 'prd-login', `---\ntype: PRD\ntitle: Đăng nhập\n---\n${draft.body}`]]);
    expect(doc.rev).toBe(1);
    expect(assigned).toEqual(['REQ-002', 'REQ-003']);

    const html = renderToStaticMarkup(<DocEditorView draft={draftOf(doc)} isNew={false} rev={doc.rev} reqCount={3} assigned={assigned} onSave={() => undefined} />);
    expect(html).toContain('Mã vừa gán: <span class="font-mono font-semibold">REQ-002, REQ-003</span>');
    expect(html).toContain('{#REQ-002}'); // trình soạn thảo nạp lại bản đã gắn mã
    expect(html).toContain('bản 1');
  });

  it('lưu lại không gán mã mới; Go trả lỗi trùng mã thì hiện câu chi tiết', async () => {
    expect(assignedIds(savedDoc.markdown, savedDoc)).toEqual([]);
    vi.stubGlobal('window', {
      go: { test: { Service: { SaveDoc: () => Promise.reject(new Error('invalid: mã REQ-001 trùng trong tài liệu "prd-login" (dòng 7 và 9)')) } } },
    });
    const err = await saveDraft('mexpress', draftOf(savedDoc)).catch((e: unknown) => e);
    expect(docErrorText(err)).toBe('mã REQ-001 trùng trong tài liệu "prd-login" (dòng 7 và 9)');
  });

  it('gợi ý quy ước neo và ghi chú bảng Markdown không hỗ trợ; không quyền thì chỉ xem', () => {
    const html = renderToStaticMarkup(<DocEditorView draft={draftOf(null)} isNew problem="Nội dung trống." onSave={() => undefined} />);
    expect(ANCHOR_HINT).toBe('Thêm `{#REQ-012}` cuối tiêu đề; để trống, app tự gán khi lưu');
    expect(html).toContain('Thêm `{#REQ-012}` cuối tiêu đề; để trống, app tự gán khi lưu');
    expect(html).toContain('Bảng Markdown không hỗ trợ mã yêu cầu');
    expect(html).toContain('<textarea');
    expect(html).toContain('Lưu');
    const ro = renderToStaticMarkup(<DocEditorView draft={draftOf(savedDoc)} isNew={false} />);
    expect(ro).not.toContain('>Lưu<');
    expect(ro).toContain('readOnly');
  });

  it('danh sách tài liệu: loại, tiêu đề, bản, số yêu cầu', () => {
    const html = renderToStaticMarkup(
      <DocList docs={[{ id: 'prd-login', type: 'PRD', title: 'Đăng nhập', rev: 3, updatedAt: '2026-11-19T02:00:00Z' }, { id: 'ghi-chu', type: 'other', title: '', rev: 1, updatedAt: '' }]} counts={{ 'prd-login': 3 }} />,
    );
    expect(html).toContain('PRD');
    expect(html).toContain('Đăng nhập');
    expect(html).toContain('prd-login · bản 3');
    expect(html).toContain('3 yêu cầu');
    expect(html).toContain('Khác');
    expect(html).toContain('0 yêu cầu');
    expect(renderToStaticMarkup(<DocList docs={[]} counts={{}} />)).toContain('chưa có tài liệu');
  });
});

describe('lịch sử và diff', () => {
  const diff = '  ---\n- title: Cũ\n+ title: Mới\n  ## OTP {#REQ-001}\n- Nhập mã 4 số.\n+ Nhập mã 6 số.\n';

  it('dòng diff của Go thành thêm/bỏ/giữ', () => {
    expect(diffLines(diff).map((l) => `${l.kind}:${l.text}`)).toEqual([
      'same:---',
      'del:title: Cũ',
      'add:title: Mới',
      'same:## OTP {#REQ-001}',
      'del:Nhập mã 4 số.',
      'add:Nhập mã 6 số.',
    ]);
    expect(diffLines('')).toEqual([]);
  });

  it('diff hiện đúng dòng + và - theo màu, hai bản giống nhau thì báo', () => {
    const html = renderToStaticMarkup(<DiffView diff={diff} />);
    expect(html).toContain('data-kind="add">+ Nhập mã 6 số.</span>');
    expect(html).toContain('data-kind="del">- Nhập mã 4 số.</span>');
    expect(html).toContain('data-kind="same">  ## OTP {#REQ-001}</span>');
    expect(html.match(/data-kind="add"/g)).toHaveLength(2);
    expect(html.match(/data-kind="del"/g)).toHaveLength(2);
    expect(renderToStaticMarkup(<DiffView diff={'  a\n  b\n'} />)).toContain('Hai bản giống nhau');
  });

  it('danh sách bản: khôi phục chỉ ở bản cũ và chỉ khi có quyền; chọn hai bản để so', () => {
    const revs: Revision[] = [
      { rev: 3, at: '2026-11-19T03:00:00Z', size: 1200, current: true },
      { rev: 2, at: '2026-11-19T02:00:00Z', size: 1100, current: false },
      { rev: 1, at: '2026-11-19T01:00:00Z', size: 900, current: false },
    ];
    const html = renderToStaticMarkup(<DocHistoryView revs={revs} from={2} to={3} diff={diff} onRestore={() => undefined} />);
    expect(html.match(/Khôi phục bản này/g)).toHaveLength(2);
    expect(html).toContain('đang dùng');
    expect(html).toContain('aria-label="Bản cũ"');
    expect(html).toContain('data-kind="add"');
    expect(renderToStaticMarkup(<DocHistoryView revs={revs} from={2} to={3} diff={diff} />)).not.toContain('Khôi phục bản này');
    expect(renderToStaticMarkup(<DocHistoryView revs={[]} from={0} to={0} diff={null} />)).toContain('chưa có lịch sử');
  });
});

describe('ca bị ảnh hưởng', () => {
  const cases = [
    { caseId: 'web:TC-k3x9p', title: 'Đăng nhập OTP', flow: '01_login.spec.ts', reqs: ['REQ-001'], reason: 'changed' as const },
    { caseId: 'TC-a1b2c', title: 'Khoá tài khoản', reqs: ['REQ-002', 'REQ-001'], removed: ['REQ-009'], reason: 'removed' as const },
    { caseId: 'TC-zz999', title: 'Chỉ còn mã đã xoá', reqs: [], removed: ['REQ-010'], reason: 'removed' as const },
  ];

  it('sinh lại dùng hợp các mã đã đổi (không gồm mã đã xoá)', () => {
    expect(regenReqs(cases)).toEqual(['REQ-001', 'REQ-002']);
  });

  it('danh sách ca, mã đã sửa/đã xoá, nút sinh lại và giữ nguyên chỉ khi có quyền', () => {
    const html = renderToStaticMarkup(<AffectedCases cases={cases} onRegenerate={() => undefined} onAck={() => undefined} />);
    expect(html).toContain('Ca bị ảnh hưởng · 3');
    expect(html).toContain('Sinh lại ca bị ảnh hưởng');
    expect(html.match(/<\/svg>Đã xem, giữ nguyên<\/button>/g)).toHaveLength(3);
    expect(html).toContain('web:TC-k3x9p · 01_login.spec.ts');
    expect(html).toContain('đã sửa REQ-002, REQ-001');
    expect(html).toContain('đã xoá REQ-009');
    const ro = renderToStaticMarkup(<AffectedCases cases={cases} />);
    expect(ro).not.toContain('Sinh lại ca bị ảnh hưởng');
    expect(ro).not.toMatch(/<\/svg>Đã xem, giữ nguyên<\/button>/);
    expect(renderToStaticMarkup(<AffectedCases cases={[]} />)).toBe('');
  });
});
