import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router';
import contract from '@contracts/errors.json';
import type { DriveConflictDetail, DriveStatus, ItemVersion } from '../sync/drive-api';
import { syncView } from '../sync/sync-view';
import { SyncBadgeView } from './SyncBadge';
import { SyncPanelView } from './SyncPanel';
import { ConflictDialogView, registerFieldLabels } from './ConflictDialog';
import { RestoreDialog, VersionHistoryView } from './VersionHistory';
import { BootstrapScreen } from './BootstrapScreen';
import { ClosePendingDialog, DriveAlertBannerView } from './DriveSyncHost';

const E: Record<string, string> = contract.errors;
const T = Date.UTC(2026, 10, 11, 9, 5) / 1000;
const noop = () => undefined;
// renderToStaticMarkup giữ nguyên chữ nhưng mã hoá & < > " '
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');

const session = vi.hoisted(() => ({ perms: [] as string[] }));
vi.mock('../lib/session', async (orig) => ({
  ...(await orig<typeof import('../lib/session')>()),
  useSession: () => ({ state: null, can: (p: string) => session.perms.includes(p) }),
}));

const status = (state: DriveStatus['state'], label: DriveStatus['label'], n = 0, code = ''): DriveStatus => ({ state, label, params: { n }, code, pending: n, conflicts: 0, lastSyncAt: T, lastPullAt: 0 });

describe('SyncBadge', () => {
  const cases: [DriveStatus, string][] = [
    [status('synced', 'sync_done'), 'Đã đồng bộ'],
    [status('syncing', 'sync_running', 2), 'Đang đồng bộ'],
    [status('pending', 'sync_pending', 2), '2 chờ đồng bộ'],
    [status('offline', 'sync_offline', 3), 'Mất mạng · 3 chờ đồng bộ'],
    [status('error', 'sync_error', 0, 'drive_full'), 'Lỗi đồng bộ'],
    [status('conflicts', 'sync_conflicts_open', 1), '1 chờ giải quyết xung đột'],
    [status('not_connected', 'drive_not_connected'), E.drive_not_connected],
  ];
  it.each(cases)('trạng thái %# hiện đúng chữ, bấm được', (s, text) => {
    for (const surface of ['dark', 'light'] as const) {
      const html = renderToStaticMarkup(<SyncBadgeView view={syncView(s)} surface={surface} />);
      expect(html).toContain(`>${esc(text)}</span>`);
      expect(html).toContain(`data-sync-state="${s.state}"`);
      expect(html).toMatch(/^<button/);
    }
  });
  it('đầu trang điện thoại: chỉ chấm, chữ vẫn ở nhãn và chú thích, bấm được', () => {
    const html = renderToStaticMarkup(<SyncBadgeView view={syncView(status('not_connected', 'drive_not_connected'))} surface="light" compact />);
    expect(html).toMatch(/^<button/);
    expect(html).not.toContain(`>${esc(E.drive_not_connected)}</span>`);
    expect(html).toContain(`aria-label="Trạng thái đồng bộ: ${esc(E.drive_not_connected)}"`);
    expect(html).toContain(`title="${esc(E.drive_not_connected)}"`);
  });
  it('lỗi đồng bộ kèm câu việc cần làm ở chú thích', () => {
    expect(renderToStaticMarkup(<SyncBadgeView view={syncView(status('error', 'sync_error', 0, 'drive_no_access'))} />)).toContain(`title="${esc(E.drive_no_access)}"`);
  });
});

describe('SyncPanel', () => {
  const conflict = { id: 'c1', kind: 'card', itemId: 'VPO-12' } as never;
  it('desktop: số chờ, lần đồng bộ cuối, xung đột mở, thông báo, Kéo ngay, Đồng bộ ngay, xuất nhật ký', () => {
    const html = renderToStaticMarkup(
      <SyncPanelView
        status={status('conflicts', 'sync_conflicts_open', 1)}
        conflicts={[conflict]}
        notices={[{ id: 'n1', kind: 'card', itemId: 'VPO-12', messageCode: 'conflict_version_lost', params: { name: 'Minh', item: 'VPO-12' }, createdAt: T, seenAt: 0 }]}
        local
      />,
    );
    for (const s of ['Chờ đồng bộ', 'Lần đồng bộ cuối', '16:05 11/11/2026', 'VPO-12', 'chờ giải quyết xung đột', 'Kéo ngay', 'Đồng bộ ngay', 'Xuất nhật ký đồng bộ']) expect(html).toContain(s);
    expect(html).toContain(esc('Minh đã chọn bản khác cho VPO-12.'));
  });
  it('nhiều thông báo: có nút Đã xem tất cả; chỉ một thì không', () => {
    const n = (id: string) => ({ id, kind: 'card', itemId: 'VPO-12', messageCode: 'conflict_version_lost', params: { name: 'Minh', item: 'VPO-12' }, createdAt: T, seenAt: 0 });
    const many = renderToStaticMarkup(<SyncPanelView status={status('synced', 'sync_done')} conflicts={[]} notices={[n('a'), n('b')]} local onSeeAllNotices={() => undefined} />);
    expect(many).toContain('Đã xem tất cả');
    expect(many).toContain('2 thông báo');
    const one = renderToStaticMarkup(<SyncPanelView status={status('synced', 'sync_done')} conflicts={[]} notices={[n('a')]} local onSeeAllNotices={() => undefined} />);
    expect(one).not.toContain('Đã xem tất cả');
  });
  it('web: chỉ trạng thái, không có thao tác trên máy', () => {
    const html = renderToStaticMarkup(<SyncPanelView status={status('synced', 'sync_done')} conflicts={[]} notices={[]} local={false} />);
    expect(html).toContain('Đã đồng bộ');
    expect(html).not.toContain('Kéo ngay');
    expect(html).not.toContain('Đồng bộ ngay');
  });
});

