import { Loader2 } from 'lucide-react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cx } from './cx';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'outline';
/** lg = 40 (khoá offline, gửi yêu cầu); md = 36 (cửa sổ, đầu trang); auth = 44 (kích hoạt, đăng nhập, đổi mật khẩu); dialog = 34 (hộp nhỏ 420); sm = 28 / xs = 26 (nút nằm trong dòng bảng). */
export type ButtonSize = 'lg' | 'md' | 'auth' | 'dialog' | 'sm' | 'xs';

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-white hover:brightness-95 disabled:bg-disabled-bg disabled:text-disabled-fg',
  secondary: 'stroke-in bg-surface text-text hover:bg-bg disabled:text-text-3',
  // "outline" là tên cũ của secondary (các trang cũ còn dùng)
  outline: 'stroke-in bg-surface text-text hover:bg-bg disabled:text-text-3',
  danger: 'stroke-in [--stroke-c:var(--color-red)] bg-surface text-red hover:bg-red-soft disabled:[--stroke-c:var(--color-border)] disabled:text-text-3',
  ghost: 'text-text-2 hover:bg-bg',
};

const SIZE: Record<ButtonSize, string> = {
  lg: 'h-[40px] text-[13px]/[16px]',
  md: 'h-[36px] text-[13px]/[16px]',
  auth: 'h-[44px] text-[14px]/[18px]',
  dialog: 'h-[34px] text-[12.5px]/[16px]',
  sm: 'h-[28px] text-[11.5px]/[15px] rounded-[6px]',
  xs: 'h-[26px] text-[11px]/[14px] rounded-[6px]',
};

// Lề ngang: nút có icon 14, nút chữ 16 (pen: Btn Thêm người dùng 14, Btn Hủy 16); dialog 14; sm/xs 10.
const PAD: Record<ButtonSize, [string, string]> = {
  lg: ['px-[18px]', 'px-[18px]'],
  md: ['px-[16px]', 'px-[14px]'],
  auth: ['px-[16px]', 'px-[16px]'],
  dialog: ['px-[14px]', 'px-[14px]'],
  sm: ['px-[10px]', 'px-[10px]'],
  xs: ['px-[10px]', 'px-[10px]'],
};

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Icon đứng trước nhãn (lucide, kích thước do nơi gọi đặt: 15–16). */
  icon?: ReactNode;
  /** Kéo dài hết chiều ngang (nút trong thẻ đăng nhập). */
  block?: boolean;
  /** Đang chạy thao tác: khoá nút (không bấm lại được), icon đổi thành vòng quay, báo aria-busy. */
  loading?: boolean;
};

export function Button({ variant = 'primary', size = 'md', icon, block, loading, disabled, className, children, type = 'button', ...p }: ButtonProps) {
  return (
    <button
      type={type}
      className={cx(
        'inline-flex shrink-0 items-center justify-center gap-[8px] rounded-[8px] font-semibold leading-[normal] whitespace-nowrap transition-colors disabled:cursor-not-allowed',
        VARIANT[variant],
        SIZE[size],
        PAD[size][icon || loading ? 1 : 0],
        block && 'w-full',
        className,
      )}
      {...p}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
    >
      {loading ? <Loader2 size={14} className="animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
}
