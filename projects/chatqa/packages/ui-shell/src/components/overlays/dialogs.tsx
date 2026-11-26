// Hộp thoại và khoá màn dùng chung (khung h4Lox0, foqrE, qVhzb). Thuần hiển thị: nhận chữ + hàm xử lý qua props
// để cả màn thật (SessionOverlays) và bảng so ảnh dùng cùng một thành phần.
import { useEffect, useRef, type ReactNode } from 'react';
import { CloudUpload, ClockAlert, Hourglass, CircleX, Lock, MonitorX, PowerOff, RefreshCw, WifiOff } from 'lucide-react';
import limits from '@contracts/limits.json';
import { Button, Dialog } from '../ui';
import { cx } from '../ui/cx';
import { NetProgress } from '../NetProgress';

const rows = 'flex flex-col gap-[14px]';

// ---------- E-005 phiên hết hạn (foqrE) ----------

export interface SessionExpiredProps {
  username: string;
  password: string;
  onPassword: (v: string) => void;
  /** Tên đăng nhập chưa biết (mở lại app sau khi phiên hết hạn): cho nhập tay. */
  onUsername?: (v: string) => void;
  error?: string;
  busy?: boolean;
  /** Thao tác đang chạy (nút đó hiện vòng quay); cả hai nút khoá khi `busy`. */
  pending?: 'relogin' | 'logout' | null;
  text: string;
  onRelogin: () => void;
  onLogout: () => void;
  overlay?: boolean;
  /** 440 ở màn thật (foqrE), 420 trong bảng hộp dùng chung (h4Lox0). */
  width?: number;
}

/** Hộp đăng nhập lại đè lên màn đang làm: không chuyển trang, không mất form đang gõ. */
export function SessionExpiredDialog(p: SessionExpiredProps) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <Dialog
      variant="compact"
      width={p.width ?? 440}
      overlay={p.overlay}
      tone="blue"
      icon={<ClockAlert size={18} />}
      title="Phiên đăng nhập đã hết hạn"
      actions={
        <>
          <Button size="dialog" variant="secondary" onClick={p.onLogout} disabled={p.busy} loading={p.pending === 'logout'}>
            Đăng xuất
          </Button>
          <Button size="dialog" onClick={p.onRelogin} disabled={p.busy} loading={p.pending === 'relogin'}>
            {p.pending === 'relogin' ? 'Đang đăng nhập…' : 'Đăng nhập lại'}
          </Button>
        </>
      }
    >
      <form
        className={rows}
        onSubmit={(e) => {
          e.preventDefault();
          if (!p.busy) p.onRelogin();
        }}
      >
        <p>{p.text}</p>
        <div className="flex gap-[8px]">
          {p.onUsername ? (
            <input
              value={p.username}
              onChange={(e) => p.onUsername?.(e.target.value)}
              placeholder="Tên đăng nhập"
              autoComplete="username"
              className="stroke-in h-[38px] w-[130px] shrink-0 rounded-[8px] bg-surface px-[10px] font-mono text-[12px]/[16px] text-text outline-none placeholder:font-sans placeholder:text-text-3"
            />
          ) : (
            <span className="stroke-in flex h-[38px] w-[130px] shrink-0 items-center rounded-[8px] bg-disabled-bg px-[10px] font-mono text-[12px]/[16px] text-text-2">{p.username}</span>
          )}
          <input
            ref={ref}
            type="password"
            value={p.password}
            onChange={(e) => p.onPassword(e.target.value)}
            placeholder="Mật khẩu"
            autoComplete="current-password"
            className="stroke-in h-[38px] min-w-0 flex-1 rounded-[8px] bg-surface px-[10px] text-[12.5px]/[16px] text-text outline-none [--stroke-c:var(--color-text-3)] placeholder:text-text-3"
          />
        </div>
        {p.error && (
          <p role="alert" className="text-[12px]/[16px] font-medium text-red">
            {p.error}
          </p>
        )}
        <NetProgress op="auth.relogin" active={p.pending === 'relogin'} label="Đang đăng nhập lại" />
      </form>
    </Dialog>
  );
}

// ---------- E-019 bị khoá khi đang dùng ----------

export function LockedOutDialog({ text, onLogout, overlay }: { text: string; onLogout: () => void; overlay?: boolean }) {
  return (
    <Dialog variant="compact" overlay={overlay} tone="red" icon={<Lock size={18} />} title="Tài khoản đã bị khoá" actions={<Button size="dialog" onClick={onLogout}>Đăng xuất</Button>}>
      {text}
    </Dialog>
  );
}

// ---------- E-016 máy bị thu hồi ----------

export function RevokedDialog({ text, onClose, overlay }: { text: string; onClose: () => void; overlay?: boolean }) {
  return (
    <Dialog variant="compact" overlay={overlay} tone="red" icon={<MonitorX size={18} />} title="Máy đã bị thu hồi" actions={<Button size="dialog" onClick={onClose}>Đóng app</Button>}>
      {text}
    </Dialog>
  );
}

// ---------- E-017 app bị tắt khỏi bản quyền ----------

export function AppDisabledDialog({ name, text, onBack, overlay }: { name: string; text: string; onBack: () => void; overlay?: boolean }) {
  return (
    <Dialog variant="compact" overlay={overlay} tone="gray" icon={<PowerOff size={18} />} title={`${name} không còn dùng được`} actions={<Button size="dialog" onClick={onBack}>Về màn chọn app</Button>}>
      {text}
    </Dialog>
  );
}