describe('ConflictDialog', () => {
  registerFieldLabels('card', [{ key: 'card.ma_hs', label: 'Mã HS' }, { key: 'card.ten_khai', label: 'Tên khai' }]);
  const detail = {
    id: 'c1', kind: 'card', itemId: 'VPO-12', mineRev: 3, mineRemoved: false, theirsRemoved: false, theirsUser: 'u2', theirsName: 'Trần Lan', theirsDevice: 'Máy kế toán', theirsAt: T,
    fields: [{ field: 'card.ten_khai', mine: 'Bóng LED', theirs: 'Bóng LED' }, { field: 'card.ma_hs', mine: '8539.52', theirs: '9405.11' }],
  } as unknown as DriveConflictDetail;

  it('hai cột với người, máy, giờ; trường khác nhau được tô và lên đầu; hai nút đúng câu E-005', () => {
    const html = renderToStaticMarkup(<ConflictDialogView detail={detail} myName="Hoa" onResolve={noop} onClose={noop} overlay={false} />);
    expect(html).toContain('Bản của tôi');
    expect(html).toContain('Bản kia');
    expect(html).toContain('Trần Lan · Máy kế toán · 16:05 11/11/2026');
    expect(html.match(/data-changed="true"/g)).toHaveLength(1);
    expect(html.indexOf('Mã HS')).toBeLessThan(html.indexOf('Tên khai'));
    expect(html).toContain(`>${E.sync_keep_mine}</button>`);
    expect(html).toContain(`>${E.sync_take_theirs}</button>`);
    expect(html).toContain('aria-label="Đóng"');
  });

  it('bấm nút gọi đúng lựa chọn; đóng không chọn bản nào', () => {
    const calls: string[] = [];
    // Duyệt cây phần tử để bấm nút mà không cần DOM.
    type El = { type: unknown; props: Record<string, unknown> & { children?: unknown } };
    const tree = ConflictDialogView({ detail, onResolve: (k) => calls.push(k ? 'mine' : 'theirs'), onClose: () => calls.push('close'), overlay: false }) as unknown as El;
    const actions = tree.props.actions as El;
    const [take, keep] = (actions.props.children as El[]);
    (take.props.onClick as () => void)();
    (keep.props.onClick as () => void)();
    (tree.props.onClose as () => void)();
    expect(calls).toEqual(['theirs', 'mine', 'close']);
  });
});

