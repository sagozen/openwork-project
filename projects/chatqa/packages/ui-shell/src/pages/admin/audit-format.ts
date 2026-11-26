// Nhật ký quản trị: nhãn thao tác, đối tượng, giá trị trước / sau, bộ lọc và phân trang (FR-023, FR-024).
import limits from '@contracts/limits.json';
import { roleLabel } from '../../platform/roles';
import type { AdminDevice, AdminUser, AuditItem, AuditQuery } from './admin-api';
import { appsText, fmtShort, startOfDay } from './format';
import { permCopy } from './matrix-copy';

export const AUDIT_PAGE_SIZE = 12;

/** Loại thao tác trong ô lọc. Đăng nhập thành công / sai ghi rất nhiều dòng nên "Tất cả" bỏ hai loại này (chọn riêng được). */
export const ACTION_TYPES: { key: string; label: string }[] = [
  { key: 'user_create', label: 'Thêm người dùng' },
  { key: 'user_rename', label: 'Đổi tên hiển thị' },
  { key: 'user_role', label: 'Đổi vai' },
  { key: 'user_apps', label: 'Đổi app người dùng' },
  { key: 'user_lock', label: 'Khoá tài khoản' },
  { key: 'user_unlock', label: 'Mở khoá tài khoản' },
  { key: 'login_locked', label: 'Khoá tạm (sai nhiều lần)' },
  { key: 'password_reset', label: 'Đặt lại mật khẩu' },
  { key: 'password_change', label: 'Đổi mật khẩu' },
  { key: 'web_session_revoke', label: 'Đăng xuất phiên web từ xa' },
  { key: 'matrix_update', label: 'Sửa bảng quyền' },
  { key: 'matrix_reset', label: 'Bảng quyền về mặc định' },
  { key: 'device_revoke', label: 'Thu hồi máy' },
  { key: 'device_activate', label: 'Kích hoạt máy' },
  { key: 'device_reactivate', label: 'Kích hoạt lại máy' },
  { key: 'license_create', label: 'Cấp bản quyền' },
  { key: 'license_update', label: 'Đổi bản quyền' },
  { key: 'pending_accept', label: 'Công nhận thao tác chờ' },
  { key: 'pending_drop', label: 'Bỏ thao tác chờ' },
  { key: 'op_rejected', label: 'Thao tác không được công nhận' },
  { key: 'login_ok', label: 'Đăng nhập' },
  { key: 'login_fail', label: 'Đăng nhập sai' },
];

const NOISY = new Set(['login_ok', 'login_fail']);
export const DEFAULT_ACTIONS = ACTION_TYPES.map((a) => a.key).filter((k) => !NOISY.has(k));

export type DateRangeKey = 'month' | 'week' | 'days30' | 'all';
export const DATE_RANGES: { key: DateRangeKey; label: string }[] = [
  { key: 'month', label: 'Tháng này' },
  { key: 'week', label: '7 ngày qua' },
  { key: 'days30', label: '30 ngày qua' },
  { key: 'all', label: 'Tất cả' },
];

export interface AuditFilters {
  /** Id người (làm hoặc bị tác động); '' = tất cả. */
  user: string;
  /** Mã loại thao tác; '' = tất cả. */
  action: string;
  range: DateRangeKey;
}

export const DEFAULT_FILTERS: AuditFilters = { user: '', action: '', range: 'month' };

const DAY = 86400;

/** Khoảng [from, to) theo giờ Việt Nam. Tháng này = từ 00:00 ngày 1 tới hết hôm nay. */
export function rangeBounds(range: DateRangeKey, nowSec: number): { from?: number; to?: number } {
  const today = startOfDay(nowSec);
  if (range === 'all') return {};
  const to = today + DAY;
  if (range === 'week') return { from: today - 6 * DAY, to };
  if (range === 'days30') return { from: today - 29 * DAY, to };
  const dayOfMonth = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', day: 'numeric' }).format(nowSec * 1000));
  return { from: today - (dayOfMonth - 1) * DAY, to };
}

/** Nhãn khoảng ngày trên ô lọc: "01/11 – 11/11/2026". */
export function rangeLabel(range: DateRangeKey, nowSec: number): string {
  const { from, to } = rangeBounds(range, nowSec);
  if (from === undefined || to === undefined) return 'Tất cả';
  const a = fmtShort(from).slice(0, 5);
  const b = fmtShort(to - 1);
  const year = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric' }).format((to - 1) * 1000);
  return `${a} – ${b.slice(0, 5)}/${year}`;
}