// ---------- Đăng xuất khi còn việc chờ đồng bộ ----------

export function logoutPendingText(n: number) {
  return `Còn ${n} mục chưa đồng bộ lên Drive. Dữ liệu vẫn giữ trên máy và tự đẩy lên Drive khi máy có mạng, không cần ai đăng nhập lại.`;
}

export function LogoutPendingDialog({ n, onStay, onLogout, busy, overlay }: { n: number; onStay: () => void; onLogout: () => void; busy?: boolean; overlay?: boolean }) {
  return (
    <Dialog
      variant="compact"
      overlay={overlay}
      tone="amber"
      icon={<CloudUpload size={18} />}
      title={`Còn ${n} mục chờ đồng bộ`}
      actions={
        <>
          <Button size="dialog" variant="secondary" onClick={onStay} disabled={busy}>
            Ở lại
          </Button>
          <Button size="dialog" onClick={onLogout} loading={busy}>
            {busy ? 'Đang đăng xuất…' : 'Vẫn đăng xuất'}
          </Button>
        </>
      }
    >
      {logoutPendingText(n)}
    </Dialog>
  );
}

// ---------- E-006 khoá vì quá hạn offline (qVhzb) ----------

export const OFFLINE_LIMIT_DAYS = Math.round(limits.offlineHours / 24);

export interface OfflineLockProps {
  title: string;
  text: string;
  limitDays?: number;
  pending: number;
  busy?: boolean;
  onRetry: () => void;
  onLogout: () => void;
  /** Vị trí: phủ vùng dưới thanh tiêu đề (cửa sổ thật) hoặc tự do (bảng so ảnh). */
  className?: string;
}

/** Che toàn màn dưới thanh tiêu đề: nền #0E1014F2 mờ 6px. Dữ liệu vẫn nằm trên máy. */
export function OfflineLockScreen(p: OfflineLockProps) {
  return (
    <div role="alertdialog" aria-modal="true" aria-label={p.title} className={cx('fixed inset-x-0 top-[42px] bottom-0 z-50 flex flex-col items-center justify-center gap-[16px] bg-[#0E1014F2] backdrop-blur-[6px]', p.className)}>
      <span className="flex h-[72px] w-[72px] items-center justify-center rounded-full bg-sidebar-hover text-avatar-admin-text">
        <WifiOff size={32} />
      </span>
      <h2 className="text-[28px]/[normal] font-bold tracking-[-0.4px] text-white">{p.title}</h2>
      <p className="w-[520px] text-center text-[15px]/[23px] text-chrome-control">{p.text}</p>
      <div className="flex gap-[10px] pt-[8px]">
        <Button size="lg" icon={<RefreshCw size={15} className={p.busy ? 'animate-spin' : ''} />} onClick={p.onRetry} disabled={p.busy}>
          Thử kết nối lại
        </Button>
        <button type="button" onClick={p.onLogout} disabled={p.busy} className="stroke-in h-[40px] rounded-[8px] px-[18px] text-[13px]/[16px] font-semibold text-chrome-text [--stroke-c:#3A3E48] hover:bg-white/5 disabled:opacity-50">
          Đăng xuất
        </button>
      </div>
      <p className="text-[12px]/[normal] text-text-3">
        Giới hạn offline do bên triển khai đặt: {p.limitDays ?? OFFLINE_LIMIT_DAYS} ngày · {p.pending} thay đổi đang chờ đồng bộ trên máy
      </p>
    </div>
  );
}

// ---------- E-018 thông báo khi máy kết nối lại ----------

export interface NoticeItem {
  key: string;
  kind: 'rejected' | 'review';
  text: ReactNode;
  action?: ReactNode;
}

/** Bảng nổi: đầu bảng + từng thao tác không được công nhận (đỏ) hoặc đang chờ admin xem (hổ phách). */
export function ReconnectPanel({ title, icon, items, className }: { title: ReactNode; icon?: ReactNode; items: NoticeItem[]; className?: string }) {
  return (
    <div className={cx('flex flex-col rounded-[12px] bg-surface shadow-popup', className)}>
      <div className="flex min-h-[40px] items-center gap-[8px] px-[16px] py-[12px] shadow-[inset_0_-1px_0_var(--color-border)]">
        <span className="flex shrink-0 text-green">{icon ?? <RefreshCw size={14} />}</span>
        <h3 className="text-[12.5px]/[16px] font-bold text-text">{title}</h3>
      </div>
      {items.map((it, i) => {
        const red = it.kind === 'rejected';
        return (
          <div key={it.key} className={cx('flex items-start gap-[10px] px-[16px] py-[12px]', i < items.length - 1 && 'shadow-[inset_0_-1px_0_var(--color-divider)]')}>
            <span className={cx('flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full', red ? 'bg-red-soft text-red' : 'bg-amber-soft text-amber')}>{red ? <CircleX size={13} /> : <Hourglass size={13} />}</span>
            <p className="min-w-0 flex-1 text-[12.5px]/[1.45] text-text">{it.text}</p>
            {it.action}
          </div>
        );
      })}
    </div>
  );
}
