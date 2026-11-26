// Phần thuần (không React) của giao diện đồng bộ Drive: câu trạng thái BR-007, nhãn phiên bản, quy tắc khôi phục,
// so hai bản khi xung đột. Mọi câu báo lấy từ contracts/errors.json (driveCopy), không viết lại ở đây.
import contract from '@contracts/errors.json';
import { errorText, fillCopy, parseErrorCode, parseErrorParams } from '../lib/errors';
import type { BootstrapProgress, DriveAlert, DriveStatus, ItemVersion, SyncStateName } from './drive-api';

const MESSAGES: Record<string, string> = contract.errors;

const VN_PARTS = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', hourCycle: 'h23', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/** "14:20 09/11/2026" theo giờ Việt Nam (chỗ {giờ} trong câu báo). */
export function vnClock(unixSec: number): string {
  const p = Object.fromEntries(VN_PARTS.formatToParts(unixSec * 1000).map((x) => [x.type, x.value]));
  return `${p.hour}:${p.minute} ${p.day}/${p.month}/${p.year}`;
}

/** Tham số giờ Go/Worker gửi (giây) -> {giờ}; tên người (`name`) -> {tên}. */
const TIME_PARAMS = ['at', 'lastSyncAt', 'lastBackupAt'];

/** Câu báo theo khoá contracts/errors.json. Khoá lạ => ném lỗi (bắt sai sớm trong test). */
export function driveCopy(key: string, params: Record<string, string | number> = {}): string {
  const text = MESSAGES[key];
  if (text === undefined) throw new Error(`errors.json thiếu khoá ${key}`);
  const p: Record<string, string | number> = { ...params };
  if (!('giờ' in p)) {
    const t = TIME_PARAMS.map((k) => Number(p[k])).find((v) => Number.isFinite(v) && v > 0);
    if (t) p['giờ'] = vnClock(t);
  }
  if (!('tên' in p) && typeof p.name === 'string') p['tên'] = p.name;
  return fillCopy(text, p);
}

/** Lỗi từ drive.Service / Worker -> câu tiếng Việt; câu có {giờ}/{tên} (E-013 lastBackupAt) điền theo giờ Việt Nam. */
export function driveErrorText(e: unknown): string {
  if (e === null || e === undefined) return '';
  const code = (e as { code?: string })?.code ?? parseErrorCode(String((e as Error)?.message ?? e));
  if (!MESSAGES[code] || !/\{giờ\}|\{tên\}/.test(MESSAGES[code])) return errorText(e);
  const params = (e as { params?: Record<string, string | number> }).params ?? (e instanceof Error ? parseErrorParams(e.message) : {});
  // Chưa từng sao lưu thành công: không có giờ, thay chỗ trống bằng gạch ngang.
  return driveCopy(code, params).replace(/\{giờ\}/g, '—');
}

export type SyncTone = 'ok' | 'busy' | 'offline' | 'error' | 'conflict';

export interface SyncView {
  state: SyncStateName;
  /** Chữ trên thanh trạng thái: đúng tên BR-007 / câu E-001. */
  text: string;
  tone: SyncTone;
  /** Câu lỗi kèm việc cần làm (Error Matrix) khi state = error; rỗng nếu không có. */
  detail: string;
}

const TONE: Record<SyncStateName, SyncTone> = {
  not_connected: 'offline',
  offline: 'offline',
  conflicts: 'conflict',
  error: 'error',
  syncing: 'busy',
  pending: 'busy',
  synced: 'ok',
};

/** Khoá câu theo trạng thái khi Go không gửi label (exe cũ, PWA). */
const LABEL: Record<SyncStateName, DriveStatus['label']> = {
  not_connected: 'drive_not_connected',
  offline: 'sync_offline',
  conflicts: 'sync_conflicts_open',
  error: 'sync_error',
  syncing: 'sync_running',
  pending: 'sync_pending',
  synced: 'sync_done',
};

