import { describe, expect, it } from 'vitest';
import contract from '@contracts/errors.json';
import { ApiError } from '../platform/types';
import type { DriveStatus, ItemVersion } from './drive-api';
import {
  afterConflictDialog,
  alertText,
  bootstrapText,
  bootstrapVisible,
  canSeeStorage,
  conflictBlocks,
  currentRev,
  driveCopy,
  driveErrorText,
  originLabel,
  replacedBy,
  restoreAccess,
  restoreProblem,
  statusFromQueue,
  syncView,
  versionChanges,
  vnClock,
} from './sync-view';

const E: Record<string, string> = contract.errors;
const st = (state: DriveStatus['state'], label: DriveStatus['label'], n = 0, code = ''): DriveStatus => ({ state, label, params: { n }, code, pending: n, conflicts: 0, lastSyncAt: 0, lastPullAt: 0 });
// 16:05 ngày 11/11/2026 giờ Việt Nam
const T = Date.UTC(2026, 10, 11, 9, 5) / 1000;

describe('thanh trạng thái đồng bộ: đúng tên BR-007 và E-001', () => {
  it('mỗi trạng thái Go gửi ra đúng một câu', () => {
    expect(syncView(st('synced', 'sync_done')).text).toBe('Đã đồng bộ');
    expect(syncView(st('syncing', 'sync_running', 3)).text).toBe('Đang đồng bộ');
    expect(syncView(st('pending', 'sync_pending', 3)).text).toBe('3 chờ đồng bộ');
    expect(syncView(st('offline', 'sync_offline', 4)).text).toBe('Mất mạng · 4 chờ đồng bộ');
    expect(syncView(st('offline', 'sync_offline', 0)).text).toBe('Mất mạng · 0 chờ đồng bộ');
    expect(syncView(st('conflicts', 'sync_conflicts_open', 2)).text).toBe('2 chờ giải quyết xung đột');
    expect(syncView(st('not_connected', 'drive_not_connected')).text).toBe('Chưa kết nối Drive công ty — dữ liệu chỉ lưu trên máy này');
  });

  it('"Lỗi đồng bộ" luôn kèm câu lỗi có việc cần làm (E-003, E-004, E-021, E-022)', () => {
    for (const code of ['drive_no_access', 'drive_full', 'license_server_unreachable', 'drive_busy']) {
      const v = syncView(st('error', 'sync_error', 0, code));
      expect(v.text).toBe('Lỗi đồng bộ');
      expect(v.tone).toBe('error');
      expect(v.detail).toBe(E[code]);
    }
  });

  it('thiếu label (exe cũ) thì suy từ trạng thái; trạng thái lạ coi như đã đồng bộ', () => {
    expect(syncView({ state: 'pending', label: undefined as never, params: { n: 2 } }).text).toBe('2 chờ đồng bộ');
    expect(syncView({ state: 'gì đó' as never, label: undefined as never }).text).toBe('Đã đồng bộ');
  });

  it('exe chưa có drive.Service: suy từ hàng đợi theo cùng thứ tự ưu tiên', () => {
    const q = { online: true, syncing: false, pending: 0, failed: 0, conflict: 0, lastSyncAt: 0 };
    expect(statusFromQueue({ ...q, driveConnected: false, online: false }).state).toBe('not_connected');
    expect(statusFromQueue({ ...q, online: false, pending: 5, conflict: 1 })).toMatchObject({ state: 'offline', params: { n: 5 } });
    expect(statusFromQueue({ ...q, conflict: 2, failed: 1 })).toMatchObject({ state: 'conflicts', params: { n: 2 } });
    expect(statusFromQueue({ ...q, failed: 1, code: 'drive_full' })).toMatchObject({ state: 'error', code: 'drive_full' });
    expect(statusFromQueue({ ...q, pulling: true }).state).toBe('syncing');
    expect(statusFromQueue({ ...q, pending: 2 }).state).toBe('pending');
    expect(statusFromQueue(q).state).toBe('synced');
  });
});

