import type { ReactNode } from 'react';
import { ShieldX } from 'lucide-react';
import { cx } from './cx';

/** Thông báo nổi tối: rộng 440, nền #0E1014, bo 10, ô icon 30 (#22252D), chữ trắng 13 dòng cao 1.4. Vị trí do nơi gọi đặt (vd fixed bottom-6 left-1/2). */
export function Toast({ icon, children, className, action }: { icon?: ReactNode; children: ReactNode; className?: string; /** Nút bên phải ("Đóng"): 12.5/600, màu chữ phụ trên nền tối. */ action?: ReactNode }) {
  return (
    <div role="status" className={cx('flex w-[440px] items-center gap-[12px] rounded-[10px] bg-chrome px-[16px] py-[14px] shadow-toast', className)}>
      <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[8px] bg-sidebar-hover text-avatar-admin-text">{icon ?? <ShieldX size={15} />}</span>
      <p className="min-w-0 flex-1 text-[13px] leading-[1.4] text-white">{children}</p>
      {action}
    </div>
  );
}