describe('Lịch sử phiên bản', () => {
  const v = (rev: number, user: string, origin: ItemVersion['origin'] = 'edit', reason = ''): ItemVersion => ({
    kind: 'card', itemId: 'r1', rev, opId: `op${rev}`, baseRev: rev - 1, content: { card: { ma_hs: `${rev}` } }, actorUserId: user, actorName: user, deviceId: 'd', at: T, origin, reason, approved: false, onDrive: true,
  });

  it('mục chưa sửa lần nào: "Chưa có phiên bản cũ"', () => {
    for (const versions of [[], [v(1, 'lan')]]) expect(renderToStaticMarkup(<VersionHistoryView title="t" versions={versions} me="lan" canRestoreOthers={false} onPick={noop} onClose={noop} />)).toContain('Chưa có phiên bản cũ');
  });

  it('mới nhất trước, nhãn nguồn gốc, lý do khôi phục; bản người khác tắt kèm E-012 khi không có lot.restore', () => {
    const versions = [v(1, 'minh'), v(2, 'lan', 'conflict_lost'), v(3, 'lan', 'restore', 'theo tờ khai 12/11')];
    const html = renderToStaticMarkup(<VersionHistoryView title="t" versions={versions} me="lan" canRestoreOthers={false} onPick={noop} onClose={noop} />);
    const order = [3, 2, 1].map((r) => html.indexOf(`data-rev="${r}"`));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain('khôi phục');
    expect(html).toContain('bị bỏ khi xung đột');
    expect(html).toContain('Lý do: theo tờ khai 12/11');
    expect(html).toContain('bản hiện hành');
    const row1 = html.slice(order[2]);
    // Một thẻ <button> có cả disabled và title (không phụ thuộc thứ tự thuộc tính).
    expect(row1).toMatch(/<button(?=[^>]*disabled="")[^>]*title="Chỉ Quản lý khai báo khôi phục được bản của người khác"/);
    expect(row1).toContain(`>${E.restore_not_own}</span>`);
    // Có lot.restore: bản người khác bấm được.
    const mgr = renderToStaticMarkup(<VersionHistoryView title="t" versions={versions} me="lan" canRestoreOthers onPick={noop} onClose={noop} />);
    expect(mgr).not.toContain('disabled=""');
  });

  it('hộp Khôi phục: lý do bắt buộc, cảnh báo thay bản của người khác', () => {
    const base = { version: v(1, 'lan'), reason: '  ', onReason: noop, onCancel: noop, onConfirm: noop, overlay: false };
    expect(renderToStaticMarkup(<RestoreDialog {...base} replaces={null} />)).not.toContain(E.restore_reason_required);
    const tried = renderToStaticMarkup(<RestoreDialog {...base} replaces={null} showProblem />);
    expect(tried).toContain(E.restore_reason_required);
    expect(tried).toContain('aria-invalid="true"');
    expect(renderToStaticMarkup(<RestoreDialog {...base} reason="có lý do" replaces={null} showProblem />)).not.toContain(E.restore_reason_required);
    const warn = renderToStaticMarkup(<RestoreDialog {...base} replaces={{ name: 'Trần Lan', at: T }} />);
    expect(warn).toContain('Sẽ thay thế thay đổi của Trần Lan lúc 16:05 11/11/2026');
    expect(warn).toContain('Khôi phục v1');
  });
});

describe('màn và hộp toàn cục', () => {
  it('máy mới: bước, x/y, câu E-017 và E-011', () => {
    const html = renderToStaticMarkup(<BootstrapScreen overlay={false} progress={{ stage: 2, done: 12, total: 40, running: false, code: 'bootstrap_partial', previousDevice: { deviceId: 'd0', name: 'Máy cũ', lastSyncAt: T } }} />);
    expect(html).toContain('12/40');
    expect(html).toContain(esc('Đã lấy 12/40 — sẽ tiếp tục khi có mạng'));
    expect(html).toContain('Lần đồng bộ cuối của máy cũ: 16:05 11/11/2026');
    expect(renderToStaticMarkup(<BootstrapScreen overlay={false} progress={{ stage: 1, done: 0, total: 0, running: false, code: 'bootstrap_needs_network' }} />)).toContain(E.bootstrap_needs_network);
  });

  it('đóng app còn chờ (E-008)', () => {
    const html = renderToStaticMarkup(<ClosePendingDialog pending={4} waiting={false} onWait={noop} onClose={noop} overlay={false} />);
    expect(html).toContain('Còn 4 mục chưa lên Drive');
    expect(html).toContain(`>${E.close_wait_sync}</button>`);
    expect(html).toContain(`>${E.close_anyway}</button>`);
  });

  it('cảnh báo Drive cho admin, không có cảnh báo thì không hiện', () => {
    expect(renderToStaticMarkup(<DriveAlertBannerView alerts={[]} onSeen={noop} />)).toBe('');
    const html = renderToStaticMarkup(<DriveAlertBannerView alerts={[{ id: 'a', kind: 'drive_full', deviceId: null, deviceName: null, detail: null, day: '', createdAt: T }]} onSeen={noop} />);
    expect(html).toContain(esc(E.drive_full));
    expect(html).toContain('role="alert"');
  });
});

describe('Lưu trữ đám mây chỉ cho admin.drive', () => {
  it('nhân sự vào thẳng đường dẫn: không thấy trang; người có quyền thấy', async () => {
    const { StoragePage } = await import('../pages/StoragePage');
    const render = () =>
      renderToStaticMarkup(
        <MemoryRouter initialEntries={['/luu-tru']}>
          <Routes>
            <Route path="/luu-tru" element={<StoragePage />} />
            <Route path="/" element={<p>trang chủ</p>} />
          </Routes>
        </MemoryRouter>,
      );
    session.perms = [];
    expect(render()).not.toContain('Lưu trữ &amp; đồng bộ đám mây');
    session.perms = ['admin.drive'];
    const html = render();
    expect(html).toContain('Lưu trữ &amp; đồng bộ đám mây');
    expect(html).toContain('Sao lưu ngay');
  });
});