describe('khôi phục phiên bản', () => {
  const v = (rev: number, user: string, origin: ItemVersion['origin'] = 'edit'): ItemVersion => ({
    kind: 'card', itemId: 'r1', rev, opId: `op${rev}`, baseRev: rev - 1, content: { card: { ma_hs: `${rev}` }, status: 'draft' }, actorUserId: user, actorName: user.toUpperCase(), deviceId: 'd', at: T + rev, origin, reason: '', approved: false, onDrive: true,
  });

  it('lý do bắt buộc, không được chỉ khoảng trắng (BR-006)', () => {
    expect(restoreProblem('')).toBe('restore_reason_required');
    expect(restoreProblem('   \n\t')).toBe('restore_reason_required');
    expect(restoreProblem(' hải quan yêu cầu ')).toBeNull();
    expect(driveCopy('restore_reason_required')).toBe('Nhập lý do khôi phục rồi bấm Khôi phục lại');
  });

  it('bản của mình khôi phục được; bản người khác cần lot.restore, không có thì tắt kèm E-012; bản hiện hành không có nút', () => {
    expect(restoreAccess(v(1, 'lan'), false, 'lan', false)).toEqual({ allowed: true, hint: null });
    expect(restoreAccess(v(1, 'minh'), false, 'lan', false)).toEqual({ allowed: false, hint: 'restore_not_own' });
    expect(restoreAccess(v(1, 'minh'), false, 'lan', true)).toEqual({ allowed: true, hint: null });
    expect(restoreAccess(v(3, 'lan'), true, 'lan', true)).toBeNull();
    expect(driveCopy('restore_not_own')).toBe('Chỉ Quản lý khai báo khôi phục được bản của người khác');
  });

  it('cảnh báo "Sẽ thay thế thay đổi của {tên} lúc {giờ}" khi sau bản chọn có bản của người khác', () => {
    const all = [v(1, 'lan'), v(2, 'lan'), v(3, 'minh'), v(4, 'tung', 'conflict_lost')];
    expect(currentRev(all)).toBe(3);
    expect(replacedBy(all, all[0], 'lan')?.rev).toBe(3);
    expect(replacedBy(all, all[0], 'minh')?.rev).toBe(2);
    expect(replacedBy([v(1, 'lan'), v(2, 'lan')], v(1, 'lan'), 'lan')).toBeNull();
    expect(driveCopy('restore_replaces', { name: 'Trần Lan', at: T })).toBe('Sẽ thay thế thay đổi của Trần Lan lúc 16:05 11/11/2026');
  });

  it('nhãn nguồn gốc và "sửa gì" giữa hai bản', () => {
    expect(['edit', 'remote', 'restore', 'conflict_lost', 'remove', 'undo_remove'].map(originLabel)).toEqual(['sửa', 'sửa', 'khôi phục', 'bị bỏ khi xung đột', 'gỡ', 'hoàn tác gỡ']);
    expect(versionChanges({ card: { ma_hs: '1', ten_khai: 'a' }, status: 'draft' }, { card: { ma_hs: '2', ten_khai: 'a' }, status: 'done' })).toEqual(['card.ma_hs', 'status']);
  });
});

describe('xung đột', () => {
  const open = [{ id: 'c1', kind: 'card', itemId: 'r1' }, { id: 'c2', kind: 'card', itemId: 'r2' }];
  it('đóng hộp mà chưa chọn: mục vẫn chờ giải quyết và vẫn chặn Chốt báo giá (BR-012)', () => {
    const after = afterConflictDialog(open, 'c1', null);
    expect(after).toEqual(open);
    expect(conflictBlocks('card', 'r1', after)).toBe(true);
  });
  it('chọn một bản thì mục rời danh sách và hết bị chặn', () => {
    for (const choice of ['mine', 'theirs'] as const) {
      const after = afterConflictDialog(open, 'c1', choice);
      expect(after.map((c) => c.id)).toEqual(['c2']);
      expect(conflictBlocks('card', 'r1', after)).toBe(false);
    }
    expect(conflictBlocks('card', 'r1', [{ kind: 'card', itemId: 'r1', status: 'kept_mine' }])).toBe(false);
  });
});

