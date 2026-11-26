import { describe, expect, it } from 'vitest';
import type { AdminDevice, AdminUser, AuditItem } from './admin-api';
import { auditQuery } from './admin-api';
import { ACTION_TYPES, buildAuditQuery, cursorQueryFor, DEFAULT_ACTIONS, DEFAULT_FILTERS, makeLookups, pageCount, pageWindow, presentAudit, rangeBounds, rangeLabel, rangeText } from './audit-format';

const t = (s: string) => Math.floor(new Date(`${s.replace(' ', 'T')}:00+07:00`).getTime() / 1000);
const NOW = t('2026-11-11 10:42');

const user = (id: string, username: string, display: string, over: Partial<AdminUser> = {}): AdminUser => ({
  id, username, display_name: display, role: 'staff', status: 'active', apps: null, is_deployer: false, must_change_pw: false, temp_pw_expires_at: null,
  locked_at: null, temp_locked_until: null, last_login_at: null, last_device: null, created_at: 0, ...over,
});
const device = (id: string, name: string): AdminDevice => ({ id, name, app_version: null, activated_at: 0, last_seen: 0, revoked: 0, revoked_at: null, key_hint: '', last_user_id: null, last_user_name: null, status: 'in_use' });
const lk = makeLookups([user('u-le-ha', 'leha', 'Lê Hà'), user('u-tran-lan', 'tranlan', 'Trần Lan')], [device('dev-kho01', 'PC-KHO-01'), device('dev-kho02', 'PC-KHO-02')]);

const item = (over: Partial<AuditItem>): AuditItem => ({
  id: 1, at: NOW, actor_user_id: 'u-anh-tung', actor_label: 'Hoàng Anh Tùng', actor_name: 'Hoàng Anh Tùng', actor_locked: false, actor_deployer: false,
  action: 'user_role', target_type: 'user', target_id: 'u-tran-lan', target_name: 'Trần Lan', before: null, after: null, ...over,
});

