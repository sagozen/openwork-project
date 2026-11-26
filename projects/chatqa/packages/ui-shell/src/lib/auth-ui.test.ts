import { describe, expect, it } from 'vitest';
import contract from '@contracts/errors.json';
import { ApiError, NO_AUTH, type AppItem, type AppState } from '../platform/types';
import {
  activationView,
  appAction,
  appBlockedText,
  companyLabel,
  formatLicenseKey,
  keepUserWhileExpired,
  lockSecondsOf,
  loginView,
  mmss,
  opLabel,
  passwordView,
  reviewOpText,
  syncAgo,
  validateNewPassword,
} from './auth-ui';
import { errorText, parseErrorParams } from './errors';
import { entryScreen, overlayOf } from './auth-flow';

const err = (code: string, params: Record<string, string | number> = {}) => new ApiError(code, 0, params);
const spec = contract.errors as Record<string, string>;
const state = (over: Partial<AppState>): AppState => ({ user: null, license: null, version: { ui: '1', bin: '1', coreApi: 2, uiSource: 'embedded' }, ...over });

describe('mã lỗi dùng ở các màn auth đều có trong contracts/errors.json', () => {
  // Mọi mã mà view-model hoặc màn hình có thể chọn; thêm mã mới vào danh sách này khi thêm nhánh mới.
  const USED = [
    // kích hoạt E-014/015/021/022 và bản quyền hết hạn
    'license_not_found', 'device_limit_reached', 'activation_needs_network', 'server_unavailable', 'license_expired',
    // đăng nhập E-001..004, 025, 026 và tenant_mismatch hiện như E-001
    'invalid_credentials', 'rate_limited', 'account_locked', 'first_login_needs_network', 'temp_password_expired', 'offline_attempts_exceeded', 'tenant_mismatch',
    // đổi mật khẩu E-007/008/020/024
    'weak_password', 'password_mismatch', 'need_network', 'wrong_current_password',
    // hộp toàn cục E-005/006/016/017/018/019 và bấm app E-012/013
    'session_expired', 'offline_expired', 'device_revoked', 'app_disabled', 'op_rejected', 'op_pending', 'locked_in_use', 'module_locked', 'app_forbidden',
  ];
  it.each(USED)('%s có câu báo lỗi', (code) => {
    expect(spec[code], code).toBeTruthy();
  });
  it('mỗi mã E-account-access dùng ở đây được map trong errors.json', () => {
    const mapped = new Set(Object.values(contract.accountAccess));
    for (const code of ['invalid_credentials', 'rate_limited', 'account_locked', 'first_login_needs_network', 'session_expired', 'offline_expired', 'weak_password', 'password_mismatch', 'module_locked', 'app_forbidden', 'license_not_found', 'device_limit_reached', 'device_revoked', 'app_disabled', 'need_network', 'server_unavailable', 'activation_needs_network', 'wrong_current_password', 'temp_password_expired', 'offline_attempts_exceeded', 'locked_in_use'])
      expect(mapped.has(code), code).toBe(true);
  });
});

describe('formatLicenseKey', () => {
  it('chèn gạch theo dạng Worker cấp: HSD-XXXXX-XXXXX-XXXXX-XXXXX', () => {
    expect(formatLicenseKey('hsd7k2qantu9f4mabcde')).toBe('HSD-7K2QA-NTU9F-4MABC-DE');
    expect(formatLicenseKey('HSD-7K2QA-NTU9F-4MABC-DEFGH')).toBe('HSD-7K2QA-NTU9F-4MABC-DEFGH');
  });
  it('bỏ ký tự lạ, khoảng trắng và phần thừa; dán mã đã có gạch giữ nguyên', () => {
    expect(formatLicenseKey(' hsd 7k2q ')).toBe('HSD-7K2Q');
    expect(formatLicenseKey('HSD-AAAAA-BBBBB-CCCCC-DDDDD-EEEEE')).toBe('HSD-AAAAA-BBBBB-CCCCC-DDDDD');
    expect(formatLicenseKey('')).toBe('');
    expect(formatLicenseKey('HS')).toBe('HS');
  });
  it('xoá tới dấu gạch thì không để gạch treo', () => {
    expect(formatLicenseKey('HSD-')).toBe('HSD');
  });
});

