import type { NetEvent } from '../lib/net-progress';
import type { Role } from './roles';
import type { RulesApi } from './rules-types';
import type { LessonsApi, SuggestApi } from './suggest-types';
import type { TariffApi, TariffChange } from './tariff-types';
import type { TeachApi } from './teach-types';
import type { VipoApi } from './vipo-types';
import type { LotApi } from './lot-types';
import type { CheckApi } from './check-types';
export type { Role };
// Kiểu biểu thuế: chỉ hai kiểu platform cần (một số tên như SaveResult, TariffChapter, TariffNotice trùng với sổ quy tắc);
// màn biểu thuế nhập đủ kiểu từ './tariff-types' (qua modules/tariff/tariff-api.ts).
export type { TariffApi, TariffChange };
// Sổ dạy AI (App 4): màn Sổ nhập đủ kiểu từ './teach-types' (qua modules/teach/teach-api.ts).
export type { TeachApi };
// Kiểu Sheet Vipo: màn của phân hệ nhập đủ kiểu từ './vipo-types' (qua modules/vipo/vipo-api.ts).
export type { VipoApi };
// Kiểu Gộp lô: màn của phân hệ nhập đủ kiểu từ './lot-types' (qua modules/lot/lot-api.ts).
export type { LotApi, CheckApi };
export * from './rules-types';
export * from './suggest-types';
/** Khớp contracts/apps.json (test src/modules/registry.test.ts kiểm tra). */
import { APP_CODES } from '@product/product';

export { APP_CODES };
export type AppCode = (typeof APP_CODES)[number];

export interface User {
  id: string;
  tenant: string;
  name: string;
  role: Role;
  /** App được cấp; null/thiếu = mọi app bản quyền bật. */
  apps?: AppCode[] | null;
  /** Quyền thao tác của vai (contracts/permissions.json), vd 'approve.review'. Admin có mọi quyền. */
  perms?: string[];
  /** Tên công ty (thanh trên của web). Worker chưa gửi: thiếu thì không hiện. */
  company?: string;
}

export type LicenseStatus = 'none' | 'valid' | 'needs_refresh' | 'offline_expired' | 'expired' | 'invalid';

export interface LicenseInfo {
  status: LicenseStatus;
  apps: AppCode[];
  expiresAt: number;
  refreshBy: number;
  deviceName: string;
  /** Tên công ty (tiêu đề cửa sổ, màn đăng nhập). Go chưa gửi: thiếu thì UI dùng tên sản phẩm. */
  company?: string;
  /** Số máy đã dùng / tối đa (màn kích hoạt thành công). Go chưa gửi: thiếu thì bỏ dòng này. */
  seats?: { used: number; max: number };
}

export interface VersionInfo {
  ui: string;
  bin: string;
  coreApi: number;
  uiSource: 'embedded' | 'ota';
}

export interface UpdateItem {
  version: string;
  notes: string;
  mandatory: boolean;
  size: number;
}

export interface BinUpdate extends UpdateItem {
  /** available | downloading (tải nền) | ready (chờ khởi động lại) | error */
  state: 'available' | 'downloading' | 'ready' | 'error';
  progress: number; // 0..1
  error: string;
}

export interface UpdateInfo {
  ui: UpdateItem | null;
  bin: BinUpdate | null;
}

export interface SyncStatus {
  online: boolean;
  syncing: boolean;
  pending: number;
  failed: number;
  conflict: number;
  lastSyncAt: number;
  lastError: string;
  needsLogin: boolean;
  /** Mã lỗi của lastError (drive_full, drive_busy...); '' = không lỗi. */
  code?: string;
  lastPullAt?: number;
  pulling?: boolean;
  driveConnected?: boolean;
}

