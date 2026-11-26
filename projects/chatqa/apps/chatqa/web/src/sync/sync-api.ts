// Đồng bộ nhóm qua S3/MinIO: kiểu JSON khớp apps/chatqa/desktop/internal/{modules/test/service_sync.go, teamsync}, các hàm
// gọi window.go.test.Service.Sync* (testApi trong testing/bridge.ts trải lại các hàm này) và phần thuần của trang Đồng bộ
// (nhãn trạng thái, gom tệp theo app, tóm tắt kết quả, câu lỗi). Không hàm nào đọc lại khoá S3.
import { errorText, knownErrorCodes } from '@shell/lib/errors';
import { goCall } from '../live/bridge';

/** Cấu hình đồng bộ (SyncConfig): prefix, credentialsSet, configured chỉ đọc; không bao giờ chứa khoá. */
export interface SyncConfig {
  /** host[:port], không scheme. */
  endpoint: string;
  bucket: string;
  region: string;
  pathStyle: boolean;
  useTLS: boolean;
  evidenceAuto: boolean;
  /** tenants/<mã tổ chức>/chatqa khi đã đăng nhập, "" khi chưa. */
  prefix: string;
  credentialsSet: boolean;
  /** Đủ endpoint, bucket và khoá. */
  configured: boolean;
}

/** Kết quả "Thử kết nối": conditional = false ⇒ kho không ghi có điều kiện được. */
export interface SyncProbe {
  ok: boolean;
  conditional: boolean;
  error?: string;
}

export type SyncState =
  | 'synced'
  | 'local_changed'
  | 'remote_changed'
  | 'both_changed'
  | 'local_new'
  | 'remote_new'
  | 'local_deleted'
  | 'remote_deleted'
  | 'conflict';

export type SyncKind = 'doc' | 'note' | 'flow' | 'manifest' | 'asset';
/** Lý do kèm trạng thái: bản của họ không qua kiểm tra (xung đột), hoặc remote_empty (kho không còn tệp nào của app nên
 * Kéo về không xoá ở máy; cũng là lý do bỏ qua trong kết quả kéo). */
export type SyncReason = 'invalid_flow' | 'invalid_doc' | 'invalid_note' | 'invalid_manifest' | 'remote_empty';

export interface FileStatus {
  /** Khoá tương đối apps/<app>/... */
  key: string;
  app: string;
  kind: SyncKind;
  state: SyncState;
  reason?: SyncReason;
  /** Tác giả bản của họ khi xung đột. */
  author?: string;
}

export interface SyncWarning {
  key: string;
  message: string;
}

export interface ConflictInfo {
  key: string;
  app: string;
  kind: SyncKind;
  author: string;
  device: string;
  reason?: SyncReason;
  theirsDeleted: boolean;
}

export interface SyncStatusResult {
  files: FileStatus[];
  warnings: SyncWarning[];
  lastPush?: string;
  lastPull?: string;
  counts: Partial<Record<SyncState, number>>;
  conflicts: ConflictInfo[];
}

/** Tệp không xử lý ở lần này; reason là trạng thái của tệp. */
export interface SyncSkip {
  key: string;
  reason: string;
}

export interface SyncFileError {
  key: string;
  error: string;
}

export interface PushResult {
  pushed: string[];
  conflicts: string[];
  skipped: SyncSkip[];
  errors: SyncFileError[];
  warnings: SyncWarning[];
}

export interface PullResult {
  pulled: string[];
  deleted: string[];
  /** Tệp gộp tự động: cần Đẩy lên để chia sẻ bản gộp. */
  merged: string[];
  conflicts: string[];
  skipped: SyncSkip[];
  errors: SyncFileError[];
  warnings: SyncWarning[];
}

/** Dữ liệu màn gộp 3 cột; merged điền sẵn (còn dấu <<<<<<< khi conflicts > 0). Ảnh (binary) không có nội dung. */
export interface ConflictView {
  key: string;
  app: string;
  kind: SyncKind;
  base: string;
  mine: string;
  theirs: string;
  merged: string;
  conflicts: number;
  mineDeleted: boolean;
  theirsDeleted: boolean;
  binary: boolean;
  theirAuthor: string;
  theirDevice: string;
  reason?: SyncReason;
  detail?: string;
  /** sha256 bản của họ đang hiện ("" khi họ đã xoá): gửi lại khi chọn; bản của họ đổi từ lúc mở ⇒ lỗi sync_conflict_changed. */
  theirsSha256: string;
}

