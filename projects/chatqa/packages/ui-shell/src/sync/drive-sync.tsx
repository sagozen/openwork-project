// Trạng thái đồng bộ Drive dùng chung cho thanh trạng thái, bảng đồng bộ, thẻ hàng và các hộp thoại toàn cục
// (xung đột, đóng app còn chờ, lấy dữ liệu máy mới). Chỉ sản phẩm có Drive công ty mới bọc provider này;
// thiếu provider thì useDriveSync() trả null và shell giữ thanh trạng thái cũ.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ApiError, isDesktop } from '../platform';
import { useSession } from '../lib/session';
import { useSyncStatus } from '../components/SyncBadge';
import { driveApi, type BootstrapProgress, type ClosePending, type DriveAlert, type DriveConflict, type DriveNotice, type DriveStatus } from './drive-api';
import { afterConflictDialog, bootstrapVisible, canSeeStorage, statusFromQueue } from './sync-view';

export interface DriveSync {
  status: DriveStatus | null;
  conflicts: DriveConflict[];
  notices: DriveNotice[];
  alerts: DriveAlert[];
  bootstrap: BootstrapProgress | null;
  /** Đang mở hộp xung đột này. */
  conflictId: string | null;
  openConflict: (id: string) => void;
  /** choice=null: đóng mà chưa chọn (mục vẫn chờ giải quyết). */
  closeConflict: (choice: 'mine' | 'theirs' | null) => void;
  closePending: ClosePending | null;
  answerClose: (wait: boolean) => Promise<void>;
  reload: () => Promise<void>;
  seeNotice: (id: string) => Promise<void>;
  seeAlerts: (ids: string[]) => Promise<void>;
  dismissBootstrap: () => void;
}

const Ctx = createContext<DriveSync | null>(null);

export const useDriveSync = () => useContext(Ctx);

const BOOTSTRAP_POLL_MS = 2000;
const offlineNow = () => typeof navigator !== 'undefined' && navigator.onLine === false;

/** PWA: không có dữ liệu trên máy; trạng thái lấy từ Worker (đã kết nối Drive chưa) và mạng của trình duyệt. */
function useWebStatus(enabled: boolean): DriveStatus | null {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [offline, setOffline] = useState(offlineNow());
  useEffect(() => {
    if (!enabled) return;
    driveApi.googleStatus().then((g) => setConnected(!!g.connected), () => setConnected(null));
    const on = () => setOffline(offlineNow());
    window.addEventListener('online', on);
    window.addEventListener('offline', on);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', on);
    };
  }, [enabled]);
  if (!enabled) return null;
  const q = { online: !offline, syncing: false, pending: 0, failed: 0, conflict: 0, lastSyncAt: 0 };
  if (offline) return statusFromQueue(q);
  if (connected === null) return null;
  return statusFromQueue({ ...q, driveConnected: connected });
}

export function DriveSyncProvider({ children }: { children: ReactNode }) {
  const { state, can } = useSession();
  const user = state?.user;
  const queue = useSyncStatus();
  const [status, setStatus] = useState<DriveStatus | null>(null);
  /** Exe cũ chưa có drive.Service: dùng trạng thái hàng đợi. */
  const [legacy, setLegacy] = useState(false);
  const [conflicts, setConflicts] = useState<DriveConflict[]>([]);
  const [notices, setNotices] = useState<DriveNotice[]>([]);
  const [alerts, setAlerts] = useState<DriveAlert[]>([]);
  const [bootstrapHidden, setBootstrapHidden] = useState(false);
  const [conflictId, setConflictId] = useState<string | null>(null);
  const [closePending, setClosePending] = useState<ClosePending | null>(null);
  const webStatus = useWebStatus(!isDesktop && !!user);

  const loadLocal = useCallback(async () => {
    if (!isDesktop || !user) return;
    try {
      setStatus(await driveApi.status());
      setLegacy(false);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'incompatible') setLegacy(true);
      return;
    }
    // Danh sách phụ: lỗi một danh sách không làm mất trạng thái chính.
    await Promise.all([driveApi.listConflicts().then(setConflicts, () => undefined), driveApi.listNotices().then(setNotices, () => undefined)]);
  }, [user]);

  // Mở app + mỗi lần hàng đợi báo đổi (đẩy xong, kéo xong, mất mạng...).
  useEffect(() => {
    void loadLocal();
  }, [loadLocal, queue?.pending, queue?.conflict, queue?.failed, queue?.online, queue?.syncing, queue?.pulling, queue?.lastSyncAt, queue?.lastPullAt]);

  // E-008: Go giữ cửa sổ khi còn mục chờ và hỏi; sự kiện lặp lại với số mới khi đang "Đợi đồng bộ".
  useEffect(() => {
    if (!isDesktop || !user) return;
    return driveApi.onClosePending((c) => setClosePending(c.pending > 0 ? c : null));
  }, [user]);

  // FR-017: admin thấy cảnh báo Drive ở lần mở app kế tiếp, trên bất kỳ máy nào (desktop và web).
  const admin = !!user && canSeeStorage(can);
  useEffect(() => {
    if (!admin) {
      setAlerts([]);
      return;
    }
    driveApi.alerts().then(setAlerts, () => setAlerts([]));
  }, [admin]);

  // Máy mới: hỏi lại trạng thái (kèm tiến độ lấy dữ liệu) tới khi xong.
  const bootstrap = status?.bootstrap ?? null;
  const bootstrapping = !legacy && bootstrapVisible(bootstrap);
  useEffect(() => {
    if (!bootstrapping) return;
    const id = setInterval(() => void loadLocal(), BOOTSTRAP_POLL_MS);
    return () => clearInterval(id);
  }, [bootstrapping, loadLocal]);
  // Tiến độ đổi trạng thái (vd có mạng lại) thì hiện lại màn lấy dữ liệu.
  useEffect(() => setBootstrapHidden(false), [bootstrap?.code, bootstrap?.running]);

  const value = useMemo<DriveSync>(() => {
    const effective = isDesktop ? (legacy || !status ? (queue ? statusFromQueue(queue) : null) : status) : webStatus;
    return {
      status: effective,
      conflicts,
      notices,
      alerts,
      bootstrap: bootstrapHidden || legacy ? null : bootstrap,
      conflictId,
      openConflict: (id) => setConflictId(id),
      closeConflict: (choice) => {
        if (conflictId) setConflicts((cur) => afterConflictDialog(cur, conflictId, choice));
        setConflictId(null);
        if (choice) void loadLocal();
      },
      closePending,
      answerClose: async (wait) => {
        // "Đợi đồng bộ": Go phát lại số còn chờ mỗi lượt và tự đóng khi xong.
        setClosePending(wait ? (c) => (c ? { ...c, waiting: true } : c) : null);
        await driveApi.confirmClose(wait);
      },
      reload: loadLocal,
      seeNotice: async (id) => {
        await driveApi.seeNotice(id);
        setNotices((cur) => cur.filter((n) => n.id !== id));
      },
      seeAlerts: async (ids) => {
        await driveApi.seeAlerts(ids);
        setAlerts((cur) => cur.filter((a) => !ids.includes(a.id)));
      },
      dismissBootstrap: () => setBootstrapHidden(true),
    };
  }, [legacy, status, queue, webStatus, conflicts, notices, alerts, bootstrap, bootstrapHidden, conflictId, closePending, loadLocal]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
