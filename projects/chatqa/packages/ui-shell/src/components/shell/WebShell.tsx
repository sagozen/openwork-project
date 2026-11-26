import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { ProductMark } from '@product/brand';
import { Avatar, type AvatarTone, roleOf } from '../ui';
import { cx } from '../ui/cx';
import { clickProps, navProps, type ShellNavSection } from './nav';
import { PRODUCT_NAME } from '../../lib/auth-ui';

export interface WebShellProps {
  /** Mục trên thanh trên (Báo cáo, Quản trị). */
  topNav?: { key: string; label: string; active?: boolean; href?: string; onClick?: () => void }[];
  company?: string;
  account?: { initials: string; role: string; label?: string; tone?: AvatarTone };
  onAccountClick?: () => void;
  /** Sidebar sáng: nhãn nhóm + mục (cao 36). Bỏ trống = không có sidebar (Báo cáo). */
  sections?: ShellNavSection[];
  /** Thẻ ghi chú cuối sidebar (vd "Trên web"). */
  scopeNote?: { title: string; text: string };
  /** Thân không đệm, nội dung căn giữa (màn đăng nhập, không có quyền). */
  bare?: boolean;
  /** Thanh trạng thái đồng bộ (SyncBadge nền sáng), cùng chỗ trên mọi màn. */
  sync?: ReactNode;
  /** Dải chân trang (phiên bản + ngày giờ cập nhật). */
  footer?: ReactNode;
  children?: ReactNode;
}

/** Trang web desktop: thanh trên 56 (trắng) + sidebar sáng 236 (#FAFAFB, mục cao 36) + nội dung đệm 22/28/24/28. */
export function WebShell({ topNav = [], company, account, onAccountClick, sections, scopeNote, bare, sync, footer, children }: WebShellProps) {
  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-bg font-sans leading-[normal] text-text">
      <header className="flex h-[56px] shrink-0 items-center gap-[28px] bg-surface px-[24px] shadow-[inset_0_-1px_0_var(--color-border)]">
        <div className="flex items-center gap-[9px]">
          <ProductMark className="h-[26px] w-[26px] rounded-[7px]" glyph={15} tone="light" />
          <span className="text-[15px]/[19px] font-bold whitespace-nowrap">{PRODUCT_NAME}</span>
          <span className="rounded-[4px] bg-chip-neutral px-[6px] py-px text-[9px]/[11px] font-bold tracking-[0.8px] text-text-2">WEB</span>
        </div>
        <nav className="flex h-full gap-[4px]">
          {topNav.map((n) => (
            <a
              key={n.key}
              href={n.href}
              aria-current={n.active ? 'page' : undefined}
              {...clickProps(n.onClick)}
              className={cx('flex h-full items-center px-[12px] text-[13.5px]/[17px]', n.active ? 'font-bold text-text shadow-[inset_0_-2px_0_var(--color-accent)]' : 'font-medium text-text-2')}
            >
              {n.label}
            </a>
          ))}
        </nav>
        <span className="flex-1" />
        {sync}
        {company && <span className="text-[12.5px]/[16px] whitespace-nowrap text-text-3">{company}</span>}
        {account && (
          <button type="button" onClick={onAccountClick} className="flex h-[34px] items-center gap-[7px] stroke-in rounded-full pr-[10px] pl-[4px]">
            <Avatar initials={account.initials} tone={account.tone ?? 'admin'} size={26} fontSize={9.5} />
            <span className="text-[12px]/[15px] font-semibold whitespace-nowrap">{account.label ?? roleOf(account.role)?.label ?? account.role}</span>
            <ChevronDown size={13} className="text-text-3" />
          </button>
        )}
      </header>
      <div className="mx-auto flex min-h-0 w-full max-w-[1440px] flex-1">
        {sections && (
          <aside className="flex w-[236px] shrink-0 flex-col gap-[2px] bg-table-head px-[12px] py-[18px] shadow-[inset_-1px_0_0_var(--color-border)]">
            {sections.map((s, si) => (
              <div key={s.label ?? si} className="contents">
                {s.label && <div className="mb-[8px] px-[0px] text-[10px]/[13px] font-bold tracking-[1.1px] whitespace-nowrap text-text-3 uppercase">{s.label}</div>}
                {s.items.map((i) => (
                  <a
                    key={i.key}
                    href={i.href}
                    {...navProps(i)}
                    className={cx('flex h-[36px] shrink-0 items-center gap-[10px] rounded-[8px] px-[10px] text-[13px]/[16px]', i.active ? 'bg-accent-soft font-bold text-text' : 'font-medium text-text-2')}
                  >
                    {i.icon && <span className={cx('flex shrink-0', i.active ? 'text-accent' : 'text-text-3')}>{i.icon}</span>}
                    <span className="min-w-0 flex-1">{i.label}</span>
                    {i.badge !== undefined && <span className="rounded-[8px] bg-amber-soft px-[6px] py-px text-[10px]/[13px] font-bold text-amber">{i.badge}</span>}
                  </a>
                ))}
              </div>
            ))}
            <span className="min-h-0 flex-1" />
            {scopeNote && (
              <div className="flex flex-col gap-[4px] stroke-in rounded-[10px] bg-surface p-[12px]">
                <span className="text-[12px]/[15px] font-bold">{scopeNote.title}</span>
                <span className="text-[11.5px] leading-[1.45] text-text-3">{scopeNote.text}</span>
              </div>
            )}
          </aside>
        )}
        <main className={cx('flex min-w-0 flex-1 flex-col', bare ? 'items-center justify-center gap-[16px]' : 'gap-[18px] overflow-y-auto px-[28px] pt-[22px] pb-[24px]')}>{children}</main>
      </div>
      {footer}
    </div>
  );
}