describe('activationView (Ko3Pm)', () => {
  it('E-014: viền đỏ ô mã, nút Kích hoạt', () => {
    const v = activationView(err('license_not_found'));
    expect(v).toMatchObject({ invalidKey: true, button: 'Kích hoạt', notice: { tone: 'red', icon: 'circle-x', text: spec.license_not_found } });
  });
  it('E-015: điền {n} từ maxDevices, không viền đỏ', () => {
    const v = activationView(err('device_limit_reached', { maxDevices: 7 }));
    expect(v.notice?.text).toBe('Công ty đã dùng đủ 7 máy. Nhờ admin thu hồi máy không dùng, hoặc liên hệ bên triển khai.');
    expect(v).toMatchObject({ invalidKey: false, notice: { tone: 'red', icon: 'monitor-x' } });
  });
  it('E-022 và E-021: hổ phách, nút đổi thành Thử lại', () => {
    expect(activationView(err('activation_needs_network'))).toMatchObject({ button: 'Thử lại', notice: { tone: 'amber', icon: 'wifi-off' } });
    expect(activationView(err('server_unavailable'))).toMatchObject({ button: 'Thử lại', notice: { tone: 'amber', icon: 'server-off' } });
  });
  it('không lỗi thì không dải báo', () => {
    expect(activationView(null)).toEqual({ notice: null, invalidKey: false, button: 'Kích hoạt' });
  });
});

describe('loginView (npit1)', () => {
  it('E-001: viền đỏ cả hai ô, xoá mật khẩu', () => {
    expect(loginView(err('invalid_credentials'))).toMatchObject({ invalidFields: true, clearPassword: true, notice: { tone: 'red', text: spec.invalid_credentials } });
  });
  it('tenant_mismatch hiện y hệt E-001 để không lộ tài khoản có ở công ty khác', () => {
    expect(loginView(err('tenant_mismatch')).notice?.text).toBe(spec.invalid_credentials);
  });
  it('E-002: số phút chạy theo đồng hồ đếm ngược, nút khoá và hiện mm:ss', () => {
    const e = err('rate_limited', { minutes: 15 });
    expect(lockSecondsOf(e)).toBe(900);
    const first = loginView(e, 892);
    expect(first.notice?.text).toBe('Bạn đã nhập sai quá nhiều lần. Thử lại sau 15 phút hoặc nhờ admin đặt lại mật khẩu.');
    expect(first.button).toEqual({ label: 'Thử lại sau 14:52', disabled: true });
    expect(loginView(e, 61).notice?.text).toContain('sau 2 phút');
    expect(loginView(e, 60).notice?.text).toContain('sau 1 phút');
    expect(loginView(e, 1).notice?.text).toContain('sau 1 phút');
    expect(loginView(e, 0).button.disabled).toBe(false); // hết khoá thì mở nút
  });
  it('E-002 chỉ là E-002 khi Go/Worker gửi minutes (lockSecondsOf = 0 với lỗi khác)', () => {
    expect(lockSecondsOf(err('invalid_credentials'))).toBe(0);
    expect(lockSecondsOf(new Error('rate_limited: minutes=12'))).toBe(0); // Error thường: UI nhận ApiError từ platform
    expect(lockSecondsOf(err('rate_limited', { minutes: 12 }))).toBe(720);
  });
  it('E-003: khoá tài khoản, không viền đỏ', () => {
    expect(loginView(err('account_locked'))).toMatchObject({ invalidFields: false, notice: { tone: 'red', icon: 'lock' } });
  });
  it('vai không dùng sản phẩm này: câu đỏ điền tên vai và sản phẩm từ Worker (web) và từ Go (desktop)', () => {
    const want = 'Tài khoản Vipo không dùng ChatQASoftware. Đăng nhập bằng app dành cho tài khoản Vipo hoặc liên hệ admin.';
    const web = loginView(err('role_not_in_product', { role: 'Vipo', product: 'ChatQASoftware' }));
    expect(web).toMatchObject({ invalidFields: false, clearPassword: true, notice: { tone: 'red', icon: 'circle-x', code: 'role_not_in_product', text: want } });
    // Go chuyển thân lỗi Worker thành "code: k=v,k=v"; platform/desktop.ts tách thành ApiError kèm tham số
    const desktop = err('role_not_in_product', parseErrorParams('role_not_in_product: product=ChatQASoftware,role=Vipo'));
    expect(loginView(desktop).notice?.text).toBe(want);
  });
  it('E-004 và E-021: hổ phách, nút Thử lại, giữ mật khẩu để gửi lại', () => {
    for (const code of ['first_login_needs_network', 'server_unavailable']) {
      expect(loginView(err(code))).toMatchObject({ clearPassword: false, button: { label: 'Thử lại', disabled: false }, notice: { tone: 'amber', icon: 'wifi-off' } });
    }
  });
  it('E-025: hổ phách, nút Đăng nhập; E-026: nút "Chờ kết nối mạng" bị khoá', () => {
    expect(loginView(err('temp_password_expired'))).toMatchObject({ button: { label: 'Đăng nhập', disabled: false }, notice: { tone: 'amber', icon: 'clock-alert', text: spec.temp_password_expired } });
    expect(loginView(err('offline_attempts_exceeded'))).toMatchObject({ button: { label: 'Chờ kết nối mạng', disabled: true }, notice: { tone: 'amber' } });
  });
  it('mm:ss', () => {
    expect(mmss(892)).toBe('14:52');
    expect(mmss(59.2)).toBe('01:00');
    expect(mmss(-3)).toBe('00:00');
  });
});

