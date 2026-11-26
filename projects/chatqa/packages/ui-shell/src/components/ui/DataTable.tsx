import type { ReactNode } from 'react';
import { cx } from './cx';

export type Column<T> = {
  key: string;
  header: ReactNode;
  /** Chiều rộng cố định (px); bỏ trống = giãn hết phần còn lại. */
  width?: number;
  render: (row: T) => ReactNode;
};

export type DataTableProps<T> = {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  /** Hàng mờ 0.62 (tài khoản đã khoá). */
  dimRow?: (row: T) => boolean;
  /** Class thêm cho hàng (nền #FAFAFB khi menu "..." đang mở, nền xanh nhạt hàng vừa đặt lại mật khẩu). */
  rowClass?: (row: T) => string | undefined;
  title?: ReactNode;
  subtitle?: ReactNode;
  /** Bộ lọc / nút bên phải đầu thẻ. */
  actions?: ReactNode;
  /** Dải chân thẻ 32px (nền #FBFAFF). */
  footer?: ReactNode;
  className?: string;
};

const cell = (c: { width?: number }) => (c.width ? 'shrink-0' : 'min-w-0 flex-1');
// Ô dữ liệu là flex để chip inline-flex không bị dòng chữ (strut) đẩy lệch dọc
const DATA_CELL = 'flex items-center';

/**
 * Thẻ bảng theo pen: bo 12, đầu thẻ 52, hàng tiêu đề 27 (#FAFAFB, 9/700 hoa, chữ cách 0.5),
 * hàng dữ liệu padding 8 16 (cao 42 khi nội dung 26), chân 32.
 */
export function DataTable<T>({ columns, rows, rowKey, dimRow, rowClass, title, subtitle, actions, footer, className }: DataTableProps<T>) {
  return (
    <div className={cx('stroke-in flex flex-col overflow-hidden rounded-[12px] bg-surface leading-[normal]', className)}>
      {(title || actions) && (
        <div className="flex h-[52px] shrink-0 items-center gap-[8px] px-[16px] py-[12px] shadow-[inset_0_-1px_0_var(--color-border)]">
          {title && <span className="text-[13px]/[16px] font-bold whitespace-nowrap text-text">{title}</span>}
          {subtitle && <span className="min-w-0 flex-1 truncate text-[11px]/[14px] text-text-3">{subtitle}</span>}
          {actions}
        </div>
      )}
      <div className="flex h-[27px] shrink-0 items-center gap-[8px] bg-table-head px-[16px] py-[8px] shadow-[inset_0_-1px_0_var(--color-border)]">
        {columns.map((c) => (
          <span key={c.key} style={c.width ? { width: c.width } : undefined} className={cx('text-[9px]/[11px] font-bold tracking-[0.5px] whitespace-nowrap text-text-3 uppercase', cell(c))}>
            {c.header}
          </span>
        ))}
      </div>
      {rows.map((r) => (
        <div key={rowKey(r)} className={cx('flex items-center gap-[8px] px-[16px] py-[8px] shadow-[inset_0_-1px_0_var(--color-divider)]', dimRow?.(r) && 'opacity-[0.62]', rowClass?.(r))}>
          {columns.map((c) => (
            <div key={c.key} style={c.width ? { width: c.width } : undefined} className={cx(DATA_CELL, cell(c))}>
              {c.render(r)}
            </div>
          ))}
        </div>
      ))}
      {footer && <div className="flex h-[32px] shrink-0 items-center gap-[8px] bg-ai-foot px-[16px] py-[9px] text-[11px]/[14px]">{footer}</div>}
    </div>
  );
}