describe('Lưu trữ đám mây và cảnh báo admin', () => {
  it('chỉ người có quyền admin.drive thấy trang', () => {
    expect(canSeeStorage((p) => p === 'admin.drive')).toBe(true);
    expect(canSeeStorage(() => false)).toBe(false);
  });

  it('câu cảnh báo theo loại', () => {
    expect(alertText({ kind: 'drive_full', detail: null, deviceName: null })).toBe(E.drive_full);
    expect(alertText({ kind: 'drive_no_access', detail: null, deviceName: null })).toBe(E.drive_no_access);
    expect(alertText({ kind: 'license_unreachable', detail: null, deviceName: 'Máy Lan' })).toBe(`Máy Lan: ${E.license_server_unreachable}`);
    expect(alertText({ kind: 'drive_drop', detail: { kind: 'card', before: 40, after: 10 }, deviceName: null })).toContain('giảm từ 40 xuống 10');
    expect(alertText({ kind: 'device_stale', detail: { name: 'Máy Vy', lastSyncAt: T }, deviceName: null })).toBe('Máy Máy Vy chưa đồng bộ từ 16:05 11/11/2026 — mở app trên máy đó khi có mạng để đẩy dữ liệu lên Drive');
  });

  it('E-013 điền giờ sao lưu thành công gần nhất từ lỗi Go; chưa sao lưu lần nào thì không để chỗ trống', () => {
    expect(driveErrorText(new ApiError('backup_failed', 0, { lastBackupAt: T }))).toBe('Chưa sao lưu được. Lần sao lưu thành công gần nhất: 16:05 11/11/2026');
    expect(driveErrorText(new ApiError('backup_failed', 0, {}))).toBe('Chưa sao lưu được. Lần sao lưu thành công gần nhất: —');
    expect(driveErrorText(new ApiError('drive_admin_only', 403))).toBe(E.drive_admin_only);
  });
});

describe('máy mới lấy dữ liệu (E-017, E-011)', () => {
  it('câu theo mã và khi nào hiện màn', () => {
    expect(bootstrapText({ code: 'bootstrap_needs_network', done: 0, total: 0 })).toBe('Cần mạng để lấy dữ liệu lần đầu');
    expect(bootstrapText({ code: 'bootstrap_partial', done: 12, total: 40 })).toBe('Đã lấy 12/40 — sẽ tiếp tục khi có mạng');
    expect(bootstrapText({ code: '', done: 1, total: 2 })).toBe('');
    expect(bootstrapVisible({ stage: 1, done: 0, total: 5, running: true })).toBe(true);
    expect(bootstrapVisible({ stage: 2, done: 3, total: 5, running: false, code: 'bootstrap_partial' })).toBe(true);
    expect(bootstrapVisible({ stage: 3, done: 5, total: 5, running: false })).toBe(false);
    expect(bootstrapVisible({ stage: 0, done: 0, total: 0, running: false })).toBe(false);
    expect(driveCopy('previous_device_unsynced', { lastSyncAt: T })).toBe('Lần đồng bộ cuối của máy cũ: 16:05 11/11/2026. Thay đổi sau giờ đó không có trên Drive');
    expect(vnClock(T)).toBe('16:05 11/11/2026');
  });
});

describe('câu chữ lấy từ contracts/errors.json', () => {
  // Khoá giao diện đồng bộ dùng; câu hiện ra phải trùng nguyên văn câu trong hợp đồng (không ai viết lại trong mã).
  const KEYS = [
    'drive_not_connected', 'sync_offline', 'sync_done', 'sync_running', 'sync_pending', 'sync_error', 'sync_conflicts_open', 'sync_interrupted',
    'sync_keep_mine', 'sync_take_theirs', 'close_pending', 'close_wait_sync', 'close_anyway', 'restore_failed', 'restore_not_own', 'restore_reason_required',
    'restore_replaces', 'backup_failed', 'bootstrap_needs_network', 'bootstrap_partial', 'previous_device_unsynced', 'drive_admin_only', 'undo_remove_conflict',
    'conflict_version_lost', 'version_restored_over', 'drive_drop_alert', 'device_stale_alert',
  ];
  it('mọi khoá có trong hợp đồng; câu không tham số trả nguyên văn', () => {
    for (const k of KEYS) {
      expect(E[k], k).toBeTypeOf('string');
      if (!/\{/.test(E[k])) expect(driveCopy(k)).toBe(E[k]);
    }
    expect(() => driveCopy('khoa_khong_co')).toThrow();
  });
  it('mọi khoá trong nhóm driveBackupSync dùng được qua driveCopy', () => {
    for (const keys of Object.values(contract.driveBackupSync as Record<string, string[]>)) for (const k of keys) expect(driveCopy(k)).toBe(E[k]);
  });
  it('thông báo cho người bị thay bản điền {name}, {item}, {giờ}', () => {
    expect(driveCopy('version_restored_over', { name: 'Minh', item: 'VPO-12', at: T })).toBe(
      'Minh đã khôi phục VPO-12 về bản cũ, thay thế thay đổi của bạn lúc 16:05 11/11/2026. Bản của bạn vẫn còn trong lịch sử phiên bản — mở lịch sử để xem hoặc khôi phục',
    );
  });
});