describe('đổi mật khẩu (g4aqy)', () => {
  it('kiểm tra phía máy: ngắn hơn 8 ký tự là E-007, nhập lại lệch là E-008, đủ thì qua', () => {
    expect(validateNewPassword('abc', 'abc')).toBe('weak_password');
    expect(validateNewPassword('abcdefgh', 'abcdefgx')).toBe('password_mismatch');
    expect(validateNewPassword('abcdefgh', 'abcdefgh')).toBeNull();
  });
  it('lỗi hiện dưới đúng ô: E-007 ô mới, E-008 ô nhập lại, E-024 ô hiện tại', () => {
    expect(passwordView(err('weak_password')).field).toMatchObject({ name: 'new', text: spec.weak_password });
    expect(passwordView(err('password_mismatch')).field?.name).toBe('confirm');
    expect(passwordView(err('wrong_current_password')).field?.name).toBe('current');
  });
  it('E-020 và E-021 hiện thành dải hổ phách trên đầu, không gắn vào ô nào', () => {
    expect(passwordView(err('need_network'))).toEqual({ field: null, banner: { tone: 'amber', icon: 'wifi-off', text: spec.need_network, code: 'need_network' } });
    expect(passwordView(err('server_unavailable')).banner?.tone).toBe('amber');
  });
});

describe('E-018 thao tác chờ công nhận', () => {
  const at = Date.parse('2026-11-11T09:27:00+07:00') / 1000;
  it('không được công nhận và đang chờ admin dùng hai câu khác nhau', () => {
    const base = { kind: 'k', at, actorUserId: 'u1' };
    expect(reviewOpText({ ...base, status: 'rejected' }, 'Trần Lan', 'Mở lại lô đã xuất')).toBe('Thao tác Mở lại lô đã xuất của Trần Lan lúc 11/11 09:27 không được công nhận vì không đủ quyền.');
    expect(reviewOpText({ ...base, status: 'review' }, 'Lê Hà', 'Gộp 12 dòng vào lô')).toContain('đang chờ admin xem vì tài khoản bị đổi quyền khi máy mất mạng.');
  });
  it('tên thao tác lấy mệnh đề đầu của nhãn quyền; không có quyền thì dùng mã thao tác', () => {
    expect(opLabel({ perm: 'lot.criteria', kind: 'x' })).toBe('Lưu tiêu chí gộp');
    expect(opLabel({ perm: '', kind: 'sheet.write_card' })).toBe('sheet.write_card');
  });
});