export interface PushRunResult {
  runId: string;
  deviceId: string;
  files: number;
  uploaded: number;
  /** Đã có trên kho từ lần đẩy trước. */
  skipped: number;
  sizeBytes: number;
  /** Gói lớn hơn limitBytes: chưa tải gì, hỏi người dùng rồi gọi lại với confirm = true. */
  confirmRequired?: boolean;
  limitBytes?: number;
}

export interface TeamRun {
  runId: string;
  deviceId: string;
  author: string;
  app: string;
  label?: string;
  flows: number;
  passed: number;
  failed: number;
  startedAt: string;
  finishedAt: string;
  sizeBytes: number;
  sharedAt: string;
  /** Lượt do máy này đẩy. */
  mine: boolean;
}

/** Payload sự kiện Wails "test:sync". */
export interface SyncProgress {
  op: 'push' | 'pull' | 'share';
  phase: 'start' | 'done' | 'error' | 'confirm';
  apps?: string[];
  runId?: string;
  auto?: boolean;
  sizeBytes?: number;
  code?: string;
  error?: string;
}

export const SYNC_EVENT = 'test:sync';

const call = <T>(fn: string, ...args: unknown[]) => goCall<T>(`test.Service.${fn}`, ...args);
const arr = <T>(v: T[] | null | undefined): T[] => v ?? [];

/** Go trả mảng null khi rỗng: chuẩn hoá để UI không phải kiểm. */
const normStatus = (r: SyncStatusResult | null): SyncStatusResult => ({
  files: arr(r?.files),
  warnings: arr(r?.warnings),
  ...(r?.lastPush ? { lastPush: r.lastPush } : {}),
  ...(r?.lastPull ? { lastPull: r.lastPull } : {}),
  counts: r?.counts ?? {},
  conflicts: arr(r?.conflicts),
});
const normPush = (r: PushResult | null): PushResult => ({
  pushed: arr(r?.pushed),
  conflicts: arr(r?.conflicts),
  skipped: arr(r?.skipped),
  errors: arr(r?.errors),
  warnings: arr(r?.warnings),
});
const normPull = (r: PullResult | null): PullResult => ({
  pulled: arr(r?.pulled),
  deleted: arr(r?.deleted),
  merged: arr(r?.merged),
  conflicts: arr(r?.conflicts),
  skipped: arr(r?.skipped),
  errors: arr(r?.errors),
  warnings: arr(r?.warnings),
});

/** Cấu hình mặc định (Go: useTLS mặc định true) khi chưa đọc được. */
export const EMPTY_SYNC_CONFIG: SyncConfig = {
  endpoint: '',
  bucket: '',
  region: '',
  pathStyle: false,
  useTLS: true,
  evidenceAuto: false,
  prefix: '',
  credentialsSet: false,
  configured: false,
};

/** Hàm Go của đồng bộ nhóm; testApi (testing/bridge.ts) trải lại để gọi chung một chỗ. */
export const syncApi = {
  /** Cấu hình đồng bộ (không có khoá). */
  syncConfig: () => call<SyncConfig | null>('SyncConfig').then((c) => ({ ...EMPTY_SYNC_CONFIG, ...c })),
  /** Lưu endpoint, bucket, region, path-style, TLS, tự chia sẻ evidence (cần cqs.credentials); prefix và cờ chỉ đọc bị bỏ qua. */
  setSyncConfig: (cfg: SyncConfig) => call<SyncConfig | null>('SetSyncConfig', cfg).then((c) => ({ ...EMPTY_SYNC_CONFIG, ...c })),
  /** Ghi hai khoá S3 vào kho bí mật của máy (chỉ ghi, không đọc lại được). */
  setSyncCredentials: (access: string, secret: string) => call<void>('SetSyncCredentials', access, secret),
  clearSyncCredentials: () => call<void>('ClearSyncCredentials'),
  testSyncConnection: () => call<SyncProbe>('TestSyncConnection'),
  /** Trạng thái từng tệp; apps rỗng = mọi app. */
  syncStatus: (apps: string[] = []) => call<SyncStatusResult | null>('SyncStatus', apps).then(normStatus),
  /** Đẩy lên; đang có lần đẩy/kéo khác (kể cả qua MCP) thì lỗi busy. */
  syncPush: (apps: string[] = []) => call<PushResult | null>('SyncPush', apps).then(normPush),
  syncPull: (apps: string[] = []) => call<PullResult | null>('SyncPull', apps).then(normPull),
  syncConflict: (key: string) => call<ConflictView>('SyncConflict', key),
  /** theirsSha256 = ConflictView.theirsSha256 lúc mở màn gộp (cả ba lựa chọn). */
  syncResolve: (key: string, merged: string, theirsSha256: string) => call<void>('SyncResolve', key, merged, theirsSha256),
  syncKeepMine: (key: string, theirsSha256: string) => call<void>('SyncKeepMine', key, theirsSha256),
  syncTakeTheirs: (key: string, theirsSha256: string) => call<void>('SyncTakeTheirs', key, theirsSha256),
  /** Chia sẻ evidence của lượt; gói > 200 MB chưa confirm thì trả confirmRequired (không lỗi). */
  shareRun: (runId: string, confirm = false) => call<PushRunResult>('ShareRun', runId, confirm),
  /** Lượt nhóm đã chia sẻ trong days ngày (0 = 30), mới nhất trước. */
  teamRuns: (days = 0) => call<TeamRun[] | null>('TeamRuns', days).then(arr),
  /** Tải (lần đầu) rồi mở evidence.html của lượt nhóm; trả đường dẫn đã mở. */
  openTeamRun: (deviceId: string, runId: string) => call<string>('OpenTeamRun', deviceId, runId),
};