/** Trạng thái Go (ưu tiên: chưa kết nối > mất mạng > xung đột > lỗi > đang đẩy/kéo > còn chờ > đã đồng bộ) -> chữ trên thanh. */
export function syncView(s: Pick<DriveStatus, 'state' | 'label' | 'params' | 'code'>): SyncView {
  const state: SyncStateName = s.state in TONE ? s.state : 'synced';
  const n = Math.max(0, Number(s.params?.n ?? 0) | 0);
  const label = s.label && MESSAGES[s.label] ? s.label : LABEL[state];
  const detail = state === 'error' && s.code && MESSAGES[s.code] ? driveCopy(s.code, { n }) : '';
  return { state, text: driveCopy(label, { n }), tone: TONE[state], detail };
}

/** Exe chưa có drive.Service: suy trạng thái từ SyncStatus của hàng đợi (vẫn đúng tên BR-007). */
export function statusFromQueue(q: { online: boolean; syncing: boolean; pending: number; failed: number; conflict: number; lastSyncAt: number; code?: string; pulling?: boolean; lastPullAt?: number; driveConnected?: boolean }): DriveStatus {
  const base = { pending: q.pending, conflicts: q.conflict, lastSyncAt: q.lastSyncAt, lastPullAt: q.lastPullAt ?? 0 };
  const st = (state: SyncStateName, n = 0, code = ''): DriveStatus => ({ ...base, state, label: LABEL[state], params: { n }, code });
  if (q.driveConnected === false) return st('not_connected');
  if (!q.online) return st('offline', q.pending);
  if (q.conflict > 0) return st('conflicts', q.conflict);
  if (q.failed > 0 || q.code) return st('error', q.failed, q.code ?? '');
  if (q.syncing || q.pulling) return st('syncing', q.pending);
  if (q.pending > 0) return st('pending', q.pending);
  return st('synced');
}

/** Nhãn nguồn gốc phiên bản (FR-013). "Khôi phục" chỉ dùng cho khôi phục phiên bản, trả lại mục đã gỡ là "Hoàn tác gỡ" (BR-007). */
export const ORIGIN_LABEL: Record<ItemVersion['origin'], string> = {
  edit: 'sửa',
  remote: 'sửa',
  restore: 'khôi phục',
  conflict_lost: 'bị bỏ khi xung đột',
  remove: 'gỡ',
  undo_remove: 'hoàn tác gỡ',
};

export const originLabel = (o: string) => ORIGIN_LABEL[o as ItemVersion['origin']] ?? o;

/** Bản mới nhất trước (FR-013). */
export const sortVersions = (v: ItemVersion[]) => [...v].sort((a, b) => b.rev - a.rev || b.at - a.at);

/** Bản hiện hành = bản có số lớn nhất, trừ bản bị bỏ khi xung đột. */
export function currentRev(v: ItemVersion[]): number {
  return Math.max(0, ...v.filter((x) => x.origin !== 'conflict_lost').map((x) => x.rev));
}

/** Lý do khôi phục: không rỗng, không chỉ khoảng trắng (BR-006). Trả mã câu báo hoặc null. */
export function restoreProblem(reason: string): 'restore_reason_required' | null {
  return reason.trim() ? null : 'restore_reason_required';
}

export interface RestoreAccess {
  allowed: boolean;
  /** Khoá câu giải thích khi bị tắt (E-012). */
  hint: 'restore_not_own' | null;
}

/** Bản của mình luôn khôi phục được; bản người khác cần quyền lot.restore (BR-006). Bản hiện hành không có nút. */
export function restoreAccess(v: Pick<ItemVersion, 'actorUserId'>, isCurrent: boolean, me: string | undefined, canRestoreOthers: boolean): RestoreAccess | null {
  if (isCurrent) return null;
  if (canRestoreOthers || (!!me && v.actorUserId === me)) return { allowed: true, hint: null };
  return { allowed: false, hint: 'restore_not_own' };
}