describe('menu app (FR-014)', () => {
  const item = (state: AppItem['state'], errorCode: AppItem['errorCode'], name = 'Sổ dạy AI'): AppItem => ({ code: 'teach', name, state, errorCode });
  it('app dùng được thì mở', () => {
    expect(appAction(item('activated', ''))).toEqual({ type: 'open' });
    expect(appAction(undefined)).toEqual({ type: 'open' });
  });
  it('ổ khoá: E-013 với tên app; mờ: E-012; bị tắt: E-017', () => {
    const lock = item('not_granted', 'app_forbidden');
    expect(appAction(lock)).toEqual({ type: 'blocked', code: 'app_forbidden' });
    expect(appBlockedText(lock, 'app_forbidden')).toBe('Bạn chưa được cấp quyền dùng Sổ dạy AI. Liên hệ admin.');
    const dim = item('not_activated', 'module_locked', 'Tích hợp');
    expect(appBlockedText(dim, 'module_locked')).toBe('App Tích hợp chưa được kích hoạt cho công ty. Liên hệ bên triển khai.');
    expect(appAction(item('license_disabled', 'app_disabled'))).toEqual({ type: 'blocked', code: 'app_disabled' });
  });
  it('thiếu errorCode vẫn chọn đúng lỗi theo trạng thái', () => {
    expect(appAction(item('not_granted', ''))).toEqual({ type: 'blocked', code: 'app_forbidden' });
    expect(appAction(item('not_activated', ''))).toEqual({ type: 'blocked', code: 'module_locked' });
  });
});

describe('E-006 và E-019 điền {n} / {dd/mm hh:mm}', () => {
  it('số ngày lấy từ auth.offlineDays', () => {
    expect(errorText({ code: 'offline_expired' }, { n: 8 })).toBe('Máy đã 8 ngày chưa kết nối. Kết nối mạng để tiếp tục làm việc. Dữ liệu trên máy vẫn được giữ.');
  });
  it('giờ khoá theo giờ Việt Nam', () => {
    const at = Date.parse('2026-11-11T14:05:00+07:00') / 1000;
    expect(errorText({ code: 'locked_in_use' }, { lockedAt: at })).toBe('Tài khoản của bạn đã bị khoá lúc 11/11 14:05. Liên hệ admin.');
  });
});

describe('giữ màn đang làm khi phiên hết hạn (E-005)', () => {
  const user = { id: 'u1', tenant: 't', name: 'Lan', role: 'staff' as const };
  it('Go trả user=null kèm overlay expired: giữ người dùng cuối để màn đang làm không bị gỡ', () => {
    const s = state({ auth: { ...NO_AUTH, overlay: 'expired' } });
    expect(keepUserWhileExpired(s, user).user).toEqual(user);
  });
  it('overlay khác, hoặc chưa từng có người dùng: không bịa người dùng', () => {
    expect(keepUserWhileExpired(state({ auth: { ...NO_AUTH, overlay: 'locked_out' } }), user).user).toBeNull();
    expect(keepUserWhileExpired(state({ auth: { ...NO_AUTH, overlay: 'expired' } }), null).user).toBeNull();
    expect(keepUserWhileExpired(state({ user, auth: { ...NO_AUTH, overlay: 'expired' } }), { ...user, name: 'cũ' }).user?.name).toBe('Lan');
  });
});

describe('companyLabel', () => {
  it('dùng tên công ty từ bản quyền, thiếu thì tên sản phẩm', () => {
    const lic = { status: 'valid' as const, apps: [], expiresAt: 0, refreshBy: 0, deviceName: 'PC' };
    expect(companyLabel(state({ license: { ...lic, company: 'Công ty Anh Tùng' } }))).toBe('Công ty Anh Tùng');
    expect(companyLabel(state({ license: lic }))).toBe('HS Desk');
    expect(companyLabel(null)).toBe('HS Desk');
  });
});

