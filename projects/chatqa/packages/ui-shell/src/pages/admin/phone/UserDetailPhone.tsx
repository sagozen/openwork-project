import { Laptop, Loader2, Lock, LockOpen, LogOut, Monitor, Pencil, Smartphone, KeyRound } from 'lucide-react';
import { Avatar, RoleChip } from '../../../components/ui';
import { cx } from '../../../components/ui/cx';
import type { AdminUserDetail, WebSession } from '../admin-api';
import { appNo, describeUa, fmtAgo, fmtDayTime } from '../format';
import { avatarTone, userInitials } from '../parts';
import { STATUS_VIEW } from '../users-view';
import { PhoneCard } from './parts';

const DEVICE_ICON = { desktop: <Monitor size={15} />, phone: <Smartphone size={15} />, laptop: <Laptop size={15} /> };
const BTN = 'stroke-in flex h-[34px] flex-1 items-center justify-center gap-[6px] rounded-[8px] bg-surface px-[12px] text-[12.5px] font-semibold';

export interface UserDetailPhoneProps {
  user: AdminUserDetail;
  licenseApps: string[];
  nowSec: number;
  onEdit: () => void;
  onReset: () => void;
  onLock: () => void;
  onUnlock: () => void;
  onRevoke: (s: WebSession) => void;
  onRevokeAll: () => void;
  /** Đang mở khoá: nút Mở khoá khoá lại, hiện vòng quay. */
  unlocking?: boolean;
  /** Đang đăng xuất: id phiên, 'all' (tất cả) hoặc null. Đang chạy thì mọi nút phiên khoá. */
  sessionBusy?: string | null;
}

/** Chi tiết người dùng trên điện thoại (IppO8): thẻ hồ sơ + 3 nút, rồi danh sách phiên web có nút đăng xuất từ xa. */
export function UserDetailPhone({ user: u, licenseApps, nowSec, onEdit, onReset, onLock, onUnlock, onRevoke, onRevokeAll, unlocking, sessionBusy: busy }: UserDetailPhoneProps) {
  const spin = (n: number) => <Loader2 size={n} className="animate-spin" aria-hidden />;
  const apps = u.role === 'vipo' ? 'Chỉ màn Gửi yêu cầu' : `App ${(u.apps ?? licenseApps).slice().sort((a, b) => appNo(a).localeCompare(appNo(b))).map(appNo).join(', ')}`;
  const meta = [apps, STATUS_VIEW[u.status].label, u.last_device].filter(Boolean).join(' · ');
  return (
    <>
      <PhoneCard className="gap-[10px] p-[14px]">
        <div className="flex items-center gap-[12px]">
          <Avatar initials={userInitials(u)} tone={avatarTone(u)} size={42} fontSize={13} />
          <div className="flex min-w-0 flex-col gap-[3px]">
            <span className="truncate text-[15px] font-bold">{u.display_name}</span>
            <span className="flex items-center gap-[6px]">
              <span className="font-mono text-[11.5px] text-text-3">{u.username}</span>
              <RoleChip role={u.role} className="!px-[7px] !py-[2px] !text-[10.5px]" />
            </span>
          </div>
        </div>
        <p className="text-[12px] text-text-2">{meta}</p>
        <div className="flex gap-[6px]">
          <button type="button" onClick={onEdit} className={BTN}>
            <Pencil size={13} />
            Sửa
          </button>
          <button type="button" onClick={onReset} className={BTN}>
            <KeyRound size={13} />
            Đặt lại MK
          </button>
          {u.status === 'locked' ? (
            <button type="button" disabled={unlocking} aria-busy={unlocking || undefined} onClick={onUnlock} className={cx(BTN, 'disabled:opacity-50')}>
              {unlocking ? spin(13) : <LockOpen size={13} />}
              {unlocking ? 'Đang mở khoá…' : 'Mở khoá'}
            </button>
          ) : (
            <button type="button" onClick={onLock} className={cx(BTN, 'text-red [--stroke-c:var(--color-line-red)]')}>
              <Lock size={13} />
              Khoá
            </button>
          )}
        </div>
      </PhoneCard>
      <h2 className="text-[11px] font-bold tracking-[1px] text-text-3">PHIÊN WEB ĐANG MỞ</h2>
      {u.web_sessions.map((s) => {
        const dev = describeUa(s.ua);
        return (
          <PhoneCard key={s.id} className="flex-row items-center gap-[10px] px-[14px] py-[11px]">
            <span className="flex h-[32px] w-[32px] shrink-0 items-center justify-center rounded-[8px] bg-chip-neutral text-text-2">{DEVICE_ICON[dev.kind]}</span>
            <span className="flex min-w-0 flex-1 flex-col gap-px">
              <span className="truncate text-[13px] font-semibold">{dev.name}</span>
              <span className="text-[11.5px] text-text-3">
                {fmtDayTime(s.last_seen, nowSec)} · {fmtAgo(s.last_seen, nowSec)}
              </span>
            </span>
            <button type="button" aria-label={`Đăng xuất từ xa ${dev.name}`} disabled={!!busy} aria-busy={busy === s.id || undefined} onClick={() => onRevoke(s)} className="stroke-in flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[8px] text-red disabled:opacity-50">
              {busy === s.id ? spin(15) : <LogOut size={15} />}
            </button>
          </PhoneCard>
        );
      })}
      {!u.web_sessions.length && <p className="text-[12px] text-text-3">Không có phiên web nào đang mở.</p>}
      <button type="button" disabled={!u.web_sessions.length || !!busy} aria-busy={busy === 'all' || undefined} onClick={onRevokeAll} className="stroke-in flex h-[34px] w-full items-center justify-center gap-[6px] rounded-[8px] bg-surface px-[12px] text-[12.5px] font-semibold text-red [--stroke-c:var(--color-line-red)] disabled:opacity-50">
        {busy === 'all' ? spin(13) : <LogOut size={13} />}
        {busy === 'all' ? 'Đang đăng xuất…' : 'Đăng xuất tất cả phiên web'}
      </button>
    </>
  );
}
