import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { BUSY_NOTE, isBusy, LastResultView, progressText, runSyncOp, SyncActions, SyncEmpty, SyncStatusView } from './SyncPage';
import type { SyncStatusResult } from './sync-api';

afterEach(() => vi.unstubAllGlobals());

const status: SyncStatusResult = {
  files: [
    { key: 'apps/mexpress/docs/prd-login.md', app: 'mexpress', kind: 'doc', state: 'synced' },
    { key: 'apps/mexpress/flows/01_login.yaml', app: 'mexpress', kind: 'flow', state: 'conflict', reason: 'invalid_flow', author: 'Lan' },
    { key: 'apps/mexpress/notes/n1.json', app: 'mexpress', kind: 'note', state: 'local_changed' },
    { key: 'apps/vipo/docs/brd.md', app: 'vipo', kind: 'doc', state: 'remote_new' },
  ],
  warnings: [{ key: 'apps/x/lạ.bin', message: 'khoá lạ trên kho' }],
  lastPush: '2026-11-19T03:00:00Z',
  counts: { synced: 1, conflict: 1, local_changed: 1, remote_new: 1 },
  conflicts: [{ key: 'apps/mexpress/flows/01_login.yaml', app: 'mexpress', kind: 'flow', author: 'Lan', device: 'MAC-LAN', reason: 'invalid_flow', theirsDeleted: false }],
};