describe('máy trạng thái vào app (Gate)', () => {
  const lic = { status: 'valid' as const, apps: [], expiresAt: 0, refreshBy: 0, deviceName: 'PC' };
  const user = { id: 'u1', tenant: 't', name: 'Lan', role: 'staff' as const };
  const flow = (over: Partial<AppState>, last: AppState['user'] = null) => entryScreen(keepUserWhileExpired(state({ license: lic, ...over }), last), true);

  it('đi đủ chuỗi kích hoạt -> đăng nhập -> đổi mật khẩu bắt buộc -> màn chính', () => {
    expect(flow({ license: { ...lic, status: 'none' } })).toBe('activate');
    expect(flow({})).toBe('login');
    expect(flow({ user, auth: { ...NO_AUTH, mustChangePassword: true } })).toBe('mustChange');
    expect(flow({ user })).toBe('ready');
  });
  it('phiên hết hạn (Go trả user=null) vẫn ở màn chính để hộp đăng nhập lại đè lên, không đổi route', () => {
    const expired = { auth: { ...NO_AUTH, overlay: 'expired' as const } };
    expect(flow(expired, user)).toBe('ready');
    expect(flow(expired, null)).toBe('login'); // chưa từng thấy người dùng nào (mở app sau khi hết hạn)
    expect(overlayOf(state(expired))).toBe('expired');
  });
  it('bị khoá khi đang dùng: về đăng nhập (Go đã đăng xuất), hộp báo giờ khoá đè lên', () => {
    const s = state({ license: lic, auth: { ...NO_AUTH, overlay: 'locked_out', at: 1 } });
    expect(entryScreen(keepUserWhileExpired(s, user), true)).toBe('login');
    expect(overlayOf(s)).toBe('locked_out');
  });
  it('quá hạn offline và máy bị thu hồi', () => {
    expect(flow({ user, auth: { ...NO_AUTH, overlay: 'offline_locked', offlineDays: 8 } })).toBe('ready'); // khoá bằng lớp phủ, dữ liệu còn nguyên
    expect(flow({ license: { ...lic, status: 'none' }, auth: { ...NO_AUTH, overlay: 'revoked' } })).toBe('locked');
  });
});

describe('mã lỗi trong mã nguồn các màn auth đều có trong errors.json', () => {
  // Quét chuỗi `code: 'x'`, `case 'x':` và `{ code: 'x' }` trong các file của Phase 06: thêm nhánh mới mà quên khai báo thì fail ở đây.
  const sources = {
    ...import.meta.glob('../pages/auth/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }),
    ...import.meta.glob('../components/overlays/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }),
    ...import.meta.glob('../components/shell/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }),
    './auth-ui.ts': import.meta.glob('./auth-ui.ts', { query: '?raw', import: 'default', eager: true })['./auth-ui.ts'],
  } as Record<string, string>;
  it('mọi mã tìm thấy là khoá của errors.json', () => {
    const known = new Set(Object.keys(spec));
    const bad: string[] = [];
    expect(Object.keys(sources).length).toBeGreaterThan(10);
    for (const [f, text] of Object.entries(sources)) {
      for (const m of text.matchAll(/(?:code:\s*|case\s+|errorText\(\{\s*code:\s*)'([a-z][a-z0-9_]+)'/g)) {
        // Chỉ xét chuỗi dạng mã lỗi (có dấu gạch dưới hoặc nằm trong errorText/code:) và bỏ qua các enum giao diện đã biết.
        const id = m[1];
        if (['activated', 'not_activated', 'not_granted', 'license_disabled', 'offline_locked', 'locked_out', 'expired', 'revoked', 'rejected', 'review', 'current', 'new', 'confirm', 'open', 'blocked', 'circle', 'red', 'amber', 'ok', 'offline', 'account', 'apps', 'password', 'logout', 'form', 'compact', 'success'].includes(id)) continue;
        if (!known.has(id)) bad.push(`${f}: ${id}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe('syncAgo', () => {
  const now = Date.parse('2026-11-11T10:42:00+07:00');
  const at = (minAgo: number) => now / 1000 - minAgo * 60;
  it('hiện số phút, giờ, ngày kể từ lần đồng bộ cuối', () => {
    expect(syncAgo(0, now)).toBe('Chưa đồng bộ');
    expect(syncAgo(at(0.2), now)).toBe('Đồng bộ vừa xong');
    expect(syncAgo(at(2), now)).toBe('Đồng bộ 2 phút trước');
    expect(syncAgo(at(125), now)).toBe('Đồng bộ 2 giờ trước');
    expect(syncAgo(at(60 * 24 * 3), now)).toBe('Đồng bộ 3 ngày trước');
  });
});
