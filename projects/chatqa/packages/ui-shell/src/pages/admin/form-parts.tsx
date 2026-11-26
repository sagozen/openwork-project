// Mảnh ghép dùng chung cho các hộp thoại biểu mẫu (nhãn kèm chú thích, ô nhập có nút bên phải, chọn vai, ô app).
import type { ReactNode } from 'react';
import { CircleAlert, RefreshCw } from 'lucide-react';
import { Checkbox } from '../../components/ui';
import { cx } from '../../components/ui/cx';
import type { AppCode } from '../../platform/types';
import { PRODUCT_APPS } from '../../lib/catalog';
import { appLabel } from './format';
import { ROLE_OPTIONS } from './user-form';

/** Hàng nhãn: tên 12/600 + chú thích 11 (text-3, hoặc hổ phách đậm khi báo thay đổi). */
export function FieldLabel({ children, extra, warn }: { children: ReactNode; extra?: ReactNode; warn?: boolean }) {
  return (
    <div className="flex w-full items-center gap-[6px]">
      <span className="text-[12px] font-semibold whitespace-nowrap text-text-2">{children}</span>
      {extra && <span className={cx('text-[11px] whitespace-nowrap', warn ? 'font-semibold text-amber' : 'text-text-3')}>{extra}</span>}
    </div>
  );
}

/** Ô nhập cao 40 có nút nhỏ bên phải (Tạo mới, Sao chép) hoặc biểu tượng khoá. */
export function AdornedField({ value, onChange, mono, readOnly, tall, invalid, children, label }: { value: string; onChange?: (v: string) => void; mono?: boolean; readOnly?: boolean; tall?: boolean; invalid?: boolean; children?: ReactNode; label: string }) {
  return (
    <span
      className={cx(
        'stroke-in flex items-center gap-[8px] rounded-[8px]',
        tall ? 'h-[42px] pr-[8px] pl-[12px] [--stroke-c:var(--color-text-3)]' : 'h-[40px] px-[12px]',
        readOnly && !tall ? 'bg-disabled-bg' : 'bg-surface',
        invalid && '[--stroke-c:var(--color-red)] [--stroke-w:1.5px]',
      )}
    >
      <input
        aria-label={label}
        value={value}
        readOnly={readOnly}
        onChange={(e) => onChange?.(e.target.value)}
        className={cx('min-w-0 flex-1 bg-transparent outline-none', mono ? 'font-mono' : '', tall ? 'text-[13px]' : mono ? 'text-[12.5px]' : 'text-[13px]', readOnly && !tall ? 'text-text-2' : 'text-text')}
      />
      {children}
    </span>
  );
}

export function MiniButton({ icon, children, onClick, size = 26 }: { icon: ReactNode; children: ReactNode; onClick?: () => void; size?: 26 | 28 }) {
  return (
    <button type="button" onClick={onClick} className={cx('flex shrink-0 items-center gap-[5px] rounded-[6px] bg-chip-neutral px-[9px] text-[11px] font-semibold whitespace-nowrap text-text-2', size === 26 ? 'h-[26px]' : 'h-[28px]')}>
      {icon}
      {children}
    </button>
  );
}

export const RegenButton = ({ onClick }: { onClick?: () => void }) => (
  <MiniButton icon={<RefreshCw size={12} />} onClick={onClick}>
    Tạo mới
  </MiniButton>
);

/** Dòng lỗi dưới ô nhập (E-009...). */
export function FieldError({ children }: { children: ReactNode }) {
  return (
    <div className="flex w-full gap-[6px]">
      <CircleAlert size={13} className="mt-[1.5px] shrink-0 text-red" />
      <p className="min-w-0 flex-1 text-[11.5px]/[16px] font-medium text-red">{children}</p>
    </div>
  );
}

/** Chọn 1 trong 5 vai; `original` = vai hiện tại khi sửa (viền xám để thấy mình đang đổi từ đâu). */
export function RoleSegmented({ value, original, onChange }: { value: string; original?: string; onChange?: (role: string) => void }) {
  return (
    <div role="radiogroup" aria-label="Vai" className="flex h-[38px] gap-[3px] rounded-[8px] bg-chip-neutral p-[3px]">
      {ROLE_OPTIONS.map((o) => {
        const on = o.key === value;
        const was = !on && o.key === original;
        return (
          <button
            key={o.key}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange?.(o.key)}
            className={cx('flex flex-1 items-center justify-center rounded-[6px] text-[12px]', on ? 'bg-surface font-bold text-text shadow-segment' : 'font-medium text-text-2 hover:text-text', was && 'stroke-in [--stroke-c:var(--color-disabled-fg)]')}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Ô chọn app: 2 cột; app chưa kích hoạt cho công ty thì mờ, không chọn được, kèm nhãn "Chưa kích hoạt". `removed` = app vừa bỏ (chữ hổ phách). */
export function AppChecks({ licenseApps, value, onChange, removed = [] }: { licenseApps: AppCode[]; value: AppCode[]; onChange?: (next: AppCode[]) => void; removed?: AppCode[] }) {
  const codes = PRODUCT_APPS.map((a) => a.code as AppCode);
  const rows: AppCode[][] = [];
  for (let i = 0; i < codes.length; i += 2) rows.push(codes.slice(i, i + 2));
  const toggle = (c: AppCode) => onChange?.(value.includes(c) ? value.filter((x) => x !== c) : [...value, c]);
  return (
    <div className="stroke-in flex w-full flex-col gap-[8px] rounded-[8px] px-[14px] py-[12px]">
      {rows.map((row, i) => (
        <div key={i} className="flex w-full flex-col gap-[8px] sm:flex-row sm:gap-[12px]">
          {row.map((c) => {
            const active = licenseApps.includes(c);
            return (
              <div key={c} className="flex min-w-0 flex-1 items-center gap-[8px]">
                <Checkbox checked={active && value.includes(c)} disabled={!active} onChange={() => toggle(c)}>
                  <span className={cx('whitespace-nowrap', removed.includes(c) ? 'text-amber' : 'text-text')}>{appLabel(c)}</span>
                </Checkbox>
                {!active && <span className="rounded-[4px] bg-chip-neutral px-[5px] py-px text-[9.5px] font-semibold whitespace-nowrap text-text-3 opacity-50">Chưa kích hoạt</span>}
              </div>
            );
          })}
          {row.length === 1 && <div className="hidden flex-1 sm:block" />}
        </div>
      ))}
    </div>
  );
}
