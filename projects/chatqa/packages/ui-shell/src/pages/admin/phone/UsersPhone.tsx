import type { ReactNode } from 'react';
import { EllipsisVertical, UserPlus } from 'lucide-react';
import { RoleChip, Tag } from '../../../components/ui';
import { cx } from '../../../components/ui/cx';
import { appNo } from '../format';
import type { AdminUser } from '../admin-api';
import { Dropdown, UserAvatar } from '../parts';
import { STATUS_OPTIONS, STATUS_VIEW, userTag, type RoleFilter, type StatusFilter } from '../users-view';
import { PhoneFilter } from './parts';

const DOT = { green: 'bg-green', amber: 'bg-amber', red: 'bg-red' } as const;

export interface UsersPhoneProps {
  rows: AdminUser[];
  licenseApps: string[];
  role: RoleFilter;
  status: StatusFilter;
  roleOptions: { key: RoleFilter; label: string }[];
  onRole: (r: RoleFilter) => void;
  onStatus: (s: StatusFilter) => void;
  onAdd: () => void;
  onOpen: (u: AdminUser) => void;
  menuFor: string | null;
  onMenu: (id: string | null) => void;
  renderMenu: (u: AdminUser) => ReactNode;
  addDisabled?: boolean;
}

/** Danh sách người dùng trên điện thoại (Tn4Lp): bộ lọc + nút thêm, mỗi người một thẻ; bấm thẻ mở chi tiết, "⋮" mở menu thao tác. */
export function UsersPhone(p: UsersPhoneProps) {
  const roleLabel = p.roleOptions.find((o) => o.key === p.role)!.label;
  const statusLabel = STATUS_OPTIONS.find((o) => o.key === p.status)!.label;
  return (
    <>
      <div className="flex w-full items-center gap-[8px]">
        <Dropdown align="left" options={p.roleOptions} value={p.role} onChange={p.onRole} trigger={(_, toggle) => <PhoneFilter label="Vai:" value={roleLabel} onClick={toggle} />} />
        <Dropdown align="left" options={STATUS_OPTIONS} value={p.status} onChange={p.onStatus} trigger={(_, toggle) => <PhoneFilter label="Trạng thái:" value={statusLabel} onClick={toggle} />} />
        <span className="min-w-0 flex-1" />
        <button type="button" aria-label="Thêm người dùng" disabled={p.addDisabled} onClick={p.onAdd} className="flex h-[32px] w-[32px] shrink-0 items-center justify-center rounded-[8px] bg-accent text-white">
          <UserPlus size={15} />
        </button>
      </div>
      {p.rows.map((u) => {
        const tag = userTag(u);
        const apps = u.role === 'vipo' ? 'Gửi yêu cầu' : `App ${(u.apps ?? p.licenseApps).slice().sort((a, b) => appNo(a).localeCompare(appNo(b))).map(appNo).join(' ')}`;
        return (
          <div key={u.id} className={cx('relative', u.status === 'locked' && 'opacity-60')}>
            <div className="stroke-in flex w-full items-center gap-[10px] rounded-[12px] bg-surface px-[12px] py-[10px] leading-[normal]">
              <button type="button" onClick={() => p.onOpen(u)} className="flex min-w-0 flex-1 items-center gap-[10px] text-left">
                <UserAvatar user={u} size={34} />
                <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
                  <span className="flex items-center gap-[6px]">
                    <span className="truncate text-[13.5px] font-semibold">{u.display_name}</span>
                    <RoleChip role={u.role} className="!rounded-[4px] !px-[5px] !py-px" />
                  </span>
                  <span className="flex items-center gap-[6px] text-[11px] text-text-3">
                    <span className="font-mono">{u.username}</span>
                    <span className="whitespace-nowrap">· {apps}</span>
                  </span>
                  {tag && (
                    <span className="flex">
                      <Tag kind={tag} />
                    </span>
                  )}
                </span>
                <span role="img" aria-label={STATUS_VIEW[u.status].label} className={cx('h-[7px] w-[7px] shrink-0 rounded-full', DOT[STATUS_VIEW[u.status].tone])} />
              </button>
              <button type="button" aria-label={`Thao tác với ${u.display_name}`} aria-haspopup="menu" aria-expanded={p.menuFor === u.id} onClick={() => p.onMenu(p.menuFor === u.id ? null : u.id)} className="flex shrink-0 text-text-3">
                <EllipsisVertical size={16} />
              </button>
            </div>
            {p.menuFor === u.id && <div className="absolute top-[calc(100%-6px)] right-[8px] z-30">{p.renderMenu(u)}</div>}
          </div>
        );
      })}
    </>
  );
}