export const STATE_LABEL: Record<SyncState, string> = {
  synced: 'Đã đồng bộ',
  local_changed: 'Đã sửa ở máy',
  remote_changed: 'Nhóm đã sửa',
  both_changed: 'Hai bên cùng sửa',
  local_new: 'Mới ở máy',
  remote_new: 'Mới trên kho',
  local_deleted: 'Đã xoá ở máy',
  remote_deleted: 'Nhóm đã xoá',
  conflict: 'Xung đột',
};

/** Màu nhãn trạng thái: cần đẩy (xanh dương), cần kéo (xanh lá), cần xem (hổ phách), xung đột (đỏ). */
export const STATE_TONE: Record<SyncState, string> = {
  synced: 'bg-chip-neutral text-text-2',
  local_changed: 'bg-accent-soft text-accent-ink',
  local_new: 'bg-accent-soft text-accent-ink',
  local_deleted: 'bg-accent-soft text-accent-ink',
  remote_changed: 'bg-green-soft text-green',
  remote_new: 'bg-green-soft text-green',
  remote_deleted: 'bg-green-soft text-green',
  both_changed: 'bg-amber-soft text-amber',
  conflict: 'bg-red-soft text-red',
};

export const KIND_LABEL: Record<SyncKind, string> = { doc: 'Tài liệu', note: 'Ghi chú', flow: 'Flow', manifest: 'Danh mục', asset: 'Ảnh' };

export const REASON_LABEL: Record<SyncReason, string> = {
  invalid_flow: 'Flow của họ không qua kiểm tra an toàn',
  invalid_doc: 'Tài liệu của họ không đọc được',
  invalid_note: 'Ghi chú của họ không hợp lệ',
  invalid_manifest: 'Danh mục ca/flow của họ không hợp lệ',
  remote_empty: 'Kho nhóm không còn tệp nào của app này: không xoá ở máy',
};

/** Nhãn của trạng thái hoặc lý do bỏ qua (Go dùng tên trạng thái làm lý do, hoặc remote_empty); không biết thì giữ nguyên. */
export const stateLabel = (s: string) => STATE_LABEL[s as SyncState] ?? REASON_LABEL[s as SyncReason] ?? s;
export const reasonLabel = (s?: string) => (s ? (REASON_LABEL[s as SyncReason] ?? s) : '');

/** Ảnh màn hình/video lên kho nhóm: cả nhóm xem được, chữ bí mật trên màn hình không che được. */
export const TEAM_SHOT_NOTE =
  'Ảnh màn hình và video được đẩy lên kho nhóm: mọi người trong nhóm xem được, kể cả chữ bí mật hiện trên màn hình (không che được). Trace Playwright không bao giờ được đẩy.';

/** Kho không ghi có điều kiện được: hai lần đẩy cùng lúc có thể ghi đè nhau. */
export const NO_CONDITIONAL_NOTE =
  'Kho này không hỗ trợ ghi có điều kiện: hai người bấm Đẩy lên cùng lúc có thể ghi đè bản của nhau. Nên dùng MinIO hoặc S3 bản mới, hoặc hẹn nhau không đẩy cùng lúc.';

/** Còn dấu xung đột chưa gộp (như Go): dòng bắt đầu bằng <<<<<<< hoặc >>>>>>>, hoặc dòng chỉ có =======. */
export const hasConflictMarkers = (text: string) => /^(?:<<<<<<<|>>>>>>>|=======\r?$)/m.test(text);

