// Các luồng của màn quản trị chạy qua adminApi với "máy chủ" giả (platform.api): E-023 bảng quyền, E-010 admin cuối, E-009 tên trùng,
// quyết định thao tác chờ, mất mạng (E-020, không gọi máy chủ), đặt lại mật khẩu.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import permissions from '@contracts/permissions.json';
import { ApiError } from '../../platform/types';

const api = vi.fn();
vi.mock('../../platform', () => ({ platform: { api: (...a: unknown[]) => api(...a) }, isDesktop: true }));

const { adminApi } = await import('./admin-api');
const { adminErrorText, isOfflineError, toAdminError, writeOnline } = await import('./admin-error');
const { changesOf, draftFrom, saveBody, toggled } = await import('./matrix-draft');
const { canSaveUser, editPatch, formFromUser, isBlockingError } = await import('./user-form');
const { afterDecision, isAlreadyDecided } = await import('./pending-format');
type MatrixView = Awaited<ReturnType<typeof adminApi.matrix>>;
type AdminUser = Awaited<ReturnType<typeof adminApi.user>>;

const t = (s: string) => Math.floor(new Date(`${s.replace(' ', 'T')}:00+07:00`).getTime() / 1000);

const matrix = (version: number): MatrixView => ({
  version,
  updatedBy: { id: 'u-bao', name: 'Nguyễn Quốc Bảo' },
  updatedAt: t('2026-11-11 14:32'),
  roles: ['admin', 'manager', 'leader', 'staff'],
  cells: Object.fromEntries(['admin', 'manager', 'leader', 'staff'].map((r) => [r, Object.fromEntries(permissions.permissions.map((p) => [p.code, r === 'admin' ? true : (p.default as Record<string, boolean>)[r]]))])),
});

beforeEach(() => api.mockReset());

describe('bảng quyền: lưu và xung đột E-023', () => {
  it('gửi PUT /matrix với version đã mở và chỉ các ô đổi', async () => {
    const saved = matrix(5);
    let draft = draftFrom(saved);
    draft = toggled(draft, 'leader', 'approve.unlock_item');
    draft = toggled(draft, 'leader', 'lot.restore');
    api.mockResolvedValueOnce(matrix(6));
    const body = saveBody(saved, draft);
    const next = await writeOnline(() => adminApi.saveMatrix(body.version, body.cells));
    expect(api).toHaveBeenCalledWith('/v1/admin/matrix', { method: 'PUT', body: { version: 5, cells: { leader: { 'approve.unlock_item': true, 'lot.restore': true } } } });
    expect(next.version).toBe(6);
  });

  it('admin khác vừa lưu: 409 matrix_conflict -> câu E-023 có tên người và giờ, bản nháp không bị mất, lưu lại dùng version mới', async () => {
    const saved = matrix(5);
    let draft = draftFrom(saved);
    draft = toggled(draft, 'leader', 'approve.unlock_item');
    api.mockRejectedValueOnce(new ApiError('matrix_conflict', 409, { by: 'Nguyễn Quốc Bảo', at: t('2026-11-11 14:32'), version: 6 }));
    const body = saveBody(saved, draft);
    const err = await writeOnline(() => adminApi.saveMatrix(body.version, body.cells)).catch((e) => e);
    expect(adminErrorText(err)).toBe('Bảng quyền vừa được Nguyễn Quốc Bảo sửa lúc 14:32. Tải lại rồi chỉnh tiếp.');
    // Bản nháp vẫn còn đúng 1 thay đổi (màn giữ nguyên, nút Lưu bị khoá cho tới khi "Tải lại").
    expect(changesOf(saved, draft)).toHaveLength(1);
    // Tải lại: lấy bản mới, chỉnh lại trên version 6.
    api.mockResolvedValueOnce(matrix(6));
    const fresh = await adminApi.matrix();
    const again = saveBody(fresh, toggled(draftFrom(fresh), 'leader', 'approve.unlock_item'));
    expect(again.version).toBe(6);
  });

  it('"Về mặc định" gửi version đang mở', async () => {
    api.mockResolvedValueOnce(matrix(7));
    await adminApi.resetMatrix(6);
    expect(api).toHaveBeenCalledWith('/v1/admin/matrix/reset', { method: 'POST', body: { version: 6 } });
  });

  it('ô khoá và cột admin không bao giờ vào thân gửi lên', () => {
    const saved = matrix(1);
    const draft = toggled(toggled(draftFrom(saved), 'manager', 'admin.accounts'), 'admin', 'tariff.load');
    expect(changesOf(saved, draft)).toEqual([]);
    expect(saveBody(saved, draft).cells).toEqual({});
  });
});

