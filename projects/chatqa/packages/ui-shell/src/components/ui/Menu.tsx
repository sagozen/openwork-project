import type { ReactNode } from 'react';
import { cx } from './cx';

/** Menu nổi. row = menu "..." của dòng bảng (212, mục 32, chữ 12); account = menu tài khoản (260, mục 34, chữ 13). */
export function Menu({ variant = 'row', className, children }: { variant?: 'row' | 'account'; className?: string; children: ReactNode }) {
  return (
    <div
      role="menu"
      className={cx(
        'stroke-in flex flex-col gap-[2px] bg-surface p-[6px] leading-[normal]',
        variant === 'row' ? 'w-[212px] rounded-[10px] shadow-menu' : 'w-[260px] rounded-[12px] shadow-popup',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function MenuItem({ icon, tone, active, variant = 'row', children, ...p }: { icon?: ReactNode; tone?: 'danger'; active?: boolean; variant?: 'row' | 'account'; children: ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const row = variant === 'row';
  return (
    <button
      type="button"
      role="menuitem"
      className={cx(
        'flex w-full items-center gap-[9px] px-[10px] text-left',
        row ? 'h-[32px] rounded-[6px] text-[12px]/[15px]' : 'h-[34px] rounded-[7px] text-[13px]/[16px]',
        tone === 'danger' ? 'text-red' : 'text-text',
        active ? 'bg-bg' : 'hover:bg-bg',
      )}
      {...p}
    >
      <span className={cx('flex shrink-0', tone === 'danger' ? 'text-red' : 'text-text-2')}>{icon}</span>
      {children}
    </button>
  );
}

/** Ghi chú cuối menu: đường kẻ trên, chữ 10 text-3 ("Không có Xoá. Tài khoản đã khoá vẫn giữ lịch sử."). */
export function MenuNote({ children }: { children: ReactNode }) {
  return <p className="px-[10px] pt-[6px] pb-[4px] shadow-[inset_0_1px_0_var(--color-border)] text-[10px]/[13px] text-text-3">{children}</p>;
}
