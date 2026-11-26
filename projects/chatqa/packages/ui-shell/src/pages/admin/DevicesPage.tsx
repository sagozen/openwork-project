import { useEffect, useState } from 'react';
import { Monitor, MonitorX, RefreshCw } from 'lucide-react';
import { Avatar, Banner, Button, Dialog } from '../../components/ui';
import { cx } from '../../components/ui/cx';
import { NetProgress } from '../../components/NetProgress';
import type { AppCode } from '../../platform/types';
import { IS_HSDESK } from '../../lib/catalog';
import { useAction } from '../../lib/use-action';
import { adminApi, type AdminDevice, type AdminUser, type LicenseView } from './admin-api';
import { toAdminError, writeOnline } from './admin-error';
import { demoState } from './demo';
import { freeAfterRevoke, leftText, offlineDays, seatSegments, STATUS_CHIP, usedText, type SeatTone } from './devices-view';
import { appsText, fmtAgo, fmtDayTime, fmtShort } from './format';
import { usePhoneLayout } from './admin-context';
import { AdminPage, avatarTone, ErrorBanner, userInitials } from './parts';
import { DevicesPhone } from './phone/DevicesPhone';
import { PhoneAdminPage } from './phone/parts';
import { useResource } from './use-resource';

const SEAT: Record<SeatTone, string> = { in_use: 'bg-green', overdue: 'bg-amber', free: 'bg-[#E0E3E8]' };
const HEAD = 'text-[9px]/[11px] font-bold tracking-[0.5px] text-text-3';

export interface RevokeViewProps {
  device: AdminDevice;
  license: Pick<LicenseView, 'used' | 'maxDevices'>;
  lastUser: string;
  nowSec: number;
  error?: unknown;
  busy?: boolean;
  onClose?: () => void;
  onConfirm?: () => void;
  overlay?: boolean;
}

/** Hộp xác nhận thu hồi máy (HuMtq). */
export function RevokeDialogView({ device, license, lastUser, nowSec, error, busy, onClose, onConfirm, overlay }: RevokeViewProps) {
  const overdue = device.status === 'offline_overdue';
  const facts: [string, string, string?][] = [
    ['Lần kết nối cuối', `${fmtShort(device.last_seen)} · ${fmtAgo(device.last_seen, nowSec)}`, overdue ? 'font-bold text-amber' : 'font-medium text-text'],
    ['Người đăng nhập gần nhất', lastUser || '—'],
    ['Trạng thái', STATUS_CHIP[device.status].label],
  ];
  return (
    <Dialog
      overlay={overlay}
      width={500}
      gap={14}
      tone="red"
      icon={<MonitorX size={18} />}
      title={`Thu hồi máy ${device.name}?`}
      subtitle={`Sau khi thu hồi, công ty còn ${freeAfterRevoke(license)} máy trống`}
      onClose={onClose && (() => !busy && onClose())}
      actions={
        <>
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            Hủy
          </Button>
          <Button loading={busy} onClick={onConfirm} className="!bg-red">
            {busy ? 'Đang thu hồi…' : 'Thu hồi máy'}
          </Button>
        </>
      }
    >
      <ErrorBanner error={error} />
      <div className="stroke-in flex w-full flex-col rounded-[8px]">
        {facts.map(([k, v, cls], i) => (
          <div key={k} className={cx('flex items-center px-[14px] py-[10px]', i < facts.length - 1 && 'shadow-[inset_0_-1px_0_var(--color-divider)]')}>
            <span className="min-w-0 flex-1 text-[12px] text-text-3">{k}</span>
            <span className={cx('text-[12.5px] whitespace-nowrap', cls ?? 'font-medium text-text')}>{v}</span>
          </div>
        ))}
      </div>
      {IS_HSDESK ? (
        <>
          <Banner tone="amber">Thay đổi chưa đồng bộ trên máy này chỉ lên Drive nếu máy còn kết nối lại.</Banner>
          <p className="w-full text-[12px]/[17px] text-text-3">Máy bị khoá ở lần kết nối tới, sau khi đẩy thay đổi chờ lên Drive một lần, và báo “Máy này đã bị thu hồi bản quyền”. Muốn dùng lại phải kích hoạt lại.</p>
        </>
      ) : (
        <p className="w-full text-[12px]/[17px] text-text-3">Máy bị khoá ở lần kết nối tới và báo “Máy này đã bị thu hồi bản quyền”. Muốn dùng lại phải kích hoạt lại.</p>
      )}
    </Dialog>
  );
}

