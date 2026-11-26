import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { applyMerge, changedText, conflictChanged, mergeRules, MergeView } from './MergeView';
import type { ConflictView } from './sync-api';

afterEach(() => vi.unstubAllGlobals());

const view: ConflictView = {
  key: 'apps/mexpress/docs/prd-login.md',
  app: 'mexpress',
  kind: 'doc',
  base: 'OTP 4 số\n',
  mine: 'OTP 6 số\n',
  theirs: 'OTP 8 số\n',
  merged: '<<<<<<< của tôi\nOTP 6 số\n=======\nOTP 8 số\n>>>>>>> của họ\n',
  conflicts: 1,
  mineDeleted: false,
  theirsDeleted: false,
  binary: false,
  theirAuthor: 'Lan',
  theirDevice: 'MAC-LAN',
  theirsSha256: 'sha-v1',
};

const render = (v: ConflictView, draft: string, edit = true) =>
  renderToStaticMarkup(<MergeView view={v} draft={draft} onDraft={() => undefined} onAction={edit ? () => undefined : undefined} />);

const saveDisabled = (html: string) => /<button[^>]*disabled=""[^>]*>(?:<svg[\s\S]*?<\/svg>)?Lưu bản gộp<\/button>/.test(html);

describe('màn gộp xung đột', () => {
  it('3 cột chỉ đọc đúng nội dung: Gốc / Của tôi / Của <tác giả>; ô kết quả điền sẵn bản gộp', () => {
    const html = render(view, view.merged);
    expect(html).toContain('data-col="base"');
    expect(html).toMatch(/data-col="base"[^>]*>OTP 4 số/);
    expect(html).toMatch(/data-col="mine"[^>]*>OTP 6 số/);
    expect(html).toMatch(/data-col="theirs"[^>]*>OTP 8 số/);
    expect(html).toContain('Của Lan');
    expect(html).toContain('MAC-LAN');
    expect(html).toContain('&lt;&lt;&lt;&lt;&lt;&lt;&lt; của tôi');
    expect(html).toContain('docs/prd-login.md');
  });

  it('còn dòng <<<<<<< thì khoá Lưu bản gộp; gộp xong thì mở', () => {
    expect(saveDisabled(render(view, view.merged))).toBe(true);
    expect(render(view, view.merged)).toContain('sửa hết các đoạn xung đột');
    const done = render(view, 'OTP 6 số\n');
    expect(done).toContain('Lưu bản gộp');
    expect(saveDisabled(done)).toBe(false);
    expect(done).toContain('Giữ bản của tôi');
    expect(done).toContain('Lấy bản của họ');
  });

  it('không có quyền: chỉ xem, không có nút', () => {
    const html = render(view, 'x', false);
    expect(html).not.toContain('Lưu bản gộp');
    expect(html).not.toContain('Giữ bản của tôi');
    expect(html).toContain('readOnly');
  });

  it('ảnh: không có ô gộp, chỉ chọn một bản', () => {
    const img = { ...view, kind: 'asset' as const, base: '', mine: '', theirs: '', merged: '', binary: true };
    const html = render(img, '');
    expect(mergeRules(img)).toEqual({ canMerge: false, canTakeTheirs: true });
    expect(html).toContain('Ảnh không gộp được');
    expect(html).not.toContain('<textarea');
    expect(html).not.toContain('Lưu bản gộp');
    expect(html).toContain('Giữ bản của tôi');
    expect(html).toContain('Lấy bản của họ');
  });

  it('một bên đã xoá: cột hiện rõ ai xoá', () => {
    expect(render({ ...view, theirsDeleted: true, theirs: '' }, 'OTP 6 số\n')).toContain('(Lan đã xoá)');
    expect(render({ ...view, mineDeleted: true, mine: '' }, 'OTP 8 số\n')).toContain('(đã xoá ở máy này)');
  });

  it('flow của họ không qua kiểm tra an toàn: hiện lý do, chỉ giữ bản của tôi hoặc sửa', () => {
    const bad = { ...view, kind: 'flow' as const, key: 'apps/mexpress/flows/01.yaml', reason: 'invalid_flow' as const, detail: 'lệnh runScript không được phép' };
    const html = render(bad, 'appId: x\n');
    expect(mergeRules(bad).canTakeTheirs).toBe(false);
    expect(html).toContain('Flow của họ không qua kiểm tra an toàn');
    expect(html).toContain('lệnh runScript không được phép');
    expect(html).toContain('Giữ bản của tôi');
    expect(html).toContain('Lưu bản gộp');
    expect(html).not.toContain('Lấy bản của họ');
  });

  it('bản của họ đổi sau khi mở: nhận ra mã lỗi và báo đã tải lại', () => {
    expect(conflictChanged({ code: 'sync_conflict_changed' })).toBe(true);
    expect(conflictChanged({ code: 'invalid' })).toBe(false);
    expect(conflictChanged(null)).toBe(false);
    expect(changedText(view)).toContain('Bản của Lan vừa đổi');
    expect(changedText({ theirAuthor: '' })).toContain('người khác');
  });

  it('lối tắt gọi đúng hàm Go, kèm sha bản của họ đã hiện', async () => {
    const calls: [string, unknown[]][] = [];
    const rec = (name: string) => (...a: unknown[]) => {
      calls.push([name, a]);
      return Promise.resolve(null);
    };
    vi.stubGlobal('window', { go: { test: { Service: { SyncResolve: rec('SyncResolve'), SyncKeepMine: rec('SyncKeepMine'), SyncTakeTheirs: rec('SyncTakeTheirs') } } } });
    await applyMerge('merge', view, 'OTP 6 số\n');
    await applyMerge('mine', view);
    await applyMerge('theirs', { key: view.key, theirsSha256: '' });
    expect(calls).toEqual([
      ['SyncResolve', [view.key, 'OTP 6 số\n', 'sha-v1']],
      ['SyncKeepMine', [view.key, 'sha-v1']],
      ['SyncTakeTheirs', [view.key, '']],
    ]);
  });
});
