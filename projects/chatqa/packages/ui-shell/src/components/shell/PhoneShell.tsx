import type { ReactNode } from 'react';
import { Battery, ChevronLeft, Menu, Signal, Wifi } from 'lucide-react';
import { ProductMark } from '@product/brand';
import { demoPhone } from '../../lib/demo';
import { cx } from '../ui/cx';
import { PRODUCT_NAME } from '../../lib/auth-ui';

export interface PhoneShellProps {
  /** Tên trang ở đầu (mặc định tên sản phẩm). */
  title?: string;
  /** Nút bên phải đầu trang (avatar tài khoản). */
  right?: ReactNode;
  /** Nút đầu trái thay cho logo: quay lại (trang con) hoặc mở menu (trang gốc). */
  lead?: { kind: 'back' | 'menu'; label: string; onClick: () => void };
  /** Vẽ giả thanh trạng thái 40px của điện thoại (chỉ để so khung pen; trên máy thật là của hệ điều hành). Mặc định chỉ bật bởi ?demo=phone ở bản dev. */
  mockStatusBar?: boolean;
  /** Thân đệm 20, khe 16 (mặc định). false = tự bố trí. */
  padded?: boolean;
  /** Lớp riêng cho thân trang (khi padded=false). */
  bodyClass?: string;
  children?: ReactNode;
}

/** Điện thoại 375: đầu trang 52 (logo 24 hoặc nút 20, chữ 15-16/700, viền dưới), thân đệm 20 khe 16. */
export function PhoneShell({ title = PRODUCT_NAME, right, lead, mockStatusBar = import.meta.env.DEV && demoPhone(), padded = true, bodyClass, children }: PhoneShellProps) {
  return (
    // Khung điện thoại của pen rộng đúng 375; trang so ảnh chụp ở 376 (cộng nửa điểm ảnh), nên khi vẽ thanh trạng thái giả thì cũng cố định 375.
    <div className={cx('flex h-full min-h-0 w-full flex-col overflow-hidden bg-bg font-sans leading-[normal] text-text', mockStatusBar && 'max-w-[375px]')}>
      {mockStatusBar && (
        <div className="flex h-[40px] shrink-0 items-center justify-between bg-surface px-[24px]">
          <span className="text-[14px]/[18px] font-semibold">9:41</span>
          <span className="flex items-center gap-[5px]">
            <Signal size={15} />
            <Wifi size={15} />
            <Battery size={15} />
          </span>
        </div>
      )}
      <header className="flex h-[52px] shrink-0 items-center gap-[10px] bg-surface px-[16px] shadow-[inset_0_-1px_0_var(--color-border)]">
        {lead ? (
          // <nav>: cú bấm quay lại được chặn khi trang còn thay đổi chưa lưu (use-unsaved-guard).
          <nav className="flex shrink-0">
            <button type="button" aria-label={lead.label} onClick={lead.onClick} className="flex h-[20px] w-[20px] items-center justify-center">
              {lead.kind === 'back' ? <ChevronLeft size={20} /> : <Menu size={20} />}
            </button>
          </nav>
        ) : (
          <ProductMark className="h-[24px] w-[24px] shrink-0 rounded-[7px]" glyph={14} tone="light" />
        )}
        <h1 className={cx('min-w-0 flex-1 truncate font-bold', lead ? 'text-[16px]/[20px]' : 'text-[15px]/[19px]')}>{title}</h1>
        {right}
      </header>
      <main className={cx('flex min-h-0 flex-1 flex-col overflow-y-auto', padded && 'gap-[16px] p-[20px]', bodyClass)}>{children}</main>
    </div>
  );
}
