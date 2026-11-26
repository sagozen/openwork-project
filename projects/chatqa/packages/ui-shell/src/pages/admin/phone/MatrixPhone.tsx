import { Lock } from 'lucide-react';
import permissions from '@contracts/permissions.json';
import { cx } from '../../../components/ui/cx';
import { ROLES } from '../../../platform/roles';
import { permCopy } from '../matrix-copy';
import { isLocked, shown, type Cells } from '../matrix-draft';

const PERMS = permissions.permissions;
/** Nhóm gộp thành một dòng tóm tắt trên điện thoại (JvEg6: "Biểu thuế, quy tắc, danh mục rủi ro… (10 quyền)"). */
const SUMMARY_GROUP = 'Dữ liệu chung';
const SUMMARY_LABEL = 'Biểu thuế, quy tắc, danh mục rủi ro…';

export const PHONE_ROLES = ROLES.filter((r) => r.code !== 'vipo');

function PhoneToggle({ on, locked, dirty, label, onChange }: { on: boolean; locked?: boolean; dirty?: boolean; label: string; onChange?: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={locked}
      onClick={onChange}
      className={cx('flex h-[20px] w-[34px] shrink-0 rounded-[10px] p-[2px] transition-colors', on ? 'justify-end bg-green' : locked ? 'bg-border' : 'bg-[#D5D9E1]', locked && on && 'opacity-60', dirty && 'ring-2 ring-accent ring-offset-1')}
    >
      <span className="h-[16px] w-[16px] rounded-full bg-surface" />
    </button>
  );
}

export interface MatrixPhoneProps {
  role: string;
  onRole: (r: string) => void;
  groups: string[];
  draft: Cells;
  dirty: Set<string>;
  onToggle: (role: string, perm: string) => void;
  /** Bật/tắt cả nhóm tóm tắt cùng lúc. */
  onToggleGroup: (role: string, perms: string[], on: boolean) => void;
  disabled?: boolean;
}

/** Bảng quyền trên điện thoại (JvEg6): chọn một vai, mỗi quyền một dòng công tắc. Cùng bản nháp và luồng lưu với bản desktop. */
export function MatrixPhone({ role, onRole, groups, draft, dirty, onToggle, onToggleGroup, disabled }: MatrixPhoneProps) {
  const on = (perm: string) => !!draft[role]?.[perm];
  return (
    <>
      <div role="tablist" className="flex h-[36px] w-full gap-[3px] rounded-[9px] bg-[#E9EBEF] p-[3px]">
        {PHONE_ROLES.map((r) => (
          <button key={r.code} type="button" role="tab" aria-selected={r.code === role} onClick={() => onRole(r.code)} className={cx('flex flex-1 items-center justify-center rounded-[7px] pt-[2px] text-[12px]', r.code === role ? 'bg-surface font-bold text-text shadow-segment' : 'font-medium text-text-2')}>
            {r.label}
          </button>
        ))}
      </div>
      <div className="stroke-in flex w-full flex-col overflow-hidden rounded-[12px] bg-surface leading-[normal]">
        {groups.map((g) => {
          const list = PERMS.filter((p) => p.group === g && shown(draft, p.code));
          return (
            <div key={g} className="contents">
              <div className="bg-group-bg px-[14px] py-[6px]">
                <span className="text-[10px] font-bold tracking-[0.8px] text-text-2">{g.toLocaleUpperCase('vi-VN')}</span>
              </div>
              {g === SUMMARY_GROUP ? (
                <Row label={`${SUMMARY_LABEL} (${list.length} quyền)`}>
                  <PhoneToggle
                    on={list.every((p) => on(p.code))}
                    locked={isLocked(role, list[0].code)}
                    dirty={list.some((p) => dirty.has(`${role}.${p.code}`))}
                    label={`${SUMMARY_LABEL}: ${role}`}
                    onChange={() => !disabled && onToggleGroup(role, list.map((p) => p.code), !list.every((p) => on(p.code)))}
                  />
                </Row>
              ) : (
                list.map((p) => {
                  const copy = permCopy(p.code);
                  const locked = isLocked(role, p.code);
                  return (
                    <Row key={p.code} label={copy.label} highlight={copy.highlight}>
                      {locked && role !== 'admin' && <Lock size={11} className="text-text-3" />}
                      <PhoneToggle on={on(p.code)} locked={locked} dirty={dirty.has(`${role}.${p.code}`)} label={`${copy.label}: ${role}`} onChange={() => !disabled && onToggle(role, p.code)} />
                    </Row>
                  );
                })
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

function Row({ label, highlight, children }: { label: string; highlight?: boolean; children: React.ReactNode }) {
  return (
    <div className={cx('flex items-center gap-[10px] px-[14px] py-[9px]', highlight ? 'bg-accent-soft shadow-[inset_3px_0_0_var(--color-accent),inset_0_-1px_0_var(--color-accent)]' : 'shadow-[inset_0_-1px_0_var(--color-divider)]')}>
      <span className={cx('min-w-0 flex-1 text-[12.5px]/[17px] text-text', highlight ? 'font-bold' : 'font-medium')}>{label}</span>
      <span className="flex items-center gap-[5px]">{children}</span>
    </div>
  );
}