describe('tài khoản: lỗi chặn lưu', () => {
  const tran: AdminUser = {
    id: 'u-anh-tung', username: 'anhtung', display_name: 'Hoàng Anh Tùng', role: 'admin', status: 'active', apps: null, is_deployer: false, must_change_pw: false, temp_pw_expires_at: null,
    locked_at: null, temp_locked_until: null, last_login_at: null, last_device: null, created_at: 0, is_last_admin: true, web_sessions: [],
  };

  it('hạ admin cuối: 409 last_admin -> E-010, nút lưu tắt tới khi sửa biểu mẫu', async () => {
    const form = { ...formFromUser(tran, ['quote', 'lot', 'check', 'teach']), role: 'manager' };
    const patch = editPatch(tran, form, ['quote', 'lot', 'check', 'teach']);
    expect(patch).toEqual({ role: 'manager' });
    expect(canSaveUser('edit', form, patch, null)).toBe(true);

    api.mockRejectedValueOnce(new ApiError('last_admin', 409));
    const err = await writeOnline(() => adminApi.updateUser(tran.id, patch!)).catch((e) => e);
    expect(api).toHaveBeenCalledWith('/v1/admin/users/u-anh-tung', { method: 'PATCH', body: { role: 'manager' } });
    expect(adminErrorText(err)).toBe('Phải còn ít nhất một admin của công ty đang hoạt động (không tính tài khoản Bên triển khai). Gán vai admin cho người khác trước.');
    expect(isBlockingError(err)).toBe(true);
    expect(canSaveUser('edit', form, patch, err)).toBe(false);
    // Sửa lại biểu mẫu (xoá lỗi) thì lưu được lại.
    expect(canSaveUser('edit', { ...form, role: 'admin' }, null, null)).toBe(false);
    expect(canSaveUser('edit', form, patch, null)).toBe(true);
  });

  it('khoá admin cuối cũng là E-010', async () => {
    api.mockRejectedValueOnce(new ApiError('last_admin', 409));
    const err = await writeOnline(() => adminApi.updateUser('u-anh-tung', { active: false })).catch((e) => e);
    expect(api).toHaveBeenCalledWith('/v1/admin/users/u-anh-tung', { method: 'PATCH', body: { active: false } });
    expect(isBlockingError(err)).toBe(true);
  });

  it('tên đăng nhập trùng: E-009 có tên, chặn lưu', async () => {
    api.mockRejectedValueOnce(new ApiError('username_taken', 409, { username: 'tranlan' }));
    const err = await writeOnline(() => adminApi.createUser({ username: 'tranlan', role: 'staff', password: 'Vy-7429-tam' })).catch((e) => e);
    expect(adminErrorText(err)).toBe('Tên đăng nhập tranlan đã được dùng. Chọn tên khác.');
    expect(isBlockingError(err)).toBe(true);
  });

  it('thu hồi / kích hoạt lại máy: đủ chỗ thì E-015 nêu số máy tối đa', async () => {
    api.mockRejectedValueOnce(new ApiError('device_limit_reached', 409, { maxDevices: 7 }));
    const err = await writeOnline(() => adminApi.reactivateDevice('dev-kho02')).catch((e) => e);
    expect(api).toHaveBeenCalledWith('/v1/admin/devices/dev-kho02/reactivate', { method: 'POST', body: undefined });
    expect(adminErrorText(err)).toBe('Công ty đã dùng đủ 7 máy. Nhờ admin thu hồi máy không dùng, hoặc liên hệ bên triển khai.');
  });
});