/** Mã lỗi khi bản của họ đổi (một lần Kéo về làm mới) sau khi mở màn gộp: tải lại xung đột rồi chọn lại. */
export const CONFLICT_CHANGED = 'sync_conflict_changed';

/** Khoá apps/<app>/<đường dẫn> thành đường dẫn trong app. */
export const fileOfKey = (key: string, app: string) => (key.startsWith(`apps/${app}/`) ? key.slice(`apps/${app}/`.length) : key);

/** Dung lượng dễ đọc: KB dưới 1 MB, còn lại MB một chữ số lẻ. */
export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 KB';
  if (n < 1 << 20) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1 << 20)).toFixed(1).replace('.', ',')} MB`;
}

/** Ngày giờ ngắn kiểu Việt Nam ("" khi không có). */
export const fmtWhen = (iso?: string) => (iso ? new Date(iso).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' }) : '');

export interface AppStatus {
  app: string;
  /** Tệp chưa đồng bộ (mọi trạng thái trừ synced), xung đột lên trước. */
  changed: FileStatus[];
  synced: number;
}

const STATE_ORDER: SyncState[] = ['conflict', 'both_changed', 'local_changed', 'local_new', 'local_deleted', 'remote_changed', 'remote_new', 'remote_deleted', 'synced'];

/** Gom tệp theo app (tên app tăng dần): tệp đã đồng bộ chỉ đếm, tệp khác liệt kê theo mức cần xử lý rồi theo khoá. */
export function groupByApp(files: FileStatus[]): AppStatus[] {
  const by = new Map<string, AppStatus>();
  for (const f of files) {
    const g = by.get(f.app) ?? { app: f.app, changed: [], synced: 0 };
    if (f.state === 'synced') g.synced++;
    else g.changed.push(f);
    by.set(f.app, g);
  }
  for (const g of by.values()) g.changed.sort((a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) || a.key.localeCompare(b.key));
  return [...by.values()].sort((a, b) => a.app.localeCompare(b.app));
}

export type SyncOp = 'push' | 'pull';
export type LastResult = { op: 'push'; result: PushResult } | { op: 'pull'; result: PullResult };

/** Số tệp theo từng phần của kết quả (nhãn tiếng Việt), bỏ phần bằng 0 trừ phần chính. */
export function resultCounts(r: LastResult): { label: string; n: number }[] {
  const common = (x: PushResult | PullResult) => [
    { label: 'xung đột', n: x.conflicts.length },
    { label: 'bỏ qua', n: x.skipped.length },
    { label: 'lỗi', n: x.errors.length },
  ];
  const main =
    r.op === 'push'
      ? [{ label: 'đã đẩy', n: r.result.pushed.length }]
      : [
          { label: 'đã kéo', n: r.result.pulled.length },
          { label: 'đã xoá theo nhóm', n: r.result.deleted.length },
          { label: 'gộp tự động', n: r.result.merged.length },
        ];
  return [main[0], ...[...main.slice(1), ...common(r.result)].filter((c) => c.n > 0)];
}

/** Câu tóm tắt một lần đẩy/kéo cho thông báo. */
export function resultSentence(r: LastResult): string {
  const parts = resultCounts(r).map((c) => `${c.n} ${c.label}`);
  return `${r.op === 'push' ? 'Đẩy lên' : 'Kéo về'} xong: ${parts.join(', ')}.`;
}

/** Mã lỗi khiến trang Đồng bộ hiện màn trống (chưa đăng nhập / chưa cấu hình) thay cho bảng trạng thái. */
export type SyncBlock = 'not_signed_in' | 'sync_not_configured';

export function blockOf(e: unknown): SyncBlock | null {
  const code = (e as { code?: string } | null)?.code;
  return code === 'not_signed_in' || code === 'sync_not_configured' ? code : null;
}

/**
 * Câu lỗi của đồng bộ: dữ liệu sai / không tìm thấy thì câu chi tiết của Go (vd "bản gộp không qua kiểm tra ..."), mã có trong
 * contracts/errors.json dùng câu chung, mã lạ thì câu của Go.
 */
export function syncErrorText(e: unknown): string {
  const err = e as { code?: string; params?: Record<string, string | number>; message?: string } | null;
  const code = err?.code ?? '';
  const detail = err?.params?.['chi tiết'] ? String(err.params['chi tiết']) : '';
  if ((code === 'invalid' || code === 'not_found') && detail) return detail;
  if (code && knownErrorCodes().includes(code)) return errorText(e);
  return detail || err?.message || errorText(e);
}
