import { ShieldAlert } from 'lucide-react';
import permissions from '@contracts/permissions.json';
import { Toggle } from '../../components/ui';
import { cx } from '../../components/ui/cx';
import { GROUP_NOTE, permCopy } from './matrix-copy';
import { isLocked, shown, type Cells } from './matrix-draft';

const COLS = [
  { role: 'admin', label: 'ADMIN' },
  { role: 'manager', label: 'MANAGER' },
  { role: 'leader', label: 'LEADER' },
  { role: 'staff', label: 'NHÂN VIÊN' },
] as const;

const PERMS = permissions.permissions;

export interface MatrixCardProps {
  groups: string[];
  draft: Cells;
  dirty: Set<string>;
  onToggle?: (role: string, perm: string) => void;
}

/** Một thẻ bảng quyền (hR039): đầu cột đặt đúng trên công tắc, nhóm, dòng thường và dòng quyền duyệt nổi bật. */
export function MatrixCard({ groups, draft, dirty, onToggle }: MatrixCardProps) {
  return (
    <div className="stroke-in flex min-w-0 flex-1 flex-col overflow-hidden rounded-[12px] bg-surface leading-[normal]">
      <div className="flex h-[29px] items-center gap-[8px] bg-table-head px-[14px] py-[9px] shadow-[inset_0_-1px_0_var(--color-border)]">
        <span className="min-w-0 flex-1 text-[9px]/[11px] font-bold tracking-[0.5px] text-text-3">THAO TÁC</span>
        {COLS.map((c) => (
          <span key={c.role} className="w-[58px] shrink-0 text-center text-[9px]/[11px] font-bold tracking-[0.2px] whitespace-nowrap text-text-3">
            {c.label}
          </span>
        ))}
      </div>
      {groups.map((g) => (
        <div key={g} className="contents">
          <div className="flex h-[25px] shrink-0 items-center gap-[8px] bg-group-bg px-[14px] py-[6px] shadow-[inset_0_-1px_0_var(--color-group-line)]">
            <span className="shrink-0 text-[10px]/[13px] font-bold tracking-[0.8px] text-text-2">{g.toLocaleUpperCase('vi-VN')}</span>
            {GROUP_NOTE[g] && <span className="min-w-0 truncate text-[10.5px]/[13px] text-text-3">{GROUP_NOTE[g]}</span>}
          </div>
          {PERMS.filter((p) => p.group === g && shown(draft, p.code)).map((p) => {
            const copy = permCopy(p.code);
            return (
              <div
                key={p.code}
                className={cx(
                  'flex items-center gap-[8px] px-[14px]',
                  copy.highlight ? 'bg-accent-soft py-[9px] shadow-[inset_3px_0_0_var(--color-accent),inset_0_-1px_0_var(--color-accent)]' : 'py-[5px] shadow-[inset_0_-1px_0_var(--color-divider)]',
                )}
              >
                <div className="flex min-w-0 flex-1 flex-col gap-px overflow-hidden">
                  <div className="flex w-full items-center gap-[6px]">
                    {copy.highlight && <ShieldAlert size={13} className="shrink-0 text-accent" />}
                    <span title={copy.label} className={cx('min-w-0 flex-1 truncate text-[12px]/[15px] text-text', copy.highlight ? 'font-bold' : 'font-medium')}>{copy.label}</span>
                  </div>
                  {copy.sub && <span title={copy.sub} className={cx('truncate text-[10.5px]/[13px]', copy.highlight ? 'text-accent' : 'text-text-3')}>{copy.sub}</span>}
                </div>
                {COLS.map((c) => (
                  <div key={c.role} className="flex w-[58px] shrink-0 items-center justify-center">
                    <Toggle
                      checked={!!draft[c.role]?.[p.code]}
                      locked={isLocked(c.role, p.code)}
                      dirty={dirty.has(`${c.role}.${p.code}`)}
                      label={`${copy.label}: ${c.label}`}
                      onChange={() => onToggle?.(c.role, p.code)}
                    />
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