/** Trạng thái toàn cục máy Windows báo cho UI (desktop/internal/core/session.go AuthState). */
export interface AuthState {
  /** '' | expired (E-005) | offline_locked (E-006) | revoked (E-016) | locked_out (E-019) */
  overlay: '' | 'expired' | 'offline_locked' | 'revoked' | 'locked_out';
  /** Giờ máy chủ của sự kiện (E-019: lúc bị khoá), giây. */
  at: number;
  /** Số ngày máy chưa kết nối (E-006 {n}). */
  offlineDays: number;
  /** Còn bao nhiêu giây tới hạn offline; âm = đã quá hạn. */
  offlineLeftSec: number;
  /** Vừa đăng nhập bằng mật khẩu tạm: chỉ được đổi mật khẩu. */
  mustChangePassword: boolean;
  /** Số thay đổi còn chờ đồng bộ. */
  pending: number;
  /** Số thao tác đang chờ admin hoặc không được công nhận (E-018). */
  review: number;
}

export const NO_AUTH: AuthState = { overlay: '', at: 0, offlineDays: 0, offlineLeftSec: 0, mustChangePassword: false, pending: 0, review: 0 };

/** Một app trên menu (FR-014). */
export interface AppItem {
  code: AppCode;
  name: string;
  /** activated | not_activated (mờ, "Chưa kích hoạt") | not_granted (ổ khoá) | license_disabled (bị tắt khỏi bản quyền). */
  state: 'activated' | 'not_activated' | 'not_granted' | 'license_disabled';
  /** Lỗi hiện khi bấm: module_locked (E-012) | app_forbidden (E-013) | app_disabled (E-017). */
  errorCode: '' | 'module_locked' | 'app_forbidden' | 'app_disabled';
}

/** Thao tác không được công nhận / đang chờ admin (E-018), từ hàng đợi đồng bộ. */
export interface ReviewOp {
  id: string;
  kind: string;
  entity: string;
  status: 'review' | 'rejected';
  reason: string;
  perm: string;
  app: string;
  at: number;
  actorUserId: string;
}

export interface AppState {
  user: User | null;
  license: LicenseInfo | null; // null trên PWA
  version: VersionInfo;
  offline?: boolean;
  sync?: SyncStatus; // chỉ desktop
  /** Chỉ desktop: hộp thoại/khoá màn toàn cục. PWA tự suy từ phiên. */
  auth?: AuthState;
  /** Chỉ desktop: trạng thái từng app trên menu. */
  apps?: AppItem[];
}

export type Card = Record<string, string | number | undefined>;

/** 1 dòng yêu cầu (Sheet Vipo) + thẻ hàng, lưu trên máy. */
export interface QuoteRequest {
  id: string;
  vipo: Record<string, unknown>;
  card: Card;
  status: 'new' | 'draft' | 'done';
  remoteStamp: string;
  updatedAt: number;
  updatedBy: string;
  pending: boolean; // còn thay đổi chưa đồng bộ
  removed?: boolean; // đã gỡ (FR-016): chỉ có trong quote.Service.ListRemovedRequests
}

export interface SyncIssue {
  id: string;
  kind: string;
  entity: string;
  status: 'failed' | 'conflict';
  lastError: string;
  createdAt: number;
}

// ---------- Đồng bộ Drive công ty (desktop: window.go.drive.Service.*, desktop/internal/drive/service.go) ----------

/** Tiến độ lấy dữ liệu lần đầu (FR-006). code: bootstrap_needs_network | bootstrap_partial (E-017) | mã lỗi Drive. */
export interface BootstrapProgress {
  stage: 0 | 1 | 2 | 3;
  done: number;
  total: number;
  running: boolean;
  code?: string;
  /** E-011: máy cũ của cùng người còn mục chưa lên Drive ở lần báo cuối. */
  previousDevice?: { deviceId: string; name: string; lastSyncAt: number };
}

/**
 * Thanh trạng thái đồng bộ (BR-007, FR-004), đúng một trạng thái theo ưu tiên: not_connected (E-001) > offline > conflicts >
 * error > syncing > synced. label / code là khoá trong contracts/errors.json; params điền {n}.
 */
