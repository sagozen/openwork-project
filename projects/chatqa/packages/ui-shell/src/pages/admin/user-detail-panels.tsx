// Các khối của trang chi tiết người dùng trên web/Windows (JNC1E, TJ5Yj): hồ sơ, phiên web đang mở, lịch sử gần đây.
import { Info, Laptop, Loader2, LogOut, Monitor, Smartphone } from 'lucide-react';
import { RoleChip } from '../../components/ui';
import { cx } from '../../components/ui/cx';
import type { AppCode } from '../../platform/types';
import type { AdminUserDetail, WebSession } from './admin-api';
import type { AuditRow } from './audit-format';
import { appNo, describeUa, fmtAgo, fmtDayTime, maskIp } from './format';
import { UserAvatar } from './parts';
import { STATUS_VIEW } from './users-view';

const KV = 'flex w-full flex-col gap-[6px] pt-[12px] shadow-[inset_0_1px_0_var(--color-divider)]';
const KV_LABEL = 'text-[9px] font-bold tracking-[0.5px] whitespace-nowrap text-text-3';
const DEVICE_ICON = { desktop: <Monitor size={16} />, phone: <Smartphone size={16} />, laptop: <Laptop size={16} /> };

export function ProfilePanel({ u, licenseApps, nowSec }: { u: AdminUserDetail; licenseApps: AppCode[]; nowSec: number }) {
  return (
      <div className="stroke-in flex w-[340px] shrink-0 flex-col gap-[16px] rounded-[12px] bg-surface p-[20px]">
        <div className="flex w-full items-center gap-[12px]">
          <UserAvatar user={u} size={48} />
          <div className="flex min-w-0 flex-col gap-[3px]">
            <span className="text-[16px] font-bold whitespace-nowrap text-text">{u.display_name}</span>
            <span className="font-mono text-[12px] whitespace-nowrap text-text-2">{u.username}</span>
          </div>
        </div>
        <div className={KV}>
          <span className={KV_LABEL}>VAI</span>
          <span className="flex">
            <RoleChip role={u.role} className="!px-[8px] !text-[11px]" />
          </span>
        </div>
        <div className={KV}>
          <span className={KV_LABEL}>APP ĐƯỢC CẤP</span>
          <div className="flex flex-wrap gap-[6px]">
            {u.role === 'vipo' ? (
              <span className="text-[12.5px] text-text">Chỉ màn Gửi yêu cầu</span>
            ) : (
              (u.apps ?? licenseApps).map((c) => (
                <span key={c} className="stroke-in rounded-[5px] px-[7px] py-[2px] text-[11px] font-semibold whitespace-nowrap text-text [--stroke-c:var(--color-text-3)]">
                  App {appNo(c)}
                </span>
              ))
            )}
          </div>
        </div>
        <div className={KV}>
          <span className={KV_LABEL}>TRẠNG THÁI</span>
          <span className={cx('flex items-center gap-[6px] text-[12.5px] font-semibold', { green: 'text-green', amber: 'text-amber', red: 'text-red' }[STATUS_VIEW[u.status].tone])}>
            <span className="h-[7px] w-[7px] rounded-full bg-current" />
            {STATUS_VIEW[u.status].label}
          </span>
        </div>
        <div className={KV}>
          <span className={KV_LABEL}>MÁY GẦN NHẤT</span>
          <span className="text-[12.5px] text-text">{u.last_device ? `${u.last_device}${u.last_login_at ? ` · ${fmtDayTime(u.last_login_at, nowSec)}` : ''}` : '—'}</span>
        </div>
        <div className={KV}>
          <span className={KV_LABEL}>LẦN ĐĂNG NHẬP CUỐI</span>
          <span className="text-[12.5px] text-text">{u.last_login_at ? fmtDayTime(u.last_login_at, nowSec) : 'Chưa đăng nhập'}</span>
        </div>
      </div>
  );
}