/** Bộ lọc trên màn -> tham số GET /audit (12 dòng / trang; có thể kèm con trỏ). */
export function buildAuditQuery(f: AuditFilters, nowSec: number, cursor?: number, limit = AUDIT_PAGE_SIZE): AuditQuery {
  const { from, to } = rangeBounds(f.range, nowSec);
  return { user: f.user || undefined, action: f.action ? [f.action] : DEFAULT_ACTIONS, from, to, cursor, limit };
}

/** Số trang tối đa và các số trang hiện trên thanh phân trang (tối đa 5, quanh trang hiện tại). */
export const pageCount = (total: number, size = AUDIT_PAGE_SIZE) => Math.max(1, Math.ceil(total / size));
export function pageWindow(current: number, count: number, width = 5): number[] {
  const start = Math.max(1, Math.min(current - Math.floor(width / 2), count - width + 1));
  return Array.from({ length: Math.min(width, count) }, (_, i) => start + i);
}
/** Dòng "Hiện 1–12 / 50". */
export function rangeText(page: number, shown: number, total: number, size = AUDIT_PAGE_SIZE): string {
  if (!total) return 'Không có mục nào';
  const first = (page - 1) * size + 1;
  return `Hiện ${first}–${first + shown - 1} / ${total}`;
}

/** Con trỏ của trang k = id của dòng cuối trang k-1: lấy bằng một lần gọi limit = size × (k-1). */
export const cursorQueryFor = (page: number, f: AuditFilters, nowSec: number, size = AUDIT_PAGE_SIZE): AuditQuery => buildAuditQuery(f, nowSec, undefined, size * (page - 1));

// ---------- hiển thị một dòng ----------

export interface AuditLookups {
  users: Map<string, AdminUser>;
  devices: Map<string, AdminDevice>;
}

export const makeLookups = (users: AdminUser[], devices: AdminDevice[]): AuditLookups => ({ users: new Map(users.map((u) => [u.id, u])), devices: new Map(devices.map((d) => [d.id, d])) });

export type ObjectIcon = 'user' | 'device' | 'matrix' | 'license';

export interface AuditRow {
  id: number;
  time: string;
  actor: { name: string; locked: boolean; deployer: boolean; outside: boolean };
  action: string;
  object: { icon: ObjectIcon; text: string };
  before: string;
  after: string;
}

const NONE = '—';
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
const appList = (v: unknown): string[] | null => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null);
const appsOrAll = (v: unknown) => {
  const l = appList(v);
  return l ? appsText(l) : 'Mọi app';
};
const maxDevicesText = (n: unknown) => (n === undefined || n === null ? NONE : `${n} máy`);

function matrixText(changes: Record<string, unknown>): { object: string; text: string } {
  const entries = Object.entries(changes).map(([key, v]) => {
    const i = key.indexOf('.');
    return { role: key.slice(0, i), perm: key.slice(i + 1), v: v === true };
  });
  const roles = [...new Set(entries.map((e) => e.role))];
  const object = roles.length === 1 ? `Vai ${roleLabel(roles[0]) || roles[0]}` : 'Nhiều vai';
  const text = entries.map((e) => `${permCopy(e.perm).label}: ${e.v ? 'bật' : 'tắt'}`).join('; ');
  return { object, text };
}

function targetUser(it: AuditItem, lk: AuditLookups): string {
  return (it.target_id && lk.users.get(it.target_id)?.username) || it.target_name || it.target_id || NONE;
}

function targetDevice(it: AuditItem, lk: AuditLookups): string {
  const id = it.target_id ?? '';
  return lk.devices.get(id)?.name ?? it.target_name ?? str(rec(it.before).name) ?? id;
}

/** Trạng thái máy lúc thu hồi: quá hạn offline nếu lần kết nối cuối cách xa hơn hạn offline. */
export const deviceStateAt = (lastSeen: number, at: number) => (at - lastSeen > limits.offlineHours * 3600 ? 'Quá hạn offline' : 'Đang dùng');