export interface DriveSyncState {
  state: 'not_connected' | 'offline' | 'conflicts' | 'error' | 'syncing' | 'pending' | 'synced';
  label: 'drive_not_connected' | 'sync_offline' | 'sync_conflicts_open' | 'sync_error' | 'sync_running' | 'sync_pending' | 'sync_done';
  params?: { n: number };
  /** Chỉ khi state = error: câu lỗi kèm việc cần làm (drive_full, drive_no_access, drive_busy, license_server_unreachable...). */
  code?: string;
  pending: number;
  conflicts: number;
  lastSyncAt: number;
  lastPullAt: number;
  bootstrap: BootstrapProgress;
}

/** Xung đột: hai bản của cùng một mục từ cùng bản gốc (FR-007). Nội dung là JSON của mục (thẻ hàng: { card, status }). */
export interface DriveConflict {
  id: string;
  kind: string;
  itemId: string;
  mineRev: number;
  mineContent: unknown;
  theirsRev: number;
  theirsContent: unknown;
  theirsRemoved: boolean;
  theirsUser: string;
  theirsName: string;
  theirsDevice: string;
  theirsAt: number;
  opId: string;
  perm: string;
  app: string;
  status: 'open' | 'kept_mine' | 'took_theirs';
  createdAt: number;
  resolvedAt: number;
  resolvedBy: string;
}

/** Hộp so sánh (E-005): field kiểu "card.ma_hs"; null = bản đó không có trường. */
export interface DriveConflictDetail extends DriveConflict {
  mineRemoved: boolean;
  fields: { field: string; mine: unknown; theirs: unknown }[];
}

/** Một phiên bản trong lịch sử (FR-013), mới nhất trước. */
export interface ItemVersion {
  kind: string;
  itemId: string;
  rev: number;
  opId: string;
  baseRev: number;
  content: unknown;
  actorUserId: string;
  actorName: string;
  deviceId: string;
  at: number;
  origin: 'edit' | 'restore' | 'conflict_lost' | 'remote' | 'remove' | 'undo_remove';
  reason: string;
  approved: boolean;
  onDrive: boolean;
}

export interface RestoreInput {
  kind: string;
  id: string;
  rev: number;
  opId: string;
  /** Bắt buộc, không được chỉ khoảng trắng (restore_reason_required). */
  reason: string;
  /** Đã xem cảnh báo restore_replaces ("Sẽ thay thế thay đổi của {tên} lúc {giờ}") và vẫn khôi phục. */
  confirm: boolean;
}

/** restored=false kèm replaces = bước hỏi lại, chưa ghi gì; gọi lại với confirm=true. */
export interface RestoreResult {
  restored: boolean;
  replaces?: { userId: string; name: string; at: number };
  rev?: number;
}

/** Thông báo cho người dùng máy này; messageCode là khoá contracts/errors.json (conflict_version_lost, version_restored_over). */
export interface DriveNotice {
  id: string;
  kind: string;
  itemId: string;
  messageCode: string;
  params: Record<string, string | number>;
  createdAt: number;
  seenAt: number;
}

/** Màn "Lưu trữ đám mây". online=false: chưa hỏi được Worker, chỉ có phần biết trên máy. */
export interface DriveInfo {
  connected: boolean;
  rootId: string;
  email: string;
  connectedBy: string;
  connectedAt: number;
  lastBackupAt: number;
  lastBackupBy: string;
  online: boolean;
}

/** "Sao lưu ngay": _sao-luu/<name>/ kèm manifest.json. Lỗi: backup_failed với params.lastBackupAt (E-013). */
export interface BackupResult {
  name: string;
  folderId: string;
  items: number;
  at: number;
}

export interface DeviceSyncStatus {
  deviceId: string;
  name: string;
  revoked: boolean;
  userId: string | null;
  userName: string | null;
  lastSyncAt: number | null;
  lastPushAt: number | null;
  lastPullAt: number | null;
  pending: number;
  conflicts: number;
  lastError: string | null;
  reportedAt: number | null;
  stale: boolean;
}

export interface AdminSyncStatus {
  serverNow: number;
  staleDeviceHours: number;
  devices: DeviceSyncStatus[];
}

