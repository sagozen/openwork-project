import { cx } from './cx';

export type SegmentOption<K extends string = string> = { key: K; label: string };

/** Chọn 1 trong N (vai trong hộp Thêm người dùng): khay cao 38 (#F0F1F4, bo 8, đệm 3, khe 3), mỗi ô cao 32 bo 6; ô chọn trắng + bóng, chữ 12/700. */
export function Segmented<K extends string>({ options, value, onChange, className }: { options: SegmentOption<K>[]; value: K; onChange?: (key: K) => void; className?: string }) {
  return (
    <div role="radiogroup" className={cx('flex h-[38px] gap-[3px] rounded-[8px] bg-chip-neutral p-[3px] leading-[normal]', className)}>
      {options.map((o) => {
        const on = o.key === value;
        return (
          <button
            key={o.key}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange?.(o.key)}
            className={cx('flex flex-1 items-center justify-center rounded-[6px] text-[12px]/[15px]', on ? 'bg-surface font-bold text-text shadow-segment' : 'font-medium text-text-2 hover:text-text')}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
