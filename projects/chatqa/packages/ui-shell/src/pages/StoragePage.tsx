// Mục CHUNG "Lưu trữ đám mây" (khung pen "Lưu trữ & đồng bộ đám mây", nút "Sao lưu ngay"): chỉ người có quyền admin.drive.
// Kết nối / đổi tài khoản Drive vẫn ở màn quản trị "Kết nối Drive" (DrivePage); trang này thêm khởi tạo kho, sao lưu,
// cảnh báo và tình trạng đồng bộ từng máy. Phần chỉ đọc (cảnh báo, từng máy) dùng lại trên web ở DrivePage.
import { useState, type ReactNode } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { CloudUpload, FolderPlus, HardDrive, TriangleAlert } from 'lucide-react';
import { isDesktop } from '../platform';
import { useSession } from '../lib/session';
import { useAction } from '../lib/use-action';
import { Banner, Button, DataTable, StatusDot, type Column } from '../components/ui';
import { NetProgress } from '../components/NetProgress';
import { driveApi, type DeviceSyncStatus, type DriveInfo } from '../sync/drive-api';
import { canSeeStorage, driveCopy, driveErrorText, vnClock } from '../sync/sync-view';
import { useResource } from './admin/use-resource';

const when = (t: number | null | undefined) => (t ? vnClock(t) : '—');

/** Trạng thái một máy: thu hồi, quá hạn đồng bộ (FR-019), lỗi gần nhất, bình thường. */
function DeviceState({ d, hours }: { d: DeviceSyncStatus; hours: number }) {
  if (d.revoked) return <StatusDot tone="gray">Đã thu hồi</StatusDot>;
  if (d.stale) return <StatusDot tone="red">Quá {hours} giờ chưa đồng bộ</StatusDot>;
  if (d.conflicts > 0) return <StatusDot tone="blue">{driveCopy('sync_conflicts_open', { n: d.conflicts })}</StatusDot>;
  if (d.lastError) return <StatusDot tone="amber">{driveCopy('sync_error')}</StatusDot>;
  return <StatusDot tone="green">{d.pending > 0 ? driveCopy('sync_pending', { n: d.pending }) : driveCopy('sync_done')}</StatusDot>;
}

/** Bảng tình trạng đồng bộ từng máy (FR-019): lần đồng bộ cuối, số chờ, xung đột, nhãn quá hạn. */
export function DeviceSyncTableView({ devices, staleHours, compact }: { devices: DeviceSyncStatus[]; staleHours: number; compact?: boolean }) {
  if (compact) {
    return (
      <div className="stroke-in flex flex-col rounded-[12px] bg-surface">
        <h2 className="px-[14px] pt-[12px] pb-[6px] text-[13px]/[16px] font-bold">Đồng bộ từng máy</h2>
        {devices.map((d) => (
          <div key={d.deviceId} data-stale={d.stale || undefined} className="flex flex-col gap-[3px] px-[14px] py-[9px] shadow-[inset_0_1px_0_var(--color-divider)]">
            <span className="text-[13px]/[16px] font-semibold">{d.name}</span>
            <span className="text-[11.5px]/[15px] text-text-3">
              {d.userName ?? '—'} · {when(d.lastSyncAt)} · chờ {d.pending}
            </span>
            <DeviceState d={d} hours={staleHours} />
          </div>
        ))}
      </div>
    );
  }
  const cols: Column<DeviceSyncStatus>[] = [
    { key: 'name', header: 'Máy', render: (d) => <span className="truncate text-[12.5px]/[16px] font-semibold">{d.name}</span> },
    { key: 'user', header: 'Người dùng', width: 160, render: (d) => <span className="truncate text-[12px]/[15px] text-text-2">{d.userName ?? '—'}</span> },
    { key: 'last', header: 'Lần đồng bộ cuối', width: 140, render: (d) => <span className="font-mono text-[11.5px]/[15px]">{when(d.lastSyncAt)}</span> },
    { key: 'pending', header: 'Chờ', width: 50, render: (d) => <span className="font-mono text-[12px]/[15px]">{d.pending}</span> },
    { key: 'conflicts', header: 'Xung đột', width: 70, render: (d) => <span className="font-mono text-[12px]/[15px]">{d.conflicts}</span> },
    { key: 'state', header: 'Trạng thái', width: 210, render: (d) => <DeviceState d={d} hours={staleHours} /> },
  ];
  return <DataTable title="Đồng bộ từng máy" subtitle={`Cảnh báo khi một máy quá ${staleHours} giờ chưa đồng bộ`} columns={cols} rows={devices} rowKey={(d) => d.deviceId} dimRow={(d) => d.revoked} />;
}