export interface DriveAlert {
  id: string;
  kind: 'drive_full' | 'drive_no_access' | 'drive_drop' | 'device_stale' | 'license_unreachable';
  /** null = cảnh báo cả công ty. */
  deviceId: string | null;
  deviceName: string | null;
  detail: unknown;
  day: string;
  createdAt: number;
}

/** Sự kiện sync:close_pending (E-008): "Còn {n} mục chưa lên Drive"; waiting = đang "Đợi đồng bộ", app tự đóng khi xong. */
export interface ClosePending {
  pending: number;
  waiting: boolean;
}

export interface GoogleToken {
  access_token: string;
  expires_at: number;
  /** HS Desk: thư mục gốc, Sheet Vipo, Nhật ký, Sổ dạy AI. Sản phẩm khác: thư mục gốc và Sheet chỉ mục (indexSheetId). */
  resources: { rootFolderId: string | null; vipoSheetId?: string | null; logSheetId?: string | null; teachSheetId?: string | null; indexSheetId?: string | null };
}

export interface Platform {
  kind: 'desktop' | 'pwa';
  getState(): Promise<AppState>;
  /** Tên đăng nhập duy nhất toàn hệ thống; công ty suy ra từ tài khoản. */
  login(username: string, password: string): Promise<User>;
  /** Đăng xuất; trả số thay đổi còn chờ đồng bộ để báo (dữ liệu vẫn giữ và được đẩy khi máy kết nối, BR-017). */
  logout(): Promise<number>;
  /** Đổi mật khẩu (cần mạng, E-020). Các máy khác và mọi phiên web phải đăng nhập lại. */
  changePassword(current: string, next: string, confirm: string): Promise<User>;
  /** Gọi API Worker có kèm phiên đăng nhập. */
  api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T>;
  googleToken(): Promise<GoogleToken>;

  // Chỉ desktop
  activateLicense?(licenseKey: string): Promise<LicenseInfo>;
  checkUpdate?(): Promise<UpdateInfo>;
  applyUpdate?(kind: 'ui' | 'bin'): Promise<void>;
  updateStatus?(): Promise<UpdateInfo>;
  onUpdateStatus?(cb: (u: UpdateInfo) => void): () => void;
  /** Go phát khi hộp thoại/khoá màn đổi (heartbeat báo khoá, thu hồi, hết hạn offline...). */
  onAuthState?(cb: (a: AuthState) => void): () => void;
  listReviewOps?(): Promise<ReviewOp[]>;
  dismissRejected?(id: string): Promise<void>;

  // Dữ liệu cục bộ + đồng bộ (chỉ desktop)
  listRequests?(status?: string): Promise<QuoteRequest[]>;
  saveCard?(input: { requestId: string; card: Card; status: string; reason: string }): Promise<QuoteRequest>;
  pullRequests?(): Promise<number>;
  syncNow?(): Promise<SyncStatus>;
  listSyncIssues?(): Promise<SyncIssue[]>;
  resolveSyncIssue?(id: string, keepMine: boolean): Promise<void>;
  onSyncStatus?(cb: (s: SyncStatus) => void): () => void;

