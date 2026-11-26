import { Monitor, MonitorX } from 'lucide-react';
import { cx } from '../../../components/ui/cx';
import { IS_HSDESK } from '../../../lib/catalog';
import type { AdminDevice, LicenseView } from '../admin-api';
import { STATUS_CHIP, usedText, type SeatTone } from '../devices-view';
import { fmtDayTime } from '../format';
import { PhoneCard } from './parts';

const SEAT: Record<SeatTone, string> = { in_use: 'bg-green', overdue: 'bg-amber', free: 'bg-[#E0E3E8]' };

/** Mỗi chỗ một ô theo số máy bản quyền đã dùng (Worker tính): quá hạn offline vẫn chiếm chỗ (cam), còn lại là chỗ trống. */
function seats(license: LicenseView, devices: AdminDevice[]): SeatTone[] {
  const overdue = Math.min(license.used, devices.filter((d) => d.status === 'offline_overdue').length);
  return Array.from({ length: Math.max(license.maxDevices, license.used) }, (_, i) => (i < license.used - overdue ? 'in_use' : i < license.used ? 'overdue' : 'free'));
}

/** Máy & bản quyền trên điện thoại (TD9Ak): thẻ chỗ dùng + mỗi máy một thẻ có nút Thu hồi. */
export function DevicesPhone({ license, devices, nowSec, busy, reactivating, onRevoke, onReactivate }: { license: LicenseView; devices: AdminDevice[]; nowSec: number; busy?: boolean; /** Id máy đang kích hoạt lại. */ reactivating?: string | null; onRevoke: (d: AdminDevice) => void; onReactivate: (d: AdminDevice) => void }) {
  return (
    <>
      <PhoneCard className="gap-[6px] p-[12px]">
        <span className="text-[22px] font-bold">{usedText(license)}</span>
        <div className="flex h-[8px] w-full gap-[3px]">
          {seats(license, devices).map((t, i) => (
            <span key={i} className={cx('h-[8px] min-w-0 flex-1 rounded-[4px]', SEAT[t])} />
          ))}
        </div>
        <p className="text-[11.5px] text-text-3">{IS_HSDESK ? 'Máy Vipo và máy quá hạn offline vẫn tính vào số máy.' : 'Máy quá hạn offline vẫn tính vào số máy.'}</p>
      </PhoneCard>
      {devices.map((d) => {
        const chip = STATUS_CHIP[d.status];
        const days = Math.round((nowSec - d.last_seen) / 86400);
        // Khung pen ngăn tên người và "kết nối cuối" bằng hai dấu cách hai bên chấm giữa.
        const meta = `${d.last_user_name ? `${d.last_user_name}  ·  ` : ''}kết nối cuối ${fmtDayTime(d.last_seen, nowSec)}${d.status === 'offline_overdue' ? ` · ${days} ngày` : ''}`;
        return (
          <PhoneCard key={d.id} className={cx('gap-[8px] px-[14px] py-[12px]', d.status === 'revoked' && 'opacity-60')}>
            <div className="flex items-center gap-[8px]">
              <Monitor size={15} className="shrink-0 text-text-2" />
              <span className="min-w-0 flex-1 font-mono text-[13px] font-semibold">{d.name}</span>
              <span className={cx('flex items-center rounded-[5px] px-[7px] py-[2px] text-[10.5px] font-semibold', chip.cls)}>{chip.label}</span>
            </div>
            <p className="text-[12px] whitespace-pre text-text-2">{meta}</p>
            {d.status === 'revoked' ? (
              <button type="button" disabled={busy} aria-busy={reactivating === d.id || undefined} onClick={() => onReactivate(d)} className="self-start text-[12px] font-semibold text-text-2 disabled:opacity-50">
                {reactivating === d.id ? 'Đang kích hoạt…' : 'Kích hoạt lại'}
              </button>
            ) : (
              <button type="button" onClick={() => onRevoke(d)} className="stroke-in flex h-[30px] w-fit items-center justify-center gap-[6px] rounded-[8px] bg-surface px-[12px] text-[12.5px] font-semibold text-red [--stroke-c:var(--color-line-red)]">
                <MonitorX size={13} />
                Thu hồi
              </button>
            )}
          </PhoneCard>
        );
      })}
    </>
  );
}
