import type { ReactNode } from 'react';
import { CircleAlert, CircleCheck, CircleX, Info } from 'lucide-react';
import { cx } from './cx';

const TONE = {
  red: { cls: '[--stroke-c:var(--color-line-red)] bg-red-soft text-red', icon: CircleX },
  amber: { cls: '[--stroke-c:var(--color-line-amber)] bg-amber-soft text-amber', icon: CircleAlert },
  blue: { cls: '[--stroke-c:var(--color-line-blue)] bg-blue-soft text-blue', icon: Info },
  green: { cls: '[--stroke-c:var(--color-line-green)] bg-green-soft text-green', icon: CircleCheck },
} as const;

/** Dải thông báo trong thẻ: padding 10 12, bo 8, viền 1, icon 16, chữ 12.5/500 dòng cao 18. Đỏ = lỗi, hổ phách = cảnh báo / mất mạng. */
export function Banner({ tone = 'red', icon, children, className }: { tone?: keyof typeof TONE; icon?: ReactNode; children: ReactNode; className?: string }) {
  const t = TONE[tone];
  const Icon = t.icon;
  return (
    <div role={tone === 'red' ? 'alert' : 'status'} className={cx('stroke-in flex w-full items-start gap-[10px] rounded-[8px] px-[12px] py-[10px]', t.cls, className)}>
      <span className="flex h-[16px] w-[16px] shrink-0 items-center justify-center">{icon ?? <Icon size={16} />}</span>
      <p className="min-w-0 flex-1 text-[12.5px] leading-[18px] font-medium">{children}</p>
    </div>
  );
}
