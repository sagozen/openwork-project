import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { cx } from './cx';

const TONE = {
  accent: 'bg-accent-soft text-accent',
  blue: 'bg-blue-soft text-blue',
  red: 'bg-red-soft text-red',
  amber: 'bg-amber-soft text-amber',
  gray: 'bg-chip-neutral text-text-2',
} as const;
export type DialogTone = keyof typeof TONE;

type Common = {
  /** Icon lucide cỡ 18 (đã đặt size bởi nơi gọi). */
  icon: ReactNode;
  tone?: DialogTone;
  title: ReactNode;
  children?: ReactNode;
  /** false = chỉ vẽ hộp (dùng trong khung mẫu/preview), true = phủ toàn màn bằng lớp #0E1014A6. */
  overlay?: boolean;
  className?: string;
};

type FormProps = Common & {
  variant?: 'form';
  /** 600 (Thêm/Sửa người dùng), 500, 460 (Đổi mật khẩu) hoặc 440 (khung lỗi). */
  width?: number;
  subtitle?: ReactNode;
  onClose?: () => void;
  /** Ghi chú bên trái chân hộp (11, text-3). */
  note?: ReactNode;
  /** Các nút bên phải chân hộp. */
  actions?: ReactNode;
  /** Cột phụ bên phải thân hộp (tóm tắt quyền ở hộp Thêm/Sửa người dùng). */
  side?: ReactNode;
  /** Khe dọc trong thân hộp: 16 (mặc định, hộp Thêm người dùng) hoặc 14 (hộp 500/520 chỉ có khối chữ). */
  gap?: 14 | 16;
};
type CompactProps = Common & { variant: 'compact'; actions?: ReactNode; /** 420 (hộp dùng chung) hoặc 440 (đăng nhập lại khi phiên hết hạn). */ width?: number };
export type DialogProps = FormProps | CompactProps;

/**
 * Hộp thoại pen. form: rộng 600/500, bo 14, đầu 73 (ô icon 36 bo 10), thân đệm 22 khe 16, chân 64 (#FAFAFB).
 * compact: rộng 420, đệm 22 khe 14, ô icon tròn 36, chữ 13 dòng cao 1.5, nút cao 34 canh phải.
 */
export function Dialog(props: DialogProps) {
  const { icon, tone = 'accent', title, children, overlay = true, className } = props;
  const compact = props.variant === 'compact';
  const panel = compact ? (
    <div role="dialog" aria-modal={overlay} style={{ width: props.width ?? 420 }} className={cx('flex max-w-[calc(100vw-24px)] flex-col gap-[14px] rounded-[14px] bg-surface p-[22px] leading-[normal] shadow-popup', className)}>
      <div className="flex items-center gap-[12px]">
        <span className={cx('flex h-[36px] w-[36px] shrink-0 items-center justify-center rounded-full', TONE[tone])}>{icon}</span>
        <h2 className="min-w-0 flex-1 text-[15px]/[19px] font-bold text-text">{title}</h2>
      </div>
      <div className="text-[13px] leading-[20px] text-text-2">{children}</div>
      {props.actions && <div className="flex justify-end gap-[8px]">{props.actions}</div>}
    </div>
  ) : (
    <div role="dialog" aria-modal={overlay} style={{ width: props.width ?? 600 }} className={cx('flex max-h-[calc(100dvh-24px)] max-w-[calc(100vw-24px)] flex-col overflow-hidden overflow-y-auto rounded-[14px] bg-surface leading-[normal] shadow-dialog', className)}>
      <div className="flex h-[73px] shrink-0 items-center gap-[12px] px-[22px] py-[18px] shadow-[inset_0_-1px_0_var(--color-border)]">
        <span className={cx('flex h-[36px] w-[36px] shrink-0 items-center justify-center rounded-[10px]', TONE[tone])}>{icon}</span>
        <div className="flex min-w-0 flex-1 flex-col gap-[2px]">
          <h2 className="text-[16px]/[20px] font-bold text-text">{title}</h2>
          {props.subtitle && <p className="text-[12px]/[15px] text-text-3">{props.subtitle}</p>}
        </div>
        {props.onClose && (
          <button type="button" aria-label="Đóng" onClick={props.onClose} className="text-text-3">
            <X size={18} />
          </button>
        )}
      </div>
      {props.side ? (
        <div className="flex">
          <div className="flex min-w-0 flex-1 flex-col gap-[16px] p-[22px]">{children}</div>
          {props.side}
        </div>
      ) : (
        <div className={cx('flex flex-col p-[22px]', props.gap === 14 ? 'gap-[14px]' : 'gap-[16px]')}>{children}</div>
      )}
      {(props.note || props.actions) && (
        <div className="flex min-h-[64px] shrink-0 items-center gap-[10px] bg-table-head px-[22px] py-[14px] shadow-[inset_0_1px_0_var(--color-border)]">
          <p className="min-w-0 flex-1 text-[11px]/[14px] text-text-3">{props.note}</p>
          {props.actions}
        </div>
      )}
    </div>
  );
  if (!overlay) return panel;
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay">{panel}</div>;
}