/** Chuyển một dòng API thành chữ để vẽ. Không có dữ liệu thì dùng "—" (không bịa). */
export function presentAudit(it: AuditItem, lk: AuditLookups): AuditRow {
  const b = rec(it.before);
  const a = rec(it.after);
  let action = ACTION_TYPES.find((x) => x.key === it.action)?.label ?? it.action;
  let object: AuditRow['object'] = { icon: 'user', text: targetUser(it, lk) };
  let before = NONE;
  let after = NONE;

  switch (it.action) {
    case 'matrix_update':
    case 'matrix_reset': {
      const m = matrixText(b);
      object = { icon: 'matrix', text: m.object };
      before = m.text || NONE;
      after = matrixText(a).text || NONE;
      if (it.action === 'matrix_reset') action = 'Đưa bảng quyền về mặc định';
      break;
    }
    case 'user_create':
      after = `${roleLabel(str(a.role)) || str(a.role)} · ${appsOrAll(a.apps)}`;
      break;
    case 'user_rename':
      before = str(b.display_name) || NONE;
      after = str(a.display_name) || NONE;
      break;
    case 'user_role':
      before = roleLabel(str(b.role)) || NONE;
      after = roleLabel(str(a.role)) || NONE;
      break;
    case 'user_apps': {
      const from = appList(b.apps);
      const to = appList(a.apps);
      before = appsOrAll(b.apps);
      after = appsOrAll(a.apps);
      if (from && to) action = to.every((x) => from.includes(x)) ? 'Bỏ app' : from.every((x) => to.includes(x)) ? 'Thêm app' : 'Đổi app';
      break;
    }
    case 'user_lock':
      before = 'Hoạt động';
      after = 'Đã khoá';
      break;
    case 'user_unlock':
      before = 'Đã khoá';
      after = 'Hoạt động';
      break;
    case 'login_locked':
      action = `Khoá tạm (sai ${limits.lockoutMaxFailures} lần)`;
      before = 'Hoạt động';
      after = `Khoá tạm ${str(a.minutes) || limits.lockoutMinutes} phút`;
      break;
    case 'password_reset':
      after = 'Mật khẩu tạm (ẩn)';
      break;
    case 'password_change':
      after = 'Đã đổi (ẩn)';
      break;
    case 'web_session_revoke':
      before = 'Phiên web';
      after = 'Đã đăng xuất';
      break;
    case 'device_revoke': {
      object = { icon: 'device', text: targetDevice(it, lk) };
      const seen = Number(b.last_seen);
      before = Number.isFinite(seen) && seen > 0 ? deviceStateAt(seen, it.at) : NONE;
      after = 'Đã thu hồi';
      break;
    }
    case 'device_activate':
      object = { icon: 'device', text: targetDevice(it, lk) };
      after = 'Đang dùng';
      break;
    case 'device_reactivate':
      object = { icon: 'device', text: targetDevice(it, lk) };
      before = 'Đã thu hồi';
      after = 'Đang dùng';
      break;
    case 'license_create':
      object = { icon: 'license', text: 'Bản quyền công ty' };
      after = maxDevicesText(a.max_devices);
      break;
    case 'license_update': {
      object = { icon: 'license', text: 'Bản quyền công ty' };
      if (b.max_devices !== a.max_devices) {
        action = 'Đổi số máy tối đa';
        before = maxDevicesText(b.max_devices);
        after = maxDevicesText(a.max_devices);
      } else if (JSON.stringify(b.apps) !== JSON.stringify(a.apps)) {
        action = 'Đổi app bản quyền';
        before = appsOrAll(b.apps);
        after = appsOrAll(a.apps);
      } else if (b.status !== a.status) {
        action = 'Đổi trạng thái bản quyền';
        before = str(b.status) || NONE;
        after = str(a.status) || NONE;
      } else if (b.expires_at !== a.expires_at) {
        action = 'Đổi hạn bản quyền';
        before = b.expires_at ? fmtShort(Number(b.expires_at)) : NONE;
        after = a.expires_at ? fmtShort(Number(a.expires_at)) : NONE;
      }
      break;
    }
    case 'pending_accept':
    case 'pending_drop': {
      const deviceId = (it.target_id ?? '').split('.')[0];
      const user = lk.users.get(str(a.user_id))?.username ?? '';
      const device = lk.devices.get(deviceId)?.name ?? '';
      object = { icon: 'user', text: [user, device].filter(Boolean).join(' · ') || NONE };
      before = 'Chờ admin xem';
      after = it.action === 'pending_accept' ? 'Đã công nhận' : 'Đã bỏ';
      break;
    }
    case 'op_rejected':
      before = NONE;
      after = `Từ chối: ${permCopy(str(a.perm)).label}`;
      break;
    case 'login_ok':
      after = str(a.client) === 'web' ? 'Trên web' : 'Trên app Windows';
      break;
    case 'login_fail':
      after = 'Sai mật khẩu';
      break;
  }

  const outside = !it.actor_user_id;
  return {
    id: it.id,
    time: fmtShort(it.at),
    actor: { name: it.actor_name ?? it.actor_label, locked: it.actor_locked, deployer: it.actor_deployer, outside },
    action,
    object,
    before,
    after,
  };
}