/** Tình trạng từng máy, tải từ Go (desktop) hoặc Worker (web). */
export function DeviceSyncTable({ compact }: { compact?: boolean }) {
  const res = useResource(() => driveApi.deviceStatus());
  // Luôn gắn (chỉ đổi active) để lần tải xong được ghi vào lịch sử ước lượng thời gian.
  const progress = <NetProgress op="drive.device-status" active={res.loading && !res.data} label="Đang tải tình trạng đồng bộ từng máy" />;
  if (res.error) return <>{progress}<Banner tone="red">{driveErrorText(res.error)}</Banner></>;
  if (!res.data) return progress;
  return <>{progress}<DeviceSyncTableView devices={res.data.devices} staleHours={res.data.staleDeviceHours} compact={compact} /></>;
}

export interface DriveCardProps {
  info: Pick<DriveInfo, 'connected' | 'rootId' | 'email' | 'connectedBy' | 'connectedAt' | 'lastBackupAt' | 'lastBackupBy'>;
  /** Có dữ liệu trên máy: được Khởi tạo kho (web chỉ xem). */
  local: boolean;
  busy?: '' | 'init' | 'backup';
  onInit?: () => void;
  onConnect?: () => void;
}

const line = 'flex items-center px-[22px] py-[12px] shadow-[inset_0_-1px_0_var(--color-divider)] last:shadow-none';

/** Khung "Kết nối Drive" rút gọn: trạng thái, người kết nối, khởi tạo kho, lần sao lưu gần nhất. */
export function DriveCard({ info, local, busy, onInit, onConnect }: DriveCardProps) {
  const rows: [string, ReactNode][] = [];
  if (info.connected) {
    if (info.connectedBy) rows.push(['Kết nối bởi', `${info.connectedBy}${info.connectedAt ? ` lúc ${vnClock(info.connectedAt)}` : ''}`]);
    rows.push(['Kho HS Desk', info.rootId ? 'Đã khởi tạo' : 'Chưa khởi tạo']);
    rows.push(['Lần sao lưu gần nhất', info.lastBackupAt ? `${vnClock(info.lastBackupAt)}${info.lastBackupBy ? ` · ${info.lastBackupBy}` : ''}` : 'Chưa sao lưu']);
  }
  return (
    <div className="stroke-in flex w-full flex-col rounded-[12px] bg-surface leading-[normal]">
      <div className="flex items-center gap-[16px] p-[22px] shadow-[inset_0_-1px_0_var(--color-border)]">
        <span className="flex h-[52px] w-[52px] shrink-0 items-center justify-center rounded-[14px] bg-green-soft text-green">
          <HardDrive size={24} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-[4px]">
          {info.connected ? (
            <span className="flex items-center gap-[6px] text-[12px]/[15px] font-bold text-green">
              <span className="h-[8px] w-[8px] rounded-full bg-current" />
              Đã kết nối
            </span>
          ) : (
            <span className="text-[12.5px]/[16px] font-bold text-amber">{driveCopy('drive_not_connected')}</span>
          )}
          {info.email && <span className="text-[17px]/[21px] font-bold">{info.email}</span>}
        </div>
        <div className="flex shrink-0 gap-[8px]">
          {info.connected && !info.rootId && local && (
            <Button size="dialog" icon={<FolderPlus size={14} />} disabled={!!busy} loading={busy === 'init'} onClick={onInit}>
              {busy === 'init' ? 'Đang khởi tạo…' : 'Khởi tạo kho'}
            </Button>
          )}
          {!info.connected && onConnect && (
            <Button size="dialog" onClick={onConnect}>
              Kết nối Drive
            </Button>
          )}
        </div>
      </div>
      {busy === 'init' && (
        <div className={line}>
          <NetProgress op="drive.init-root" active label="Đang khởi tạo kho" />
        </div>
      )}
      {rows.map(([k, v]) => (
        <div key={k} className={line}>
          <span className="w-[200px] shrink-0 text-[12.5px]/[16px] text-text-3">{k}</span>
          <span className="text-[12.5px]/[16px] font-semibold">{v}</span>
        </div>
      ))}
    </div>
  );
}

