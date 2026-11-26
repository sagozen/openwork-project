import type { ReactNode } from 'react';
import { Check } from 'lucide-react';
import { cx } from './cx';

/** Ô tick 16×16 bo 4 (đã chọn: nền accent + dấu tick 11 trắng; chưa chọn: viền #C9CED8), nhãn 12.5. */
/** label: tên đọc cho trình đọc màn hình khi ô chọn không có chữ đi kèm (children). */
export function Checkbox({ checked, onChange, disabled, children, label }: { checked: boolean; onChange?: (next: boolean) => void; disabled?: boolean; children?: ReactNode; label?: string }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange?.(!checked)}
      className={cx('flex items-center gap-[8px] text-left text-[12.5px]/[16px] text-text', disabled && 'opacity-50')}
    >
      <span className={cx('flex h-[16px] w-[16px] shrink-0 items-center justify-center rounded-[4px] stroke-in', checked ? '[--stroke-c:var(--color-accent)] bg-accent text-white' : '[--stroke-c:var(--color-disabled-fg)] bg-surface')}>
        {checked && <Check size={11} strokeWidth={3} />}
      </span>
      {children}
    </button>
  );
}
