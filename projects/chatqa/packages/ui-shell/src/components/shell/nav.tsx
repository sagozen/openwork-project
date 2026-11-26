import type { ReactNode } from 'react';

/** Mục điều hướng dùng chung cho cả 3 shell. Có `href` thì vẽ thẻ <a>, không thì <button>. */
export interface ShellNavItem {
  key: string;
  label: string;
  /** Icon lucide đã đặt cỡ (Windows 17, web 16). */
  icon?: ReactNode;
  badge?: string | number;
  /** Nhãn P2 (tính năng phase 2). */
  p2?: boolean;
  active?: boolean;
  href?: string;
  onClick?: () => void;
}

export interface ShellNavSection {
  label?: string;
  items: ShellNavItem[];
}

/** Thẻ <a href> có onClick: chặn tải lại trang, để router điều hướng (mở tab mới bằng Ctrl/Cmd+bấm vẫn dùng href). */
export const clickProps = (onClick?: () => void) =>
  onClick
    ? {
        onClick: (e: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; preventDefault: () => void }) => {
          if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          onClick();
        },
      }
    : {};

export function navProps(i: ShellNavItem) {
  return { 'aria-current': i.active ? ('page' as const) : undefined, ...clickProps(i.onClick) };
}