describe('mất mạng: E-020 và không lưu gì (NFR-004)', () => {
  const E020 = 'Cần kết nối mạng để lưu thay đổi tài khoản.';

  it('không có mạng: ném E-020 ngay, không gọi máy chủ', async () => {
    const err = await writeOnline(() => adminApi.updateUser('u-1', { active: false }), () => false).catch((e) => e);
    expect(api).not.toHaveBeenCalled();
    expect(adminErrorText(err)).toBe(E020);
  });

  it('máy chủ không tới được (network / need_network) đều về E-020', async () => {
    api.mockRejectedValueOnce(new ApiError('network', 0));
    const e1 = await writeOnline(() => adminApi.saveMatrix(1, {}), () => true).catch((e) => e);
    expect(isOfflineError(e1)).toBe(true);
    expect(adminErrorText(e1)).toBe(E020);
    expect(adminErrorText(new ApiError('need_network', 0))).toBe(E020);
    expect(toAdminError(new ApiError('last_admin', 409))).toMatchObject({ code: 'last_admin' });
  });

  it('lỗi tải màn cũng ra E-020 (màn không hiện dữ liệu cũ)', () => {
    expect(adminErrorText(toAdminError(new ApiError('network', 0)))).toBe(E020);
  });
});

describe('thao tác chờ: công nhận / bỏ', () => {
  it('gọi đúng endpoint theo quyết định', async () => {
    api.mockResolvedValue({ ok: true });
    await adminApi.decidePending('dev-kho01.op1', 'accept');
    await adminApi.decidePending('dev-kho01.op2', 'drop');
    expect(api).toHaveBeenNthCalledWith(1, '/v1/admin/pending-ops/dev-kho01.op1/accept', { method: 'POST', body: undefined });
    expect(api).toHaveBeenNthCalledWith(2, '/v1/admin/pending-ops/dev-kho01.op2/drop', { method: 'POST', body: undefined });
  });

  it('người khác quyết trước (409 already_decided): dòng rời khỏi danh sách, không hiện lỗi', async () => {
    api.mockRejectedValueOnce(new ApiError('already_decided', 409));
    const err = await adminApi.decidePending('x', 'accept').catch((e) => e);
    expect(isAlreadyDecided(err)).toBe(true);
    const list = [{ id: 'a' }, { id: 'x' }] as never[];
    expect(afterDecision(list, 'x')).toEqual([{ id: 'a' }]);
  });

  it('đọc danh sách chờ theo trạng thái', async () => {
    api.mockResolvedValueOnce([]);
    await adminApi.pendingOps('pending');
    expect(api).toHaveBeenCalledWith('/v1/admin/pending-ops?status=pending', { method: 'GET', body: undefined });
  });
});

describe('đặt lại mật khẩu', () => {
  it('gửi mật khẩu gợi ý; máy chủ trả mật khẩu của nó thì dùng mật khẩu đó', async () => {
    api.mockResolvedValueOnce({ tempPassword: 'abcDEF2345', expiresAt: 1 });
    const res = await writeOnline(() => adminApi.resetPassword('u-le-ha', 'Ha-5183-tam'));
    expect(api).toHaveBeenCalledWith('/v1/admin/users/u-le-ha/reset-password', { method: 'POST', body: { password: 'Ha-5183-tam' } });
    expect(res.tempPassword).not.toBe('Ha-5183-tam');
  });

  it('không có mật khẩu gợi ý thì không gửi thân', async () => {
    api.mockResolvedValueOnce({ tempPassword: 'x', expiresAt: 1 });
    await adminApi.resetPassword('u-le-ha');
    expect(api).toHaveBeenCalledWith('/v1/admin/users/u-le-ha/reset-password', { method: 'POST', body: undefined });
  });
});

describe('phiên web: đăng xuất từ xa', () => {
  it('DELETE đúng phiên của đúng người', async () => {
    api.mockResolvedValueOnce({ ok: true });
    await adminApi.revokeWebSession('u-tran-lan', 's-1');
    expect(api).toHaveBeenCalledWith('/v1/admin/users/u-tran-lan/web-sessions/s-1', { method: 'DELETE', body: undefined });
  });
});
