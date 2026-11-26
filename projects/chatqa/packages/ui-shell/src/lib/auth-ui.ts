// Logic thuần của các màn kích hoạt / đăng nhập / đổi mật khẩu: chọn câu báo lỗi, màu, nút, ô sai... Tách khỏi React để test không cần DOM.
// Câu chữ luôn lấy từ lib/errors.ts (contracts/errors.json); ở đây chỉ chọn câu nào hiện ở đâu.
import limits from '@contracts/limits.json';
import { PRODUCT } from '@product/product';
import { errorText, parseErrorCode } from './errors';
import permissions from '@contracts/permissions.json';
import type { AppItem, AppState } from '../platform/types';

export const PRODUCT_NAME: string = PRODUCT.name;
export const MIN_PASSWORD = limits.passwordMinLength;

/** Viên tên công ty trên thanh tiêu đề: chỉ sản phẩm bật PRODUCT.companyBadge mới hiện. */
export function companyBadge(name: string | undefined): string | undefined {
  return PRODUCT.companyBadge ? name : undefined;
}

/** Tên công ty: lấy từ bản quyền nếu Go gửi; chưa có thì dùng tên sản phẩm (xem báo cáo Phase 06: điểm mở). */
export function companyLabel(state: AppState | null): string {
  return state?.license?.company?.trim() || PRODUCT_NAME;
}

// ---------- Mã bản quyền ----------

const KEY_PREFIX = 'HSD';
const KEY_GROUP = 5;
const KEY_GROUPS = 4;

/**
 * Tự chèn dấu gạch khi gõ/dán mã bản quyền: HSD-XXXXX-XXXXX-XXXXX-XXXXX (dạng Worker cấp, worker/src/routes/sys.ts).
 * Chỉ giữ chữ và số, viết hoa; bỏ phần thừa.
 */
export function formatLicenseKey(raw: string): string {
  const chars = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const head = chars.slice(0, KEY_PREFIX.length);
  const rest = chars.slice(KEY_PREFIX.length, KEY_PREFIX.length + KEY_GROUP * KEY_GROUPS);
  const groups: string[] = [];
  for (let i = 0; i < rest.length; i += KEY_GROUP) groups.push(rest.slice(i, i + KEY_GROUP));
  // Chưa gõ hết "HSD" thì chưa chèn gạch; vừa đủ "HSD" thì chờ ký tự kế tiếp (không để gạch treo ở cuối khi xoá).
  return [head, ...groups].filter(Boolean).join('-');
}

// ---------- Thông báo trong thẻ ----------

export type NoticeTone = 'red' | 'amber';
export type NoticeIcon = 'circle-x' | 'monitor-x' | 'wifi-off' | 'server-off' | 'timer' | 'lock' | 'clock-alert';

export interface Notice {
  tone: NoticeTone;
  icon: NoticeIcon;
  text: string;
  /** Mã lỗi gốc (để test và để chọn nút). */
  code: string;
}

type Params = Record<string, string | number>;
const codeOf = (e: unknown) => (e as { code?: string })?.code ?? parseErrorCode(String((e as Error)?.message ?? e));
const paramsOf = (e: unknown): Params => ((e as { params?: Params })?.params ?? {}) as Params;

/** Mã lỗi nào là lỗi mạng/máy chủ (hổ phách, nút "Thử lại"): máy chủ không tới được, không phải người dùng làm sai. */
export const isNetworkCode = (code: string) => ['activation_needs_network', 'first_login_needs_network', 'server_unavailable', 'need_network', 'offline_attempts_exceeded', 'network'].includes(code);

// ----- Kích hoạt (Ko3Pm) -----

export interface ActivationView {
  notice: Notice | null;
  /** Viền đỏ ô mã (chỉ khi mã sai, E-014). */
  invalidKey: boolean;
  button: string;
}

export function activationView(err: unknown): ActivationView {
  if (err === null || err === undefined) return { notice: null, invalidKey: false, button: 'Kích hoạt' };
  const code = codeOf(err);
  const text = errorText(err);
  switch (code) {
    case 'license_not_found':
      return { notice: { tone: 'red', icon: 'circle-x', text, code }, invalidKey: true, button: 'Kích hoạt' };
    case 'device_limit_reached':
      return { notice: { tone: 'red', icon: 'monitor-x', text, code }, invalidKey: false, button: 'Kích hoạt' };
    case 'activation_needs_network':
      return { notice: { tone: 'amber', icon: 'wifi-off', text, code }, invalidKey: false, button: 'Thử lại' };
    case 'server_unavailable':
      return { notice: { tone: 'amber', icon: 'server-off', text, code }, invalidKey: false, button: 'Thử lại' };
    default:
      return { notice: { tone: 'red', icon: 'circle-x', text, code }, invalidKey: false, button: 'Kích hoạt' };
  }
}

