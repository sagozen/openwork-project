import { Fragment } from 'react';
import { Check } from 'lucide-react';
import { cx } from './cx';

/**
 * Các bước (Kích hoạt máy → Đăng nhập): chấm 20 bo tròn (đang: accent chữ trắng; đã qua: xanh lá + dấu tích; chưa tới: #E5E7EC chữ text-3),
 * nhãn 12, vạch nối 32×1. Bước đã qua và bước đang làm đều có nhãn đậm.
 */
export function Stepper({ steps, current, done = 0 }: { steps: string[]; current: number; /** Số bước đã xong ở đầu danh sách (vẽ dấu tích xanh). */ done?: number }) {
  return (
    <ol className="flex items-center gap-[10px] leading-[normal]">
      {steps.map((label, i) => {
        const finished = i < done;
        const reached = finished || i <= current;
        return (
          <Fragment key={label}>
            {i > 0 && <li aria-hidden className="h-px w-[32px] bg-disabled-fg" />}
            <li className="flex items-center gap-[6px]" aria-current={i === current ? 'step' : undefined}>
              <span className={cx('flex h-[20px] w-[20px] items-center justify-center rounded-full text-[10px]/[13px] font-bold', finished ? 'bg-green text-white' : reached ? 'bg-accent text-white' : 'bg-border text-text-3')}>
                {finished ? <Check size={12} strokeWidth={3} /> : i + 1}
              </span>
              <span className={cx('text-[12px]/[15px] whitespace-nowrap', reached ? 'font-semibold text-text' : 'text-text-3')}>{label}</span>
            </li>
          </Fragment>
        );
      })}
    </ol>
  );
}