  // Đồng bộ Drive công ty (chỉ desktop). Quyền kiểm ở Go: thao tác quản trị => drive_admin_only (E-018),
  // khôi phục bản người khác => restore_not_own (E-012).
  driveStatus?(): Promise<DriveSyncState>;
  drivePullNow?(): Promise<void>;
  listConflicts?(): Promise<DriveConflict[]>;
  getConflict?(id: string): Promise<DriveConflictDetail>;
  resolveConflict?(id: string, keepMine: boolean): Promise<void>;
  listVersions?(kind: string, id: string): Promise<ItemVersion[]>;
  restoreVersion?(input: RestoreInput): Promise<RestoreResult>;
  removeItem?(kind: string, id: string): Promise<void>;
  undoRemoveItem?(kind: string, id: string): Promise<void>;
  listNotices?(): Promise<DriveNotice[]>;
  seeNotice?(id: string): Promise<void>;
  driveInfo?(): Promise<DriveInfo>;
  initDriveRoot?(): Promise<string>;
  backupNow?(): Promise<BackupResult>;
  bootstrapProgress?(): Promise<BootstrapProgress>;
  listDeviceStatus?(): Promise<AdminSyncStatus>;
  listDriveAlerts?(): Promise<DriveAlert[]>;
  seeDriveAlert?(id: string): Promise<void>;
  /** NFR-012: lưu nhật ký đồng bộ ra tệp người dùng chọn; trả đường dẫn, '' = người dùng bỏ. */
  exportSyncLog?(): Promise<string>;
  /** Trả lời hộp E-008: wait = "Đợi đồng bộ", false = "Vẫn đóng". */
  confirmClose?(wait: boolean): Promise<void>;
  onClosePending?(cb: (c: ClosePending) => void): () => void;
  /** Tiến độ thao tác mạng (Sheets, Drive, Worker) do Go phát; trả hàm huỷ nghe. Chỉ desktop: PWA không có, giao diện dùng đường dự phòng theo thời gian đã chờ. */
  onNetProgress?(cb: (e: NetEvent) => void): () => void;

  /** Sổ quy tắc phân loại. Chỉ desktop: bản PWA từ chối mọi hàm bằng ApiError('desktop_only') (trang không mở ở web). */
  rules: RulesApi;
  /** Báo giá v1: đợt, mặt hàng, duyệt, ngân sách, hiện diện (chỉ desktop). */
  suggest: SuggestApi;
  /** Sổ dạy AI phần UI dùng ở đợt này (chỉ desktop). */
  lessons: LessonsApi;
  /** Biểu thuế: tab Biểu thuế / Chống bán phá giá, Khối Thuế (chỉ desktop; bản PWA từ chối bằng desktop_only). */
  tariff: TariffApi;
  /** Sổ dạy AI (App 4): Sổ, chi tiết, rà soát, cặp mã dễ nhầm, lý do, badge (chỉ desktop; PWA từ chối desktop_only). */
  teach: TeachApi;
  /** Biểu hoặc danh sách chống bán phá giá đang dùng đổi (nạp, gỡ, chọn bản, kéo về); trả hàm huỷ nghe. Chỉ desktop. */
  onTariffChanged?(cb: (c: TariffChange) => void): () => void;
  /** Sheet Vipo: ánh xạ cột, đọc Sheet, đợt từ Sheet, sao chép về Sheet (chỉ desktop; bản PWA từ chối bằng desktop_only). */
  vipo: VipoApi;
  /** Sau mỗi lần đọc Sheet hoặc lượt kéo mang bản ghi Sheet về; trả hàm huỷ nghe. Chỉ desktop. */
  onVipoChanged?(cb: () => void): () => void;
  /** Gộp lô (App 2): danh sách lô, khởi tạo, gộp, nạp, giữ lô, Sẵn sàng đối soát, tiêu chí (chỉ desktop; PWA từ chối desktop_only). */
  lot: LotApi;
  /** Sau mỗi lần ghi và lượt kéo mang bản ghi lô về; trả hàm huỷ nghe. Chỉ desktop. */
  onLotChanged?(cb: () => void): () => void;
  /** Kiểm tra trước khai báo (App 3): danh sách lô đã xuất, bảng kiểm, quyết định, sang xuất (chỉ desktop; PWA từ chối desktop_only). */
  check: CheckApi;
  /** Sau mỗi lần ghi và lượt kéo mang bản ghi kiểm tra về; trả hàm huỷ nghe. Chỉ desktop. */
  onCheckChanged?(cb: () => void): () => void;
}

export class ApiError extends Error {
  /** params: giá trị điền vào chỗ trống của câu lỗi, vd { mm: 15 } cho E-002, { lockedAt } cho E-003/E-019. */
  constructor(public code: string, public status: number, public params: Record<string, string | number> = {}) {
    super(code);
  }
}