// ----- Đăng nhập (npit1) -----

export interface LoginView {
  notice: Notice | null;
  /** Viền đỏ 2 ô (chỉ E-001). */
  invalidFields: boolean;
  /** Xoá ô mật khẩu sau lỗi (tên đăng nhập luôn được giữ). Lỗi mạng giữ mật khẩu để "Thử lại" gửi lại được. */
  clearPassword: boolean;
  button: { label: string; disabled: boolean };
}

/** Còn bao nhiêu giây khoá tạm: dùng cho chữ "Thử lại sau 14:52" và số phút ở câu E-002. */
export function mmss(totalSec: number): string {
  const s = Math.max(0, Math.ceil(totalSec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** Đổi lỗi đăng nhập thành giao diện. `lockLeftSec`: giây khoá tạm còn lại (đếm ngược mỗi giây từ params.minutes). */
export function loginView(err: unknown, lockLeftSec = 0): LoginView {
  const idle = { label: 'Đăng nhập', disabled: false };
  if (err === null || err === undefined) return { notice: null, invalidFields: false, clearPassword: false, button: idle };
  const code = codeOf(err);
  const own = paramsOf(err);
  switch (code) {
    case 'invalid_credentials':
    case 'tenant_mismatch': // báo như E-001 để không lộ tài khoản có ở công ty khác
      return { notice: { tone: 'red', icon: 'circle-x', text: errorText({ code: 'invalid_credentials' }), code: 'invalid_credentials' }, invalidFields: true, clearPassword: true, button: idle };
    case 'rate_limited': {
      // Số phút trong câu chạy theo đồng hồ: làm tròn lên, tối thiểu 1 phút khi còn khoá.
      const mm = lockLeftSec > 0 ? Math.max(1, Math.ceil(lockLeftSec / 60)) : Number(own.minutes ?? own.mm ?? 0);
      return {
        notice: { tone: 'red', icon: 'timer', text: errorText({ code }, { mm }), code },
        invalidFields: false,
        clearPassword: true,
        button: lockLeftSec > 0 ? { label: `Thử lại sau ${mmss(lockLeftSec)}`, disabled: true } : idle,
      };
    }
    case 'account_locked':
      return { notice: { tone: 'red', icon: 'lock', text: errorText(err), code }, invalidFields: false, clearPassword: true, button: idle };
    case 'first_login_needs_network':
    case 'server_unavailable':
      return { notice: { tone: 'amber', icon: 'wifi-off', text: errorText(err), code }, invalidFields: false, clearPassword: false, button: { label: 'Thử lại', disabled: false } };
    case 'offline_attempts_exceeded':
      return { notice: { tone: 'amber', icon: 'wifi-off', text: errorText(err), code }, invalidFields: false, clearPassword: true, button: { label: 'Chờ kết nối mạng', disabled: true } };
    case 'temp_password_expired':
      return { notice: { tone: 'amber', icon: 'clock-alert', text: errorText(err), code }, invalidFields: false, clearPassword: true, button: idle };
    default:
      return { notice: { tone: 'red', icon: 'circle-x', text: errorText(err), code }, invalidFields: false, clearPassword: true, button: idle };
  }
}

/** Giây khoá tạm ban đầu từ lỗi E-002 (Worker/Go gửi minutes); 0 nếu không phải E-002. */
export function lockSecondsOf(err: unknown): number {
  if (codeOf(err) !== 'rate_limited') return 0;
  const p = paramsOf(err);
  const m = Number(p.minutes ?? p.mm ?? 0);
  return Number.isFinite(m) && m > 0 ? Math.round(m * 60) : 0;
}

// ----- Đổi mật khẩu (g4aqy) -----

export type PasswordField = 'current' | 'new' | 'confirm';
export interface PasswordView {
  /** Lỗi hiện ngay dưới ô cần sửa. */
  field: { name: PasswordField; text: string; code: string } | null;
  /** Lỗi mạng / máy chủ hiện trên đầu hộp. */
  banner: Notice | null;
}

/** Kiểm tra phía máy trước khi gọi mạng (BR-008): đủ 8 ký tự; nhập lại khớp. Việc "khác mật khẩu tạm" do máy chủ kiểm (E-007). */
export function validateNewPassword(next: string, confirm: string): 'weak_password' | 'password_mismatch' | null {
  if (next.length < MIN_PASSWORD) return 'weak_password';
  if (next !== confirm) return 'password_mismatch';
  return null;
}

export function passwordView(err: unknown): PasswordView {
  if (err === null || err === undefined) return { field: null, banner: null };
  const code = codeOf(err);
  const text = errorText(err);
  switch (code) {
    case 'weak_password':
      return { field: { name: 'new', text, code }, banner: null };
    case 'password_mismatch':
      return { field: { name: 'confirm', text, code }, banner: null };
    case 'wrong_current_password':
      return { field: { name: 'current', text, code }, banner: null };
    case 'need_network':
    case 'server_unavailable':
    case 'network':
      return { field: null, banner: { tone: 'amber', icon: 'wifi-off', text, code } };
    default:
      return { field: null, banner: { tone: 'red', icon: 'circle-x', text, code } };
  }
}

// ----- Chờ công nhận (E-018) -----

export interface ReviewOpLike {
  kind: string;
  status: 'review' | 'rejected';
  at: number;
  actorUserId: string;
}

/** Câu E-018 cho một thao tác: không công nhận (rejected) hay chờ admin xem (review). */
export function reviewOpText(op: ReviewOpLike, who: string, label: string): string {
  const code = op.status === 'rejected' ? 'op_rejected' : 'op_pending';
  return errorText({ code }, { tên: label, người: who, at: op.at });
}

// ---------- Giữ màn đang làm khi phiên hết hạn (E-005) ----------

/**
 * Go trả user = null khi phiên hết hạn mà máy có mạng (sessionUser), kèm overlay "expired". Nếu để vậy thì màn đang làm bị gỡ
 * và hộp "đăng nhập lại" không còn gì để đè lên. Giữ người dùng cuối cùng đã thấy trong bộ nhớ cho tới khi đăng nhập lại.
 */
export function keepUserWhileExpired(state: AppState, last: AppState['user']): AppState {
  if (state.user || !last || state.auth?.overlay !== 'expired') return state;
  return { ...state, user: last };
}

// ---------- Menu app (FR-014) ----------


export type AppAction = { type: 'open' } | { type: 'blocked'; code: NonNullable<AppItem['errorCode']> };

/** Bấm một app: mở được, hay bị chặn bằng lỗi nào (E-012 chưa kích hoạt, E-013 chưa được cấp, E-017 bị tắt khỏi bản quyền). */
export function appAction(item: AppItem | undefined): AppAction {
  if (!item || item.state === 'activated') return { type: 'open' };
  const code = item.errorCode || (item.state === 'not_granted' ? 'app_forbidden' : item.state === 'license_disabled' ? 'app_disabled' : 'module_locked');
  return { type: 'blocked', code };
}

/** Câu hiện khi bấm app bị chặn: {tên} cho E-012/E-017, {app / màn này} cho E-013. */
export function appBlockedText(item: AppItem, code: string): string {
  return errorText({ code }, { tên: item.name, 'app / màn này': item.name });
}


const PERM_LABEL = new Map(permissions.permissions.map((p) => [p.code, p.label]));

/** Tên ngắn của thao tác cho câu E-018: mệnh đề đầu của nhãn quyền ("Lưu tiêu chí gộp"); không có quyền ghi kèm thì dùng mã thao tác. */
export function opLabel(op: { perm: string; kind: string }): string {
  const full = PERM_LABEL.get(op.perm) ?? '';
  return full.split(/[;,]/)[0].trim() || op.kind;
}

// ---------- Thẻ Google Drive ở sidebar ----------

/** "Đồng bộ 2 phút trước" từ mốc đồng bộ gần nhất (giây unix); chưa đồng bộ lần nào thì "Chưa đồng bộ". */
export function syncAgo(lastSyncAt: number | undefined, nowMs = Date.now()): string {
  if (!lastSyncAt || lastSyncAt <= 0) return 'Chưa đồng bộ';
  const sec = Math.max(0, Math.floor(nowMs / 1000 - lastSyncAt));
  if (sec < 60) return 'Đồng bộ vừa xong';
  const min = Math.floor(sec / 60);
  if (min < 60) return `Đồng bộ ${min} phút trước`;
  const h = Math.floor(min / 60);
  return h < 48 ? `Đồng bộ ${h} giờ trước` : `Đồng bộ ${Math.floor(h / 24)} ngày trước`;
}
