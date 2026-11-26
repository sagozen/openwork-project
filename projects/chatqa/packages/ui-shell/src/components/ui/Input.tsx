import { useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { cx } from './cx';

/** dialog = 40 (hộp thoại); login = 42 (thẻ đăng nhập, đổi mật khẩu); license = 44 (mã bản quyền); phone = 48 (điện thoại, bo 10). */
export type InputSize = 'dialog' | 'login' | 'license' | 'phone';

const SIZE: Record<InputSize, string> = {
  dialog: 'h-[40px] rounded-[8px] text-[13px]/[16px]',
  login: 'h-[42px] rounded-[8px] text-[13px]/[16px]',
  license: 'h-[44px] rounded-[8px] text-[14px]/[18px]',
  phone: 'h-[48px] rounded-[10px] px-[14px] text-[15px]/[19px]',
};

export type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> & {
  /** Nhãn phía trên (12/600, 13 trên điện thoại). Bỏ trống thì chỉ vẽ ô nhập. */
  label?: ReactNode;
  size?: InputSize;
  /** Chữ đơn cách đều JetBrains Mono (mã bản quyền, tên đăng nhập). */
  mono?: boolean;
  /** Viền đỏ 1.5 khi có lỗi. */
  invalid?: boolean;
  /** Gợi ý nhỏ dưới ô (11.5, text-3). */
  hint?: ReactNode;
  /** Ô mật khẩu: hiện nút mắt bật/tắt hiển thị. */
  password?: boolean;
  wrapperClassName?: string;
};

export function Input({ label, size = 'dialog', mono, invalid, hint, password, className, wrapperClassName, type, ...p }: InputProps) {
  const [shown, setShown] = useState(false);
  const Eyes = shown ? EyeOff : Eye;
  const phone = size === 'phone';
  return (
    <label className={cx('flex w-full min-w-0 flex-col gap-[6px] leading-[normal]', wrapperClassName)}>
      {label && <span className={cx('font-semibold text-text-2', phone ? 'text-[13px]/[16px]' : 'text-[12px]/[15px]')}>{label}</span>}
      <span
        className={cx(
          'stroke-in flex items-center gap-[8px] bg-surface focus-within:[--stroke-c:var(--color-text-3)]',
          !phone && 'px-[12px]',
          invalid && '[--stroke-c:var(--color-red)] [--stroke-w:1.5px]',
          SIZE[size],
        )}
      >
        <input
          type={password && !shown ? 'password' : password ? 'text' : type}
          className={cx(
            'min-w-0 flex-1 bg-transparent text-text outline-none placeholder:text-text-3',
            mono && 'font-mono tracking-[1px]',
            password && !shown && (phone ? 'text-[17px]/[22px] tracking-[2px]' : 'text-[16px]/[20px] tracking-[2px]'),
            className,
          )}
          {...p}
        />
        {password && (
          <button type="button" tabIndex={-1} aria-label={shown ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'} className="text-text-3" onClick={() => setShown((v) => !v)}>
            <Eyes size={phone ? 18 : 16} />
          </button>
        )}
      </span>
      {hint && <span className="text-[11.5px]/[15px] text-text-3">{hint}</span>}
    </label>
  );
}