describe('bộ lọc nhật ký -> tham số GET /audit', () => {
  it('mặc định: tháng này, 12 dòng, bỏ đăng nhập thành công / sai', () => {
    const q = buildAuditQuery(DEFAULT_FILTERS, NOW);
    expect(q.limit).toBe(12);
    expect(q.user).toBeUndefined();
    expect(q.action).toEqual(DEFAULT_ACTIONS);
    expect(q.action).not.toContain('login_ok');
    expect(q.action).not.toContain('login_fail');
    expect(q.from).toBe(t('2026-11-01 00:00'));
    expect(q.to).toBe(t('2026-11-12 00:00'));
  });

  it('chọn người + loại thao tác + 7 ngày qua', () => {
    const q = buildAuditQuery({ user: 'u-le-ha', action: 'password_reset', range: 'week' }, NOW);
    expect(q).toMatchObject({ user: 'u-le-ha', action: ['password_reset'], from: t('2026-11-05 00:00'), to: t('2026-11-12 00:00') });
    expect(auditQuery(q)).toBe(`?user=u-le-ha&action=password_reset&from=${t('2026-11-05 00:00')}&to=${t('2026-11-12 00:00')}&limit=12`);
  });

  it('chọn riêng loại đăng nhập thì gửi đúng loại đó', () => {
    expect(buildAuditQuery({ user: '', action: 'login_ok', range: 'all' }, NOW).action).toEqual(['login_ok']);
  });

  it('khoảng "Tất cả" không gửi from/to; truy vấn không có tham số rỗng', () => {
    const q = buildAuditQuery({ user: '', action: '', range: 'all' }, NOW);
    expect(q.from).toBeUndefined();
    expect(q.to).toBeUndefined();
    expect(auditQuery(q)).not.toMatch(/from=|to=|user=/);
  });

  it('nhãn khoảng ngày như khung pen', () => {
    expect(rangeLabel('month', NOW)).toBe('01/11 – 11/11/2026');
    expect(rangeBounds('days30', NOW).from).toBe(t('2026-10-13 00:00'));
    expect(rangeLabel('all', NOW)).toBe('Tất cả');
  });

  it('mọi mã thao tác trong ô lọc đều có nhãn và không trùng', () => {
    const keys = ACTION_TYPES.map((a) => a.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(ACTION_TYPES.every((a) => a.label.length > 0)).toBe(true);
  });
});

describe('phân trang theo con trỏ', () => {
  it('50 mục, 12 dòng một trang => 5 trang; "Hiện 1–12 / 50"', () => {
    expect(pageCount(50)).toBe(5);
    expect(pageCount(0)).toBe(1);
    expect(rangeText(1, 12, 50)).toBe('Hiện 1–12 / 50');
    expect(rangeText(5, 2, 50)).toBe('Hiện 49–50 / 50');
    expect(rangeText(1, 0, 0)).toBe('Không có mục nào');
  });

  it('cửa sổ số trang tối đa 5, bám trang hiện tại', () => {
    expect(pageWindow(1, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(pageWindow(1, 20)).toEqual([1, 2, 3, 4, 5]);
    expect(pageWindow(10, 20)).toEqual([8, 9, 10, 11, 12]);
    expect(pageWindow(20, 20)).toEqual([16, 17, 18, 19, 20]);
    expect(pageWindow(1, 2)).toEqual([1, 2]);
  });

  it('con trỏ trang k lấy bằng một lần gọi limit = 12 × (k − 1), cùng bộ lọc', () => {
    const q = cursorQueryFor(4, DEFAULT_FILTERS, NOW);
    expect(q.limit).toBe(36);
    expect(q.cursor).toBeUndefined();
    expect(q.action).toEqual(DEFAULT_ACTIONS);
  });
});

describe('một dòng nhật ký -> chữ hiển thị', () => {
  it('sửa bảng quyền: đối tượng "Vai Leader", trước / sau theo tên quyền', () => {
    const r = presentAudit(item({ action: 'matrix_update', target_type: 'role_matrix', before: { 'leader.approve.unlock_item': false }, after: { 'leader.approve.unlock_item': true } }), lk);
    expect(r.action).toBe('Sửa bảng quyền');
    expect(r.object).toEqual({ icon: 'matrix', text: 'Vai Leader' });
    expect(r.before).toBe('Mở khoá mặt hàng đang có người sửa: tắt');
    expect(r.after).toBe('Mở khoá mặt hàng đang có người sửa: bật');
  });

  it('đổi vai, bỏ app, thêm người dùng', () => {
    expect(presentAudit(item({ action: 'user_role', before: { role: 'manager' }, after: { role: 'staff' } }), lk)).toMatchObject({ before: 'Manager', after: 'Nhân viên', object: { icon: 'user', text: 'tranlan' } });
    const apps = presentAudit(item({ action: 'user_apps', before: { apps: ['quote', 'lot', 'check', 'teach'] }, after: { apps: ['quote', 'check', 'teach'] } }), lk);
    expect(apps).toMatchObject({ action: 'Bỏ app', before: 'App 01, 02, 03, 04', after: 'App 01, 03, 04' });
    expect(presentAudit(item({ action: 'user_apps', before: { apps: ['quote'] }, after: { apps: ['quote', 'lot'] } }), lk).action).toBe('Thêm app');
    expect(presentAudit(item({ action: 'user_create', after: { role: 'staff', apps: ['quote', 'check'] } }), lk)).toMatchObject({ before: '—', after: 'Nhân viên · App 01, 03' });
    expect(presentAudit(item({ action: 'user_create', after: { role: 'manager', apps: null } }), lk).after).toBe('Manager · Mọi app');
  });

  it('khoá tạm do sai mật khẩu: người làm là chính người đó', () => {
    const r = presentAudit(item({ action: 'login_locked', actor_user_id: 'u-le-ha', actor_name: 'Lê Hà', target_id: 'u-le-ha', after: { client: 'desktop', minutes: 15 } }), lk);
    expect(r).toMatchObject({ action: 'Khoá tạm (sai 10 lần)', before: 'Hoạt động', after: 'Khoá tạm 15 phút', object: { text: 'leha' } });
    expect(r.actor.name).toBe('Lê Hà');
  });

  it('thu hồi máy: trạng thái trước theo hạn offline', () => {
    const overdue = presentAudit(item({ action: 'device_revoke', target_type: 'device', target_id: 'dev-kho02', before: { name: 'PC-KHO-02', last_seen: t('2026-10-20 11:05') }, after: { revoked: true } }), lk);
    expect(overdue).toMatchObject({ before: 'Quá hạn offline', after: 'Đã thu hồi', object: { icon: 'device', text: 'PC-KHO-02' } });
    const fresh = presentAudit(item({ action: 'device_revoke', target_type: 'device', target_id: 'dev-kho02', before: { last_seen: NOW - 3600 } }), lk);
    expect(fresh.before).toBe('Đang dùng');
  });

  it('bên triển khai đổi số máy ngoài app: không có tài khoản, nhãn "Ngoài app"', () => {
    const r = presentAudit(item({ action: 'license_update', target_type: 'license', actor_user_id: null, actor_label: 'Bên triển khai', actor_name: null, before: { max_devices: 6, apps: ['quote'] }, after: { max_devices: 7, apps: ['quote'] } }), lk);
    expect(r).toMatchObject({ action: 'Đổi số máy tối đa', before: '6 máy', after: '7 máy', object: { icon: 'license', text: 'Bản quyền công ty' } });
    expect(r.actor).toEqual({ name: 'Bên triển khai', locked: false, deployer: false, outside: true });
  });

  it('công nhận thao tác chờ: ghi tên người và máy', () => {
    const r = presentAudit(item({ action: 'pending_accept', target_type: 'pending_op', target_id: 'dev-kho01.op1', before: { status: 'pending' }, after: { status: 'accepted', user_id: 'u-le-ha' } }), lk);
    expect(r).toMatchObject({ object: { text: 'leha · PC-KHO-01' }, before: 'Chờ admin xem', after: 'Đã công nhận' });
    expect(presentAudit(item({ action: 'pending_drop', target_id: 'dev-kho01.op1', after: { user_id: 'u-le-ha' } }), lk).after).toBe('Đã bỏ');
  });

  it('người làm đã khoá vẫn hiện tên, kèm cờ Đã khoá (BR-011); bên triển khai có cờ riêng', () => {
    const locked = presentAudit(item({ actor_locked: true, actor_name: 'Đỗ Thu Hà' }), lk);
    expect(locked.actor).toMatchObject({ name: 'Đỗ Thu Hà', locked: true, deployer: false });
    expect(presentAudit(item({ actor_deployer: true }), lk).actor.deployer).toBe(true);
  });

  it('mật khẩu không bao giờ hiện: chỉ ghi "(ẩn)"', () => {
    const r = presentAudit(item({ action: 'password_reset', after: { temp_pw_expires_at: 1 } }), lk);
    expect(r.after).toBe('Mật khẩu tạm (ẩn)');
    expect(JSON.stringify(r)).not.toMatch(/temp_pw/);
  });

  it('mã chưa biết vẫn hiện được (không mất dòng)', () => {
    expect(presentAudit(item({ action: 'future_action' }), lk).action).toBe('future_action');
  });
});
