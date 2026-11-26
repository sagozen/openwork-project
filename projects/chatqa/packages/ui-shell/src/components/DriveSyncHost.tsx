// Hộp thoại toàn cục của đồng bộ Drive (đặt một lần dưới DriveSyncProvider): xung đột, đóng app còn chờ (E-008),
// màn lấy dữ liệu máy mới (FR-006). Cảnh báo Drive cho admin (FR-017) là dải riêng đặt trên nội dung trang.
import { useState } from 'react';
import { CloudUpload, TriangleAlert } from 'lucide-react';
import { useSession } from '../lib/session';
import { useDriveSync } from '../sync/drive-sync';
import type { DriveAlert } from '../sync/drive-api';
import { alertText, bootstrapVisible, driveCopy, driveErrorText } from '../sync/sync-view';
import { BootstrapScreen } from './BootstrapScreen';
import { ConflictDialog } from './ConflictDialog';
import { Banner, Button, Dialog } from './ui';

/** E-008: "Còn {n} mục chưa lên Drive" + "Đợi đồng bộ" / "Vẫn đóng". Đang đợi thì app tự đóng khi đẩy xong. */
export function ClosePendingDialog({ pending, waiting, onWait, onClose, overlay }: { pending: number; waiting: boolean; onWait: () => void; onClose: () => void; overlay?: boolean }) {
  return (
    <Dialog
      variant="compact"
      overlay={overlay}
      tone="amber"
      icon={<CloudUpload size={18} />}
      title={driveCopy('close_pending', { n: pending })}
      actions={
        <>
          <Button size="dialog" variant="secondary" onClick={onClose}>
            {driveCopy('close_anyway')}
          </Button>
          <Button size="dialog" disabled={waiting} onClick={onWait}>
            {driveCopy('close_wait_sync')}
          </Button>
        </>
      }
    />
  );
}

/** Dải cảnh báo Drive cho admin khi mở app (Drive đầy, mất quyền, số mục giảm bất thường, máy lâu không đồng bộ, E-021). */
export function DriveAlertBannerView({ alerts, onSeen, error, className }: { alerts: DriveAlert[]; onSeen: () => void; error?: string; className?: string }) {
  if (!alerts.length) return null;
  const urgent = alerts.some((a) => a.kind === 'drive_full' || a.kind === 'drive_no_access');
  return (
    <Banner tone={urgent ? 'red' : 'amber'} icon={<TriangleAlert size={16} />} className={className}>
      <span className="flex flex-col gap-[4px]">
        {alerts.map((a) => (
          <span key={a.id}>{alertText(a)}</span>
        ))}
        {error && <span>{error}</span>}
        <button type="button" onClick={onSeen} className="w-fit font-semibold underline">
          Đã xem
        </button>
      </span>
    </Banner>
  );
}

export function DriveAlertBanner({ className = 'mb-[16px]' }: { className?: string }) {
  const sync = useDriveSync();
  const [error, setError] = useState('');
  if (!sync?.alerts.length) return null;
  return <DriveAlertBannerView alerts={sync.alerts} error={error} className={className} onSeen={() => void sync.seeAlerts(sync.alerts.map((a) => a.id)).catch((e) => setError(driveErrorText(e)))} />;
}

export function DriveSyncHost() {
  const sync = useDriveSync();
  const { state } = useSession();
  if (!sync) return null;
  const c = sync.closePending;
  return (
    <>
      <ConflictDialog myName={state?.user?.name} />
      {bootstrapVisible(sync.bootstrap) && <BootstrapScreen progress={sync.bootstrap!} onDismiss={sync.dismissBootstrap} />}
      {c && <ClosePendingDialog pending={c.pending} waiting={c.waiting} onWait={() => void sync.answerClose(true)} onClose={() => void sync.answerClose(false)} />}
    </>
  );
}