describe('trang Đồng bộ', () => {
  it('bảng trạng thái theo app/tệp với nhãn trạng thái, danh sách xung đột dẫn tới màn gộp', () => {
    const html = renderToStaticMarkup(<SyncStatusView status={status} onMerge={() => undefined} />);
    expect(html).toContain('Xung đột cần gộp · 1');
    expect(html).toContain('Mở màn gộp');
    expect(html).toContain('bản của Lan (máy MAC-LAN)');
    expect(html).toContain('Flow của họ không qua kiểm tra an toàn');
    expect(html).toContain('data-app="mexpress"');
    expect(html).toContain('data-app="vipo"');
    expect(html).toContain('1 đã đồng bộ, 2 cần xử lý');
    expect(html).toMatch(/data-state="conflict"[\s\S]*flows\/01_login\.yaml[\s\S]*Xung đột/);
    expect(html).toMatch(/data-state="local_changed"[\s\S]*notes\/n1\.json[\s\S]*Đã sửa ở máy/);
    expect(html).toMatch(/data-state="remote_new"[\s\S]*docs\/brd\.md[\s\S]*Mới trên kho/);
    expect(html).not.toContain('data-state="synced"');
    expect(html).toContain('Kéo về lần cuối: chưa');
    expect(html).toContain('khoá lạ trên kho');
    expect(renderToStaticMarkup(<SyncStatusView status={{ files: [], warnings: [], counts: {}, conflicts: [] }} />)).toContain('Chưa có tệp nào');
  });

  it('nút Kéo về / Đẩy lên: tắt khi đang chạy và khi kho bận; không quyền thì không có nút', () => {
    const idle = renderToStaticMarkup(<SyncActions running="" canRun progress="" />);
    expect(idle).not.toMatch(/disabled=""/);
    expect(idle).toContain('Kéo về');
    expect(idle).toContain('Đẩy lên');
    const pulling = renderToStaticMarkup(<SyncActions running="pull" canRun progress="Kéo về: đang chạy…" />);
    expect(pulling.match(/disabled=""/g)).toHaveLength(2);
    expect(pulling).toContain('Đang kéo về…');
    expect(pulling).toContain('Kéo về: đang chạy…');
    const busy = renderToStaticMarkup(<SyncActions running="" busy canRun />);
    expect(busy.match(/disabled=""/g)).toHaveLength(2);
    expect(busy).toContain(BUSY_NOTE);
    const ro = renderToStaticMarkup(<SyncActions running="" canRun={false} />);
    expect(ro).not.toContain('<button');
    expect(ro).toContain('Cần quyền chạy flow');
  });

  it('đẩy/kéo gọi đúng hàm Go cho mọi app; busy nhận ra được', async () => {
    const calls: [string, unknown[]][] = [];
    vi.stubGlobal('window', {
      go: {
        test: {
          Service: {
            SyncPush: (...a: unknown[]) => (calls.push(['SyncPush', a]), Promise.resolve({ pushed: ['k'], conflicts: [], skipped: [], errors: [], warnings: [] })),
            SyncPull: (...a: unknown[]) => (calls.push(['SyncPull', a]), Promise.reject(new Error('busy: đang đẩy/kéo đồng bộ nhóm'))),
          },
        },
      },
    });
    expect(await runSyncOp('push')).toMatchObject({ op: 'push', result: { pushed: ['k'] } });
    const err = await runSyncOp('pull').catch((e: unknown) => e);
    expect(isBusy(err)).toBe(true);
    expect(isBusy(new Error('x'))).toBe(false);
    expect(calls).toEqual([
      ['SyncPush', [[]]],
      ['SyncPull', [[]]],
    ]);
  });

  it('kết quả lần cuối: số tệp, lý do bỏ qua, lỗi, nhắc đẩy bản gộp tự động', () => {
    const html = renderToStaticMarkup(
      <LastResultView
        last={{
          op: 'pull',
          result: {
            pulled: ['a', 'b'],
            deleted: [],
            merged: ['apps/m/flows/.cqs-flows.json'],
            conflicts: ['c'],
            skipped: [{ key: 'apps/m/docs/prd.md', reason: 'local_changed' }],
            errors: [{ key: 'apps/m/x.md', error: 'không ghi được' }],
            warnings: [],
          },
        }}
      />,
    );
    expect(html).toContain('Kết quả lần cuối · Kéo về');
    expect(html).toContain('2 đã kéo · 1 gộp tự động · 1 xung đột · 1 bỏ qua · 1 lỗi');
    expect(html).toContain('Đẩy lên để chia sẻ bản gộp.');
    expect(html).toContain('apps/m/docs/prd.md</span> · Đã sửa ở máy');
    expect(html).toContain('không ghi được');
  });

  it('chưa đăng nhập / chưa cấu hình: màn trống rõ ràng, Admin có lối tới Cài đặt', () => {
    const out = renderToStaticMarkup(<SyncEmpty block="not_signed_in" onOpenSettings={() => undefined} />);
    expect(out).toContain('Đăng nhập tài khoản công ty để đồng bộ nhóm');
    expect(out).not.toContain('Mở Cài đặt');
    const admin = renderToStaticMarkup(<SyncEmpty block="sync_not_configured" onOpenSettings={() => undefined} />);
    expect(admin).toContain('Mở Cài đặt › Kiểm thử');
    const staff = renderToStaticMarkup(<SyncEmpty block="sync_not_configured" />);
    expect(staff).toContain('Nhờ admin nhập endpoint');
    expect(staff).not.toContain('<button');
  });

  it('tiến độ từ sự kiện test:sync', () => {
    expect(progressText({ op: 'push', phase: 'start' })).toBe('Đẩy lên: đang chạy…');
    expect(progressText({ op: 'pull', phase: 'done' })).toBe('Kéo về: xong.');
    expect(progressText({ op: 'pull', phase: 'error', code: 'network', error: 'không kết nối được kho S3' })).toBe('Kéo về: lỗi, không kết nối được kho S3');
    expect(progressText({ op: 'share', phase: 'confirm', runId: 'r1', auto: true, sizeBytes: 300 * 1024 * 1024 })).toContain('Chia sẻ evidence lượt r1 (tự động): gói nặng 300,0 MB, cần xác nhận');
    expect(progressText({ op: 'share', phase: 'error', runId: 'r1', code: 'redaction_failed' })).toContain('chứa bí mật chưa che');
  });
});