/** Thông tin Drive: desktop hỏi Go (kèm phần biết trên máy), web hỏi Worker. */
async function loadInfo(): Promise<DriveCardProps['info']> {
  if (isDesktop) return driveApi.driveInfo();
  const g = await driveApi.googleStatus();
  return { connected: g.connected, rootId: g.root_folder_id ?? '', email: g.email ?? '', connectedBy: g.connectedBy ?? '', connectedAt: g.connectedAt ?? 0, lastBackupAt: g.lastBackupAt ?? 0, lastBackupBy: g.lastBackupBy ?? '' };
}

export function StoragePage() {
  const { can } = useSession();
  const navigate = useNavigate();
  const info = useResource(loadInfo);
  const [busy, setBusy] = useState<'' | 'init' | 'backup'>('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  // Khởi tạo kho và Sao lưu: một việc một lúc, lần bấm tiếp khi đang chạy bị bỏ qua.
  const [run] = useAction(async (kind: 'init' | 'backup') => {
    setBusy(kind);
    setError('');
    setMessage('');
    try {
      if (kind === 'init') await driveApi.initRoot();
      else {
        const r = await driveApi.backupNow();
        setMessage(`Đã sao lưu ${r.items} mục lúc ${vnClock(r.at)}.`);
      }
      await info.reload();
    } catch (e) {
      setError(driveErrorText(e));
    } finally {
      setBusy('');
    }
  });

  // Nhân sự không thấy trang này (menu ẩn); vào thẳng đường dẫn thì về trang chủ. Go và Worker vẫn từ chối (E-018).
  if (!canSeeStorage(can)) return <Navigate to="/" replace />;

  const d = info.data;
  return (
    <div className="flex flex-col gap-[18px] leading-[normal]">
      <div className="flex items-end gap-[10px]">
        <div className="flex min-w-0 flex-1 flex-col gap-[4px]">
          <span className="text-[12px]/[15px] text-text-3">Có trong cả 4 app · Dữ liệu thuộc sở hữu Công ty Anh Tùng · Lưu trên Google Drive của công ty</span>
          <h1 className="text-[24px]/[30px] font-bold tracking-[-0.4px]">Lưu trữ &amp; đồng bộ đám mây</h1>
        </div>
        {isDesktop && (
          <div className="flex shrink-0 flex-col items-end gap-[8px]">
            <Button icon={<CloudUpload size={15} />} disabled={!!busy || !d?.connected || !d.rootId} loading={busy === 'backup'} onClick={() => void run('backup')}>
              {busy === 'backup' ? 'Đang sao lưu…' : 'Sao lưu ngay'}
            </Button>
            <NetProgress op="drive.backup" active={busy === 'backup'} label="Đang sao lưu lên Drive" />
          </div>
        )}
      </div>
      {!!info.error && <Banner tone="red">{driveErrorText(info.error)}</Banner>}
      {error && (
        <Banner tone="red" icon={<TriangleAlert size={16} />}>
          {error}
        </Banner>
      )}
      {message && <Banner tone="green">{message}</Banner>}
      <NetProgress op="drive.info" active={!d && info.loading} label="Đang tải thông tin Drive công ty" className="self-center py-16" />
      {d && <DriveCard info={d} local={isDesktop} busy={busy} onInit={() => void run('init')} onConnect={() => navigate('/cai-dat/drive')} />}
      <DeviceSyncTable />
    </div>
  );
}
