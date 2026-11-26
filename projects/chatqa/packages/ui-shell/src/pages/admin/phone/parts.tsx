// Thành phần của các trang quản trị trên điện thoại (WsSHs, Tn4Lp, JvEg6, TD9Ak, aU3zY, dzwgv, IppO8, VJX8o): đầu trang có nút quay lại + avatar, thân nền xám, thẻ trắng bo 12.
import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { WebScreen } from '../../../components/shell';
import { cx } from '../../../components/ui/cx';
import { useAdmin } from '../admin-context';
import { ErrorBanner } from '../parts';

/** Một trang con trên điện thoại: quay lại menu Quản trị; thân đệm 16 khe 10 (hoặc 14). */
export function PhoneAdminPage({ title, back, body = 'gap-[10px] p-[16px]', error, children }: { title: string; /** Đường dẫn quay lại; mặc định là menu Quản trị. */ back?: string; /** Khe và đệm của thân trang (mặc định 10 và 16). */ body?: string; error?: unknown; children: ReactNode }) {
  const { base } = useAdmin();
  return (
    <WebScreen phone={{ title, back: back ?? base, padded: false, bodyClass: body }}>
      <ErrorBanner error={error} />
      {children}
    </WebScreen>
  );
}

/** Thẻ trắng bo 12, viền 1. */
export function PhoneCard({ className, children, ...p }: { className?: string; children: ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cx('stroke-in flex w-full flex-col rounded-[12px] bg-surface leading-[normal]', className)} {...p}>
      {children}
    </div>
  );
}

/** Ô lọc điện thoại: cao 32, bo 8, "Nhãn: Giá trị" + mũi tên. */
export function PhoneFilter({ label, value, onClick, compact }: { label?: string; value: string; onClick?: () => void; /** Bộ lọc nhật ký: cao 30, chữ 11.5. */ compact?: boolean }) {
  return (
    <button type="button" onClick={onClick} className={cx('stroke-in flex shrink-0 items-center rounded-[8px] bg-surface', compact ? 'h-[30px] gap-[4px] px-[9px] text-[11.5px]' : 'h-[32px] gap-[5px] px-[10px] text-[12px]')}>
      {label && <span className="text-text-3">{label}</span>}
      <span className="font-semibold text-text">{value}</span>
      <ChevronDown size={compact ? 11 : 12} className="text-text-3" />
    </button>
  );
}