export default function DevicesPage() {
  const res = useResource(async () => {
    const [license, devices, users] = await Promise.all([adminApi.license(), adminApi.devices(), adminApi.users().catch(() => [] as AdminUser[])]);
    return { license, devices, users };
  });
  const [revoke, setRevoke] = useState<AdminDevice | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [dialogError, setDialogError] = useState<unknown>(null);
  // Máy đang được kích hoạt lại (hiện "Đang kích hoạt…" đúng dòng đó).
  const [reactivating, setReactivating] = useState<string | null>(null);
  const phone = usePhoneLayout();
  const nowSec = Math.floor(Date.now() / 1000);
  const d = res.data;
  const userOf = (dev: AdminDevice) => d?.users.find((u) => u.id === dev.last_user_id);

  useEffect(() => {
    if (import.meta.env.DEV && demoState() === 'dialog-revoke' && d) setRevoke(d.devices.find((x) => x.name === 'PC-KHO-01') ?? null);
  }, [d]);

  // Thu hồi và kích hoạt lại dùng chung một cờ: đang ghi thì mọi nút ghi khoá, lần bấm tiếp bị bỏ qua.
  const [run, busy] = useAction(async (fn: () => Promise<unknown>, onError: (e: unknown) => void, after?: () => void, pendingId?: string) => {
    onError(null);
    setReactivating(pendingId ?? null);
    try {
      await writeOnline(fn);
      after?.();
      await res.reload();
    } catch (e) {
      onError(toAdminError(e));
    } finally {
      setReactivating(null);
    }
  });
  const reactivate = (dev: AdminDevice) => void run(() => adminApi.reactivateDevice(dev.id), setError, undefined, dev.id);

  const revokeDialog =
    revoke && d ? (
      <RevokeDialogView
        device={revoke}
        license={d.license}
        lastUser={revoke.last_user_name ?? ''}
        nowSec={nowSec}
        error={dialogError}
        busy={busy}
        onClose={() => setRevoke(null)}
        onConfirm={() => void run(() => adminApi.revokeDevice(revoke.id), setDialogError, () => setRevoke(null))}
      />
    ) : null;

  if (phone) {
    return (
      <PhoneAdminPage title="Máy & bản quyền" body="gap-[8px] px-[16px] py-[12px]" error={res.error ?? error}>
        {d && <DevicesPhone license={d.license} devices={d.devices} nowSec={nowSec} busy={busy} reactivating={reactivating} onRevoke={(dev) => (setDialogError(null), setRevoke(dev))} onReactivate={reactivate} />}
        <NetProgress op="admin.devices-load" active={!d && res.loading} label="Đang tải danh sách máy và bản quyền" className="self-center py-16" />
        {revokeDialog}
      </PhoneAdminPage>
    );
  }

  return (
    <AdminPage
      tab="devices"
      gap={16}
      crumb="Cài đặt › Máy & bản quyền · chỉ Admin"
      title="Máy & bản quyền"
      actions={
        <div className="flex items-center gap-[12px]">
          <NetProgress op="admin.devices-load" active={!!d && res.loading} label="Đang tải lại danh sách máy" />
          <Button variant="secondary" icon={<RefreshCw size={15} />} loading={res.loading} onClick={() => void res.reload()}>
            Tải lại
          </Button>
        </div>
      }
    >
      <ErrorBanner error={res.error ?? error} />
      <NetProgress op="admin.devices-load" active={!d && res.loading} label="Đang tải danh sách máy và bản quyền" className="self-center py-16" />
      {d && (
        <>
          <div className="stroke-in flex w-full items-center gap-[32px] rounded-[12px] bg-surface p-[20px]">
            <div className="flex w-[360px] shrink-0 flex-col gap-[10px]">
              <div className="flex items-end gap-[8px]">
                <span className="text-[26px] font-bold tracking-[-0.5px] whitespace-nowrap text-text">{usedText(d.license)}</span>
                <span className="text-[12px] whitespace-nowrap text-text-3">{leftText(d.license)}</span>
              </div>
              <div className="flex h-[8px] w-full gap-[3px] rounded-[4px] bg-stage">
                {seatSegments(d.license.maxDevices, d.devices).map((t, i) => (
                  <span key={i} className={cx('h-[8px] min-w-0 flex-1 rounded-[4px]', SEAT[t])} />
                ))}
              </div>
              <p className="w-full text-[11.5px] text-text-3">{IS_HSDESK ? 'Máy Vipo và máy quá hạn offline vẫn tính vào số máy cho tới khi thu hồi.' : 'Máy quá hạn offline vẫn tính vào số máy cho tới khi thu hồi.'}</p>
            </div>
            {(
              [
                ['Mã bản quyền', d.license.keyMasked, true],
                ['App đã kích hoạt', appsText(d.license.apps as AppCode[]), false],
                ['Khoá máy khi offline quá', `${offlineDays(d.license.offlineHours)} ngày`, false],
              ] as const
            ).map(([k, v, mono]) => (
              <div key={k} className="flex min-w-0 flex-1 flex-col gap-[4px]">
                <span className="text-[11px] whitespace-nowrap text-text-3">{k}</span>
                <span className={cx('text-[13px] font-semibold whitespace-nowrap text-text', mono && 'font-mono')}>{v}</span>
              </div>
            ))}
          </div>

          <div className="stroke-in flex w-full flex-col overflow-hidden rounded-[12px] bg-surface">
            <div className="flex h-[29px] items-center gap-[12px] bg-table-head px-[18px] py-[9px] shadow-[inset_0_-1px_0_var(--color-border)]">
              <span className={cx('min-w-0 flex-1', HEAD)}>TÊN MÁY</span>
              <span className={cx('w-[260px] shrink-0', HEAD)}>NGƯỜI ĐĂNG NHẬP GẦN NHẤT</span>
              <span className={cx('w-[200px] shrink-0', HEAD)}>LẦN KẾT NỐI CUỐI</span>
              <span className={cx('w-[170px] shrink-0', HEAD)}>TRẠNG THÁI</span>
              <span className="w-[110px] shrink-0" />
            </div>
            {d.devices.map((dev) => {
              const u = userOf(dev);
              const chip = STATUS_CHIP[dev.status];
              const vipo = u?.role === 'vipo';
              return (
                <div key={dev.id} className={cx('flex items-center gap-[12px] px-[18px] py-[11px] shadow-[inset_0_-1px_0_var(--color-divider)]', dev.status === 'revoked' && 'opacity-60')}>
                  <div className="flex min-w-0 flex-1 items-center gap-[10px]">
                    <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[8px] bg-chip-neutral text-text-2">
                      <Monitor size={15} />
                    </span>
                    <div className="flex min-w-0 flex-col gap-px">
                      <span className="font-mono text-[12.5px] font-semibold whitespace-nowrap text-text">{dev.name}</span>
                      <span className="text-[10.5px] whitespace-nowrap text-text-3">
                        {dev.app_version ? `Phiên bản ${dev.app_version}` : '—'}
                        {IS_HSDESK && vipo ? ' · máy của Vipo' : ''}
                      </span>
                    </div>
                  </div>
                  <div className="flex w-[260px] shrink-0 items-center gap-[8px]">
                    {dev.last_user_name ? (
                      <>
                        <Avatar initials={u ? userInitials(u) : dev.last_user_name.slice(0, 2).toUpperCase()} tone={u ? avatarTone(u) : 'staff'} size={24} />
                        <span className="min-w-0 truncate text-[12.5px] text-text">{dev.last_user_name}</span>
                      </>
                    ) : (
                      <span className="text-[12.5px] text-text-3">—</span>
                    )}
                  </div>
                  <div className="flex w-[200px] shrink-0 flex-col gap-px">
                    <span className="text-[12.5px] whitespace-nowrap text-text">{fmtDayTime(dev.last_seen, nowSec)}</span>
                    <span className={cx('text-[10.5px] whitespace-nowrap', dev.status === 'offline_overdue' ? 'text-amber' : 'text-text-3')}>{fmtAgo(dev.last_seen, nowSec)}</span>
                  </div>
                  <div className="flex w-[170px] shrink-0">
                    <span className={cx('flex items-center gap-[5px] rounded-[5px] px-[8px] py-[3px] text-[11px] font-semibold whitespace-nowrap', chip.cls)}>
                      <span className={cx('h-[6px] w-[6px] rounded-full', chip.dot)} />
                      {chip.label}
                    </span>
                  </div>
                  <div className="flex w-[110px] shrink-0 justify-end">
                    {dev.status === 'revoked' ? (
                      <button type="button" disabled={busy} aria-busy={reactivating === dev.id || undefined} onClick={() => reactivate(dev)} className="text-[12px] font-semibold whitespace-nowrap text-text-2 hover:text-text disabled:opacity-50">
                        {reactivating === dev.id ? 'Đang kích hoạt…' : 'Kích hoạt lại'}
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => (setDialogError(null), setRevoke(dev))}
                        className={cx('flex h-[30px] items-center gap-[6px] stroke-in rounded-[7px] px-[12px] text-[12px] font-semibold whitespace-nowrap text-red', dev.status === 'offline_overdue' ? 'bg-red-soft [--stroke-c:var(--color-red)]' : 'bg-surface [--stroke-c:var(--color-line-red)]')}
                      >
                        <MonitorX size={13} />
                        Thu hồi
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
      {revokeDialog}
    </AdminPage>
  );
}

