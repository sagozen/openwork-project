import { describe, expect, it } from 'vitest';
import permissions from '@contracts/permissions.json';
import { ApiError } from '../../platform/types';
import { errorText } from '../../lib/errors';
import type { MatrixView } from './admin-api';
import { auditQuery, qs } from './admin-api';
import { changesByGroup, changesOf, draftFrom, hasChanges, isLocked, saveBody, toggled, shown } from './matrix-draft';
import { matrixColumns } from './matrix-copy';

const saved = (): MatrixView => ({
  version: 3,
  updatedBy: null,
  updatedAt: null,
  roles: ['admin', 'manager', 'leader', 'staff'],
  cells: Object.fromEntries(['admin', 'manager', 'leader', 'staff'].map((r) => [r, Object.fromEntries(permissions.permissions.map((p) => [p.code, r === 'admin' ? true : (p.default as Record<string, boolean>)[r]]))])),
});

describe('bản nháp bảng quyền', () => {
  it('chưa sửa gì thì không có thay đổi', () => {
    const s = saved();
    expect(hasChanges(s, draftFrom(s))).toBe(false);
    expect(changesOf(s, draftFrom(s))).toEqual([]);
  });

  it('bật quyền duyệt cho leader và tắt nạp biểu thuế của manager: 2 thay đổi, kèm giá trị cũ', () => {
    const s = saved();
    let d = draftFrom(s);
    d = toggled(d, 'leader', 'approve.review');
    d = toggled(d, 'manager', 'tariff.load');
    expect(changesOf(s, d)).toEqual([
      { role: 'manager', perm: 'tariff.load', from: true, to: false },
      { role: 'leader', perm: 'approve.review', from: false, to: true },
    ]);
    expect(saveBody(s, d)).toEqual({ version: 3, cells: { manager: { 'tariff.load': false }, leader: { 'approve.review': true } } });
    expect(changesByGroup(s, d)).toEqual({ 'Dữ liệu chung': 1, Duyệt: 1 });
  });

  it('bật rồi tắt lại thì không còn là thay đổi', () => {
    const s = saved();
    const d = toggled(toggled(draftFrom(s), 'staff', 'report.view'), 'staff', 'report.view');
    expect(hasChanges(s, d)).toBe(false);
  });

  it('ô khoá và cột admin không đổi được (BR-003); dòng ngân sách AI đổi được', () => {
    const s = saved();
    const d = draftFrom(s);
    expect(isLocked('manager', 'admin.accounts')).toBe(true);
    expect(isLocked('staff', 'admin.drive')).toBe(true);
    expect(isLocked('admin', 'work.do')).toBe(true);
    expect(isLocked('manager', 'admin.ai_budget')).toBe(false);
    expect(toggled(d, 'manager', 'admin.accounts')).toBe(d);
    expect(toggled(d, 'admin', 'work.do')).toBe(d);
    expect(changesOf(s, toggled(d, 'manager', 'admin.ai_budget'))).toHaveLength(1);
  });

  it('không sửa bản đã lưu khi sửa bản nháp', () => {
    const s = saved();
    const d = toggled(draftFrom(s), 'leader', 'approve.review');
    expect(s.cells.leader['approve.review']).toBe(false);
    expect(d.leader['approve.review']).toBe(true);
  });
});

describe('E-023 và các lỗi quản trị', () => {
  it('xung đột bảng quyền nêu người sửa và giờ (giờ Việt Nam)', () => {
    const at = Date.UTC(2026, 10, 11, 9, 5) / 1000;
    const e = new ApiError('matrix_conflict', 409, { by: 'Chị Hoa', at, version: 4 });
    expect(errorText(e)).toBe('Bảng quyền vừa được Chị Hoa sửa lúc 16:05. Tải lại rồi chỉnh tiếp.');
  });

  it('admin cuối cùng (E-010) và mất mạng (E-020)', () => {
    expect(errorText(new ApiError('last_admin', 409))).toBe('Phải còn ít nhất một admin của công ty đang hoạt động (không tính tài khoản Bên triển khai). Gán vai admin cho người khác trước.');
    expect(errorText(new ApiError('need_network', 0))).toBe('Cần kết nối mạng để lưu thay đổi tài khoản.');
  });
});

describe('chuỗi truy vấn', () => {
  it('bỏ tham số trống, nối nhiều loại thao tác bằng dấu phẩy', () => {
    expect(qs({ a: 1, b: undefined, c: '' })).toBe('?a=1');
    expect(qs({})).toBe('');
    expect(auditQuery({ user: 'u1', action: ['user_lock', 'login_locked'], from: 10, limit: 12 })).toBe('?user=u1&action=user_lock%2Clogin_locked&from=10&limit=12');
  });
});

describe('bảng quyền theo sản phẩm có bản quyền', () => {
  const hsOnly = { manager: { 'admin.ai_budget': false, 'work.do': true }, leader: {}, staff: {} };
  it('chỉ hiện quyền máy chủ trả về', () => {
    expect(shown(hsOnly, 'work.do')).toBe(true);
    expect(shown(hsOnly, 'cqs.run')).toBe(false);
  });
  it('thẻ, nhóm không còn quyền nào thì ẩn; có ChatQASoftware thì hiện thẻ của nó', () => {
    expect(matrixColumns(hsOnly)).toEqual([['Quản trị'], ['Làm việc']]);
    const both = { ...hsOnly, manager: { ...hsOnly.manager, 'cqs.run': true } };
    expect(matrixColumns(both)).toEqual([['Quản trị'], ['Làm việc'], ['Kiểm thử']]);
  });
  it('ChatQASoftware chỉ hiện quyền của chính nó (không còn nhóm HS Desk/kết nối Drive)', () => {
    const both = { manager: { 'admin.ai_budget': false, 'work.do': true, 'cqs.run': true, 'cqs.reports': false }, leader: {}, staff: {} };
    expect(matrixColumns(both, 'chatqa')).toEqual([['Kiểm thử', 'Giám sát']]);
    expect(matrixColumns(both, 'hsdesk')).toEqual([['Quản trị'], ['Làm việc']]);
  });
});
