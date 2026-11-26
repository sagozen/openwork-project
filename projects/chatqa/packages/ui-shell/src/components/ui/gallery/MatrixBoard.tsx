import { Toggle } from '../Toggle';
import { cx } from '../cx';
import { MATRIX_LEFT, type MatrixItem } from './data';

const COLS = ['ADMIN', 'MANAGER', 'LEADER', 'NHÂN VIÊN'];

/** Thẻ trái của bảng quyền (pen hR039): 566×501. Dùng để so ảnh với Toggle (bật, tắt, khoá). */
export function MatrixBoard({ items = MATRIX_LEFT }: { items?: MatrixItem[] }) {
  return (
    <div className="stroke-in flex w-[566px] flex-col overflow-hidden rounded-[12px] bg-surface leading-[normal]">
      {/* Khung pen đặt 4 cột tiêu đề rộng 62 liền nhau (không có khe 8 như hàng dữ liệu) nên chữ lệch so với công tắc. Giữ nguyên để so ảnh. */}
      <div className="flex h-[29px] items-center bg-table-head px-[14px] py-[9px] shadow-[inset_0_-1px_0_var(--color-border)]">
        <span className="min-w-0 flex-1 text-[9px]/[11px] font-bold tracking-[0.5px] text-text-3">THAO TÁC</span>
        {COLS.map((c) => (
          <span key={c} className="w-[62px] shrink-0 text-center text-[9px]/[11px] font-bold tracking-[0.5px] text-text-3">
            {c}
          </span>
        ))}
      </div>
      {items.map((it, i) =>
        'group' in it ? (
          <div key={i} className="flex h-[25px] shrink-0 items-center gap-[8px] bg-group-bg px-[14px] py-[6px] shadow-[inset_0_-1px_0_var(--color-group-line)]">
            <span className="text-[10px]/[13px] font-bold tracking-[0.8px] text-text-2">{it.group}</span>
            {it.note && <span className="text-[10.5px]/[13px] text-text-3">{it.note}</span>}
          </div>
        ) : (
          <div key={i} className="flex items-center gap-[8px] px-[14px] py-[5px] shadow-[inset_0_-1px_0_var(--color-divider)]">
            <div className="flex min-w-0 flex-1 flex-col gap-px">
              <span className="text-[12px]/[15px] font-medium text-text">{it.label}</span>
              {it.sub && <span className="text-[10.5px]/[13px] text-text-3">{it.sub}</span>}
            </div>
            {it.cells.map((c, ci) => (
              <div key={ci} className={cx('flex w-[62px] shrink-0 items-center justify-center')}>
                <Toggle checked={c.on} locked={c.locked} slot={!c.noSlot} label={`${it.label}: ${COLS[ci]}`} />
              </div>
            ))}
          </div>
        ),
      )}
    </div>
  );
}
