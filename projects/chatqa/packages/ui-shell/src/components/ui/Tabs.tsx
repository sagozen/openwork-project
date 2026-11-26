import type { ReactNode } from 'react';
import { cx } from './cx';

export type TabItem<K extends string = string> = {
  key: K;
  label: ReactNode;
  /** Số đếm hổ phách sau nhãn (vd Chờ công nhận 3). */
  count?: number;
};

/** Thanh tab trang cài đặt: khoảng cách 24, 13/500 (đang chọn 13/700 + gạch chân accent 2px), cao 26, đường kẻ dưới 1px. */
export function Tabs<K extends string>({ items, value, onChange, className }: { items: TabItem<K>[]; value: K; onChange?: (key: K) => void; className?: string }) {
  return (
    <div role="tablist" className={cx('flex h-[26px] gap-[24px] leading-[normal] shadow-[inset_0_-1px_0_var(--color-border)]', className)}>
      {items.map((t) => {
        const on = t.key === value;
        return (
          <button
            key={t.key}
            role="tab"
            aria-selected={on}
            type="button"
            onClick={() => onChange?.(t.key)}
            className={cx(
              'flex items-start gap-[6px] pb-[10px] text-[13px]/[16px] whitespace-nowrap',
              on ? 'font-bold text-text shadow-[inset_0_-2px_0_var(--color-accent)]' : 'font-medium text-text-2 hover:text-text',
            )}
          >
            {t.label}
            {t.count !== undefined && <span className="mt-[0.5px] rounded-[8px] bg-amber-soft px-[6px] py-[1px] text-[10px]/[13px] font-bold text-amber">{t.count}</span>}
          </button>
        );
      })}
    </div>
  );
}