/** Bản mới hơn bản được chọn do người khác tạo => cảnh báo "Sẽ thay thế thay đổi của {tên} lúc {giờ}" ngay khi mở hộp (Go vẫn kiểm lại). */
export function replacedBy(versions: ItemVersion[], picked: ItemVersion, me: string | undefined): ItemVersion | null {
  return sortVersions(versions).find((v) => v.rev > picked.rev && v.origin !== 'conflict_lost' && v.actorUserId !== me) ?? null;
}

export const fieldText = (x: unknown) => (x === undefined || x === null ? '' : typeof x === 'object' ? JSON.stringify(x) : String(x));

/** Trải nội dung mục thành trường "card.ma_hs" -> giá trị (cùng dạng tên trường của hộp xung đột). */
export function flatten(x: unknown, prefix = '', out: Record<string, unknown> = {}): Record<string, unknown> {
  if (x && typeof x === 'object' && !Array.isArray(x)) {
    for (const [k, v] of Object.entries(x as Record<string, unknown>)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else if (prefix) out[prefix] = x;
  return out;
}

/** Trường đổi giữa bản trước và bản này ("sửa gì", FR-013). */
export function versionChanges(prev: unknown, cur: unknown): string[] {
  const a = flatten(prev);
  const b = flatten(cur);
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => fieldText(a[k]) !== fieldText(b[k]));
}

/** Trường khác nhau trong hộp xung đột. */
export const isChanged = (f: { mine: unknown; theirs: unknown }) => fieldText(f.mine) !== fieldText(f.theirs);

/** Mục đang có xung đột chưa chọn => không duyệt, không bàn giao (BR-012). */
export function conflictBlocks(kind: string, itemId: string, conflicts: { kind: string; itemId: string; status?: string }[]): boolean {
  return conflicts.some((c) => c.kind === kind && c.itemId === itemId && (c.status ?? 'open') === 'open');
}

/** Đóng hộp xung đột: chọn một bản thì mục rời danh sách; đóng mà chưa chọn thì vẫn "Chờ giải quyết xung đột". */
export function afterConflictDialog<T extends { id: string }>(open: T[], id: string, choice: 'mine' | 'theirs' | null): T[] {
  return choice === null ? open : open.filter((c) => c.id !== id);
}

/** Lưu trữ đám mây chỉ cho người có quyền admin.drive; Go và Worker cũng từ chối. */
export const canSeeStorage = (can: (perm: string) => boolean) => can('admin.drive');

/** Câu cho một cảnh báo Drive của admin (FR-017, FR-019, NFR-011, E-021). */
export function alertText(a: Pick<DriveAlert, 'kind' | 'detail' | 'deviceName'>): string {
  const d = (a.detail ?? {}) as Record<string, unknown>;
  switch (a.kind) {
    case 'drive_full':
    case 'drive_no_access':
      return driveCopy(a.kind);
    case 'license_unreachable':
      return `${a.deviceName ? `${a.deviceName}: ` : ''}${driveCopy('license_server_unreachable')}`;
    case 'drive_drop':
      return driveCopy('drive_drop_alert', { 'loại dữ liệu': fieldText(d.kind), x: Number(d.before) || 0, y: Number(d.after) || 0 });
    case 'device_stale': {
      const at = Number(d.lastSyncAt) || 0;
      return driveCopy('device_stale_alert', { tên: fieldText(d.name ?? a.deviceName), giờ: at ? vnClock(at) : '—' });
    }
    default:
      return String(a.kind);
  }
}

/** Câu máy mới (E-017): cần mạng, đã lấy x/y; mã lỗi Drive khác thì câu của mã đó. */
export function bootstrapText(p: Pick<BootstrapProgress, 'code' | 'done' | 'total'>): string {
  if (!p.code) return '';
  if (p.code === 'bootstrap_partial') return driveCopy('bootstrap_partial', { x: p.done, y: p.total });
  return MESSAGES[p.code] ? driveCopy(p.code) : '';
}

/** Màn lấy dữ liệu máy mới hiện khi đang lấy, hoặc dừng với mã lỗi trước khi xong (stage 3 = xong). */
export const bootstrapVisible = (p: BootstrapProgress | null | undefined) => !!p && p.stage > 0 && p.stage < 3 && (p.running || !!p.code);
