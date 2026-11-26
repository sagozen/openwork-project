import { Lock } from 'lucide-react';
import { cx } from './cx';

export type ToggleProps = {
  checked: boolean;
  onChange?: (next: boolean) => void;
  /** Ô khoá: cố định, không đổi được (hiện ổ khoá, xanh nhạt khi bật). */
  locked?: boolean;
  /** Đã đổi chưa lưu: viền hổ phách 1.5. */
  dirty?: boolean;
  /** "setting" = công tắc 34×20 (cài đặt); "cell" = 30×18 (bảng quyền). */
  size?: 'setting' | 'cell';
  /** Ô bảng quyền luôn chừa chỗ 10px bên phải cho ổ khoá (công tắc lệch trái 7px so với căn giữa). false = căn giữa, không chừa. */
  slot?: boolean;
  label?: string;
};

/** Công tắc. Ô bảng quyền: 30×18, núm 14; công tắc cài đặt: 34×20, núm 16. */
export function Toggle({ checked, onChange, locked, dirty, size = 'cell', slot = true, label }: ToggleProps) {
  const cell = size === 'cell';
  // Pen (hR039): ô khoá tắt = #E5E7EC (nhạt), ô thường tắt = #D5D9E1; công tắc cài đặt dùng #D5D9E1 cho cả hai.
  const track = locked ? (checked ? 'bg-toggle-on-locked' : cell ? 'bg-border' : 'bg-toggle-off') : checked ? 'bg-green' : 'bg-toggle-off';
  return (
    <span className={cx('inline-flex items-center justify-center leading-[normal]', cell && slot && 'gap-[4px]')}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={locked}
        onClick={() => onChange?.(!checked)}
        className={cx(
          'flex shrink-0 items-center rounded-full p-[2px] transition-colors disabled:cursor-not-allowed',
          cell ? 'h-[18px] w-[30px]' : 'h-[20px] w-[34px]',
          checked ? 'justify-end' : 'justify-start',
          track,
          dirty && 'shadow-[inset_0_0_0_1.5px_var(--color-amber)]',
        )}
      >
        <span className={cx('rounded-full bg-white', cell ? 'h-[14px] w-[14px]' : 'h-[16px] w-[16px]')} />
      </button>
      {cell && slot && (
        <span className="flex h-[10px] w-[10px] shrink-0 items-center justify-center text-text-3">{locked && <Lock size={10} />}</span>
      )}
    </span>
  );
}
