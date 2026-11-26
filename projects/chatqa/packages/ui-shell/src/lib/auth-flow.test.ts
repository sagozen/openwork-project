import { describe, expect, it } from 'vitest';
import { entryScreen, overlayOf, webHome } from './auth-flow';
import { NO_AUTH, type AppState } from '../platform/types';

const user = { id: 'u1', tenant: 't', name: 'Lan', role: 'staff' as const };
const lic = (status: string) => ({ status: status as never, apps: [], expiresAt: 0, refreshBy: 0, deviceName: 'PC' });
const st = (over: Partial<AppState>): AppState => ({ user: null, license: lic('valid'), version: { ui: '1', bin: '1', coreApi: 2, uiSource: 'embedded' }, ...over });

describe('entryScreen (máy Windows)', () => {
  it('đi lần lượt kích hoạt -> đăng nhập -> đổi mật khẩu bắt buộc -> màn chính', () => {
    expect(entryScreen(null, true)).toBe('loading');
    expect(entryScreen(st({ license: lic('none') }), true)).toBe('activate');
    expect(entryScreen(st({ license: lic('invalid') }), true)).toBe('activate');
    expect(entryScreen(st({}), true)).toBe('login');
    expect(entryScreen(st({ user, auth: { ...NO_AUTH, mustChangePassword: true } }), true)).toBe('mustChange');
    expect(entryScreen(st({ user }), true)).toBe('ready');
  });

  it('hết hạn offline (E-006) không đưa về màn kích hoạt: giữ dữ liệu, chỉ khoá bằng hộp thoại', () => {
    const s = st({ user, license: lic('offline_expired'), auth: { ...NO_AUTH, overlay: 'offline_locked', offlineDays: 8 } });
    expect(entryScreen(s, true)).toBe('ready');
    expect(overlayOf(s)).toBe('offline_locked');
  });

  it('máy bị thu hồi (E-016) vào màn khoá', () => {
    expect(entryScreen(st({ license: lic('none'), auth: { ...NO_AUTH, overlay: 'revoked' } }), true)).toBe('locked');
  });

  it('bị khoá khi đang dùng (E-019): về đăng nhập, hộp thoại báo giờ khoá', () => {
    const s = st({ auth: { ...NO_AUTH, overlay: 'locked_out', at: 1700000000 } });
    expect(entryScreen(s, true)).toBe('login');
    expect(overlayOf(s)).toBe('locked_out');
  });

  it('không có hộp thoại nào khi bình thường', () => {
    expect(overlayOf(st({ user }))).toBeNull();
    expect(overlayOf(null)).toBeNull();
  });
});

describe('entryScreen (web)', () => {
  it('không xét bản quyền máy', () => {
    expect(entryScreen(st({ license: null }), false)).toBe('login');
    expect(entryScreen(st({ license: null, user }), false)).toBe('ready');
    expect(entryScreen(st({ license: null, user, auth: { ...NO_AUTH, mustChangePassword: true } }), false)).toBe('mustChange');
  });
});

describe('webHome (BR-016)', () => {
  it('admin vào quản trị; vai có report.view vào Báo cáo; còn lại không có màn nào (E-013)', () => {
    expect(webHome('admin', [])).toBe('admin');
    expect(webHome('owner', undefined)).toBe('admin'); // phiên cũ
    expect(webHome('manager', ['report.view', 'work.do'])).toBe('report');
    expect(webHome('leader', ['report.view'])).toBe('report');
    expect(webHome('staff', ['work.do'])).toBe('none');
    expect(webHome('vipo', [])).toBe('none');
  });
});
