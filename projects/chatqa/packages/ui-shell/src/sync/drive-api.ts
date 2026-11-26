// Đồng bộ Drive công ty: lời gọi dùng chung cho các màn. Desktop gọi drive.Service qua platform (Go kiểm quyền);
// phần chỉ đọc của admin (tình trạng từng máy, cảnh báo, trạng thái kết nối) trên PWA đi thẳng Worker.
import {
  ApiError,
  platform,
  isDesktop,
  type AdminSyncStatus,
  type BackupResult,
  type BootstrapProgress,
  type ClosePending,
  type DriveAlert,
  type DriveConflict,
  type DriveConflictDetail,
  type DriveInfo,
  type DriveNotice,
  type DeviceSyncStatus,
  type DriveSyncState,
  type ItemVersion,
  type RestoreInput,
  type RestoreResult,
} from '../platform';

export type { AdminSyncStatus, DeviceSyncStatus, BackupResult, BootstrapProgress, ClosePending, DriveAlert, DriveConflict, DriveConflictDetail, DriveInfo, DriveNotice, ItemVersion, RestoreResult };

/** Trạng thái thanh đồng bộ do Go tính (BR-007). */
export type DriveStatus = Omit<DriveSyncState, 'bootstrap'> & { bootstrap?: BootstrapProgress };
export type SyncStateName = DriveStatus['state'];

/** GET /v1/google/status (worker/src/routes/google.ts). */
export interface GoogleStatus {
  connected: boolean;
  email?: string;
  root_folder_id?: string | null;
  connectedBy?: string | null;
  connectedAt?: number | null;
  lastBackupAt?: number | null;
  lastBackupBy?: string | null;
}

/** Hàm desktop chưa có (exe cũ hơn UI, hoặc đang ở PWA). */
function need<T>(fn: T | undefined): T {
  if (!fn) throw new ApiError('incompatible', 0);
  return fn;
}

export const driveApi = {
  // Desktop: dữ liệu trên máy + Drive
  status: async () => (await need(platform.driveStatus)()) as DriveStatus,
  pullNow: () => need(platform.drivePullNow)(),
  syncNow: () => (platform.syncNow ? platform.syncNow().then(() => undefined) : Promise.resolve()),
  listConflicts: () => need(platform.listConflicts)(),
  getConflict: (id: string) => need(platform.getConflict)(id),
  resolveConflict: (id: string, keepMine: boolean) => need(platform.resolveConflict)(id, keepMine),
  listVersions: (kind: string, id: string) => need(platform.listVersions)(kind, id),
  /** confirm=false: nếu sẽ thay bản của người khác, Go trả restored=false + replaces và chưa ghi gì. */
  restore: (input: RestoreInput) => need(platform.restoreVersion)(input),
  remove: (kind: string, id: string) => need(platform.removeItem)(kind, id),
  undoRemove: (kind: string, id: string) => need(platform.undoRemoveItem)(kind, id),
  listNotices: () => need(platform.listNotices)(),
  seeNotice: (id: string) => need(platform.seeNotice)(id),
  driveInfo: () => need(platform.driveInfo)(),
  initRoot: () => need(platform.initDriveRoot)(),
  backupNow: () => need(platform.backupNow)(),
  bootstrapProgress: () => need(platform.bootstrapProgress)(),
  exportSyncLog: () => need(platform.exportSyncLog)(),
  /** Trả lời hộp E-008: wait=true "Đợi đồng bộ", false "Vẫn đóng". */
  confirmClose: (wait: boolean) => need(platform.confirmClose)(wait),
  onClosePending: (cb: (c: ClosePending) => void) => platform.onClosePending?.(cb) ?? (() => undefined),

  // Admin (admin.drive; Go và Worker từ chối người khác). Desktop qua Go, PWA qua Worker.
  googleStatus: () => platform.api<GoogleStatus>('/v1/google/status'),
  deviceStatus: (): Promise<AdminSyncStatus> => (platform.listDeviceStatus ? platform.listDeviceStatus() : platform.api<AdminSyncStatus>('/v1/admin/sync-status')),
  alerts: (): Promise<DriveAlert[]> =>
    platform.listDriveAlerts ? platform.listDriveAlerts() : platform.api<{ alerts: DriveAlert[] }>('/v1/admin/drive-alerts').then((r) => r.alerts ?? []),
  seeAlerts: async (ids: string[]) => {
    if (platform.seeDriveAlert) await Promise.all(ids.map((id) => platform.seeDriveAlert!(id)));
    else await platform.api('/v1/admin/drive-alerts/seen', { method: 'POST', body: { ids } });
  },
};

/** Lịch sử, xung đột, gỡ, sao lưu, khởi tạo kho chỉ có trên app Windows (dữ liệu nằm trên máy). */
export const driveLocal = isDesktop;