export function SessionsPanel({ u, nowSec, busy, onRevoke, onRevokeAll }: { u: AdminUserDetail; nowSec: number; /** Đang đăng xuất: id phiên, 'all' (tất cả) hoặc null. Đang chạy thì mọi nút khoá. */ busy?: string | null; onRevoke: (s: WebSession) => void; onRevokeAll: () => void }) {
  const spin = <Loader2 size={13} className="animate-spin" aria-hidden />;
  return (
    <div className="stroke-in flex w-full flex-col overflow-hidden rounded-[12px] bg-surface">
      <div className="flex h-[61px] items-center gap-[10px] px-[18px] py-[14px] shadow-[inset_0_-1px_0_var(--color-border)]">
        <div className="flex min-w-0 flex-1 flex-col gap-[2px]">
          <span className="text-[13px] font-bold whitespace-nowrap text-text">Phiên web đang mở</span>
          <span className="text-[11.5px] whitespace-nowrap text-text-3">Phiên trên trình duyệt. App Windows không nằm trong danh sách này.</span>
        </div>
        <button type="button" disabled={!u.web_sessions.length || !!busy} aria-busy={busy === 'all' || undefined} onClick={() => onRevokeAll()} className="stroke-in flex h-[32px] shrink-0 items-center gap-[6px] rounded-[7px] px-[12px] text-[12px] font-semibold whitespace-nowrap text-red [--stroke-c:var(--color-line-red)] disabled:opacity-50">
          {busy === 'all' ? spin : <LogOut size={13} />}
          {busy === 'all' ? 'Đang đăng xuất…' : 'Đăng xuất tất cả'}
        </button>
      </div>
      <div className="flex h-[29px] items-center gap-[14px] bg-table-head px-[18px] py-[9px] shadow-[inset_0_-1px_0_var(--color-border)]">
        <span className="min-w-0 flex-1 text-[9px]/[11px] font-bold tracking-[0.5px] text-text-3">THIẾT BỊ</span>
        <span className="w-[200px] shrink-0 text-[9px]/[11px] font-bold tracking-[0.5px] text-text-3">LẦN HOẠT ĐỘNG CUỐI</span>
        <span className="w-[150px] shrink-0" />
      </div>
      {u.web_sessions.map((s) => {
        const dev = describeUa(s.ua);
        return (
          <div key={s.id} className="flex items-center gap-[14px] px-[18px] py-[12px] shadow-[inset_0_-1px_0_var(--color-divider)]">
            <div className="flex min-w-0 flex-1 items-center gap-[10px]">
              <span className="flex h-[32px] w-[32px] shrink-0 items-center justify-center rounded-[8px] bg-chip-neutral text-text-2">{DEVICE_ICON[dev.kind]}</span>
              <div className="flex min-w-0 flex-col gap-px">
                <span className="text-[12.5px] font-semibold whitespace-nowrap text-text">{dev.name}</span>
                {s.ip_hint && <span className="text-[11px] whitespace-nowrap text-text-3">{maskIp(s.ip_hint)}</span>}
              </div>
            </div>
            <div className="flex w-[200px] shrink-0 flex-col gap-px">
              <span className="text-[12.5px] whitespace-nowrap text-text">{fmtDayTime(s.last_seen, nowSec)}</span>
              <span className="text-[11px] whitespace-nowrap text-text-3">{fmtAgo(s.last_seen, nowSec)}</span>
            </div>
            <div className="flex w-[150px] shrink-0 justify-end">
              <button type="button" disabled={!!busy} aria-busy={busy === s.id || undefined} onClick={() => onRevoke(s)} className="stroke-in flex h-[30px] items-center gap-[6px] rounded-[7px] px-[12px] text-[12px] font-semibold whitespace-nowrap text-text disabled:opacity-50">
                {busy === s.id ? spin : <LogOut size={13} />}
                {busy === s.id ? 'Đang đăng xuất…' : 'Đăng xuất từ xa'}
              </button>
            </div>
          </div>
        );
      })}
      {!u.web_sessions.length && <p className="px-[18px] py-[14px] text-[12px] text-text-3">Không có phiên web nào đang mở.</p>}
      <div className="flex w-full items-center gap-[8px] px-[18px] py-[12px]">
        <Info size={13} className="shrink-0 text-text-3" />
        <p className="text-[11.5px] whitespace-nowrap text-text-3">Đăng xuất từ xa có hiệu lực ngay. Đặt lại mật khẩu hoặc khoá tài khoản cũng đóng mọi phiên web.</p>
      </div>
    </div>
  );
}

export function HistoryPanel({ history }: { history: AuditRow[] }) {
  return (
    <div className="stroke-in flex w-full flex-col overflow-hidden rounded-[12px] bg-surface">
      <div className="flex h-[40px] items-center px-[18px] shadow-[inset_0_-1px_0_var(--color-border)]">
        <span className="text-[13px] font-bold text-text">Lịch sử gần đây</span>
      </div>
      {history.map((r) => (
        <div key={r.id} className="flex items-center gap-[14px] px-[18px] py-[9px] shadow-[inset_0_-1px_0_var(--color-divider)]">
          <span className="w-[104px] shrink-0 font-mono text-[11.5px] text-text-2">{r.time}</span>
          <span className="w-[170px] shrink-0 truncate text-[12.5px] whitespace-nowrap text-text">
            {r.actor.name}
            {r.actor.locked && <span className="text-red"> (Đã khoá)</span>}
          </span>
          <span className="w-[170px] shrink-0 text-[12.5px] font-semibold text-text">{r.action}</span>
          <span className="min-w-0 flex-1 truncate text-[12px] text-text-3">
            {r.before} → <span className="text-text">{r.after}</span>
          </span>
        </div>
      ))}
    </div>
  );
}
