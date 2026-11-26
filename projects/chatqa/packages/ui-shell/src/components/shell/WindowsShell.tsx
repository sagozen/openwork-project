import type { CSSProperties, ReactNode } from 'react';
import { ChevronDown, CircleHelp, CloudCheck, Minus, Search, Settings, Square, X } from 'lucide-react';
import { ProductMark } from '@product/brand';
import type { AppCode, AppItem } from '../../platform/types';
import { Avatar, type AvatarTone, roleOf } from '../ui';
import { cx } from '../ui/cx';
import { navProps, type ShellNavSection } from './nav';
import { AppTabs } from './AppMenu';

export interface ShellAccount {
  initials: string;
  /** Mã vai (contracts/roles.json) để lấy nhãn; `label` ghi đè khi cần. */
  role: string;
  label?: string;
  name?: string;
  tone?: AvatarTone;
}

export interface WindowsShellProps {
  appName: string;
  workspace?: string;
  /** Ô tìm kiếm giữa thanh tiêu đề (ẩn ở màn đăng nhập / kích hoạt). */
  search?: boolean;
  syncText?: string;
  /** offline = pill hổ phách (mất kết nối, khoá offline). */
  syncTone?: 'ok' | 'offline';
  /** Thanh trạng thái đồng bộ bấm được (SyncBadge); có thì thay cho pill syncText. */
  syncSlot?: ReactNode;
  account?: ShellAccount;
  sections?: ShellNavSection[];
  /** App của người dùng: hiện thành hàng tab trên thanh tiêu đề để đổi bằng một lần bấm. */
  apps?: AppItem[];
  activeApp?: AppCode;
  onPickApp?: (item: AppItem) => void;
  cloud?: { title: string; sub: string; used: string; retention: string };
  controls?: boolean;
  onAccountClick?: () => void;
  /** Bấm logo + tên app ở thanh tiêu đề (mở bộ chuyển app). */
  onAppClick?: () => void;
  onSettingsClick?: () => void;
  /** Mục Trợ giúp ở thanh tiêu đề (mở tài liệu hướng dẫn); không có thì ẩn. */
  onHelpClick?: () => void;
  /** Thân trang không có thanh bên (màn kích hoạt, đăng nhập): căn giữa nội dung. */
  bare?: boolean;
  /** Dải chân cửa sổ (phiên bản + ngày giờ cập nhật). */
  footer?: ReactNode;
  children?: ReactNode;
}

const DRAG = { '--wails-draggable': 'drag' } as CSSProperties;
const NO_DRAG = { '--wails-draggable': 'no-drag' } as CSSProperties;

function TitleBar({ appName, workspace, search, syncText, syncTone = 'ok', syncSlot, account, apps = [], activeApp, onPickApp, controls = true, onAccountClick, onAppClick, onHelpClick }: WindowsShellProps) {
  const role = account ? (account.label ?? roleOf(account.role)?.label ?? account.role) : '';
  // Có danh sách app thì thanh tiêu đề là hàng tab; không có thì giữ logo + tên app (bấm ra bảng đổi app nếu có onAppClick).
  const tabs = apps.length > 0 && !!onPickApp;
  return (
    <div data-shell-chrome style={DRAG} className="flex h-[42px] shrink-0 items-center gap-[12px] bg-chrome pl-[16px]">
      {onAppClick && !tabs ? (
        <button type="button" style={NO_DRAG} onClick={onAppClick} aria-haspopup="menu" aria-label="Đổi app" className="flex items-center gap-[12px]">
          <ProductMark className="h-[22px] w-[22px] shrink-0 rounded-[6px]" glyph={14} tone="dark" />
          <span className="text-[13px]/[16px] font-semibold whitespace-nowrap text-white">{appName}</span>
        </button>
      ) : (
        <ProductMark className="h-[22px] w-[22px] shrink-0 rounded-[6px]" glyph={14} tone="dark" />
      )}
      {tabs ? (
        <AppTabs items={apps} active={activeApp} onPick={onPickApp} />
      ) : (
        !onAppClick && <span className="text-[13px]/[16px] font-semibold whitespace-nowrap text-white">{appName}</span>
      )}
      {workspace && (
        // Nhãn công ty kiểu brand: viên bo góc, chữ in hoa nhỏ, căn giữa trong viên và giữa thanh tiêu đề.
        <span
          title={workspace}
          className="flex h-[22px] shrink-0 items-center justify-center self-center rounded-[5px] bg-chrome-btn px-[9px] text-[10.5px]/[13px] font-bold tracking-[0.7px] whitespace-nowrap text-sidebar-text uppercase"
        >
          {workspace}
        </span>
      )}
      <span className="h-px flex-1" />
      {search && (
        <span className="flex h-[28px] w-[420px] min-w-[140px] items-center gap-[8px] stroke-in rounded-[7px] [--stroke-c:var(--color-chrome-field-line)] bg-chrome-field px-[10px]">
          <Search size={14} className="shrink-0 text-chrome-icon" />
          <span className="min-w-0 flex-1 text-[12px]/[15px] whitespace-nowrap text-chrome-hint">Tìm mặt hàng, mã HS, lô hàng…</span>
          <span className="font-mono text-[11px]/[15px] text-chrome-hint">Ctrl K</span>
        </span>
      )}
      <span className="h-px flex-1" />
      {syncSlot}
      {!syncSlot && syncText && (
        <span className={cx('flex h-[26px] shrink-0 items-center gap-[6px] rounded-full px-[10px]', syncTone === 'offline' ? 'bg-sync-pill-offline' : 'bg-sync-pill')}>
          <span className={cx('h-[7px] w-[7px] rounded-full', syncTone === 'offline' ? 'bg-sync-dot-offline' : 'bg-sync-dot')} />
          <span className="text-[11px]/[14px] whitespace-nowrap text-sync-text">{syncText}</span>
        </span>
      )}
      {onHelpClick && (
        <button type="button" style={NO_DRAG} onClick={onHelpClick} title="Mở hướng dẫn sử dụng" className="flex h-[30px] shrink-0 items-center gap-[6px] rounded-full bg-chrome-btn px-[10px] text-chrome-text hover:brightness-110">
          <CircleHelp size={14} className="text-chrome-icon" />
          <span className="text-[11px]/[14px] font-semibold whitespace-nowrap">Help</span>
        </button>
      )}
      {account && (
        <button type="button" style={NO_DRAG} onClick={onAccountClick} className="flex h-[30px] shrink-0 items-center gap-[6px] rounded-full bg-chrome-btn pr-[8px] pl-[3px]">
          <Avatar initials={account.initials} tone={account.tone ?? 'admin'} size={24} />
          <span className="text-[11px]/[14px] font-semibold whitespace-nowrap text-chrome-text">{role}</span>
          <ChevronDown size={12} className="text-chrome-icon" />
        </button>
      )}
      {controls && (
        <div style={NO_DRAG} className="flex h-[42px] shrink-0 text-chrome-control">
          {[Minus, Square, X].map((Icon, i) => (
            <span key={i} className="flex h-[42px] w-[46px] items-center justify-center">
              <Icon size={i === 1 ? 11 : 14} />
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function Sidebar({ sections = [], cloud, account, onSettingsClick }: WindowsShellProps) {
  return (
    <aside className="flex w-[236px] shrink-0 flex-col gap-[4px] bg-sidebar px-[12px] pt-[18px] pb-[14px]">
      {sections.map((s, si) => (
        <div key={s.label ?? si} className="contents">
          {s.label && <div className="px-[10px] pt-[14px] pb-[6px] text-[10px]/[13px] font-semibold tracking-[1.2px] whitespace-nowrap text-sidebar-section uppercase">{s.label}</div>}
          {s.items.map((i) => {
            const Tag = i.href ? 'a' : 'button';
            return (
              <Tag
                key={i.key}
                href={i.href}
                type={i.href ? undefined : 'button'}
                {...navProps(i)}
                className={cx('flex h-[38px] w-full shrink-0 items-center gap-[10px] rounded-[8px] px-[10px] text-left text-[13px]/[16px]', i.active ? 'bg-sidebar-hover font-semibold text-white' : 'text-chrome-text hover:bg-sidebar-hover/60')}
              >
                {i.icon && <span className={cx('flex shrink-0', i.active ? 'text-accent' : 'text-chrome-icon')}>{i.icon}</span>}
                <span className="min-w-0 flex-1">{i.label}</span>
                {i.badge !== undefined && <span className="rounded-[10px] px-[7px] py-[2px] font-mono text-[10px]/[13px] font-bold text-sidebar-badge-text">{i.badge}</span>}
                {i.p2 && <span className="rounded-[4px] bg-sidebar-p2 px-[5px] py-px font-mono text-[9px]/[12px] font-bold text-sidebar-p2-text">P2</span>}
              </Tag>
            );
          })}
        </div>
      ))}
      <span className="min-h-0 flex-1" />
      {cloud && (
        <div className="flex flex-col gap-[10px] stroke-in rounded-[10px] [--stroke-c:var(--color-sync-dot)] bg-cloud-card p-[14px]">
          <div className="flex items-center gap-[10px]">
            <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[8px] bg-cloud-icon text-sync-dot">
              <CloudCheck size={16} />
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-[2px]">
              <span className="text-[12px]/[15px] font-semibold text-white">{cloud.title}</span>
              <span className="text-[11px]/[14px] text-chrome-icon">{cloud.sub}</span>
            </div>
          </div>
          {/* Hai chữ có thể không vừa 184px: nhường chỗ cho chữ bên phải thay vì đè lên nhau (pen có lỗi đè chữ ở đây). */}
          <div className="flex items-center justify-between gap-[8px]">
            <span className="font-mono text-[10px]/[13px] whitespace-nowrap text-chrome-icon">{cloud.used}</span>
            <span className="min-w-0 truncate text-[10px]/[13px] text-cloud-sub" title={cloud.retention}>
              {cloud.retention}
            </span>
          </div>
        </div>
      )}
      {account && (
        <div className="flex h-[42px] shrink-0 items-center gap-[10px] px-[6px] pt-[12px]">
          <Avatar initials={account.initials} tone={account.tone ?? 'admin'} size={30} />
          <div className="flex min-w-0 flex-1 flex-col gap-px">
            <span className="text-[12px]/[15px] font-medium whitespace-nowrap text-white">{account.name}</span>
            <span className="text-[10px]/[13px] text-chrome-icon">{account.label ?? roleOf(account.role)?.label ?? account.role}</span>
          </div>
          <button type="button" aria-label="Cài đặt" onClick={onSettingsClick} className="shrink-0 text-chrome-icon">
            <Settings size={16} />
          </button>
        </div>
      )}
    </aside>
  );
}

/**
 * Cửa sổ app Windows (hsapp.pen): thanh tiêu đề 42 (#0E1014: logo, tên app, tìm kiếm 420×28, pill đồng bộ,
 * tài khoản 30, 3 nút cửa sổ 46×42) + thân gồm sidebar 236 (mục 212×38) và vùng nội dung.
 */
export function WindowsShell(props: WindowsShellProps) {
  const { bare, children, sections, footer } = props;
  const hasSidebar = !bare && !!sections;
  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-bg font-sans leading-[normal] text-text">
      <TitleBar {...props} />
      <div className="flex min-h-0 flex-1">
        {hasSidebar && <Sidebar {...props} />}
        <main className={cx('flex min-w-0 flex-1 flex-col', bare ? 'items-center justify-center gap-[18px]' : 'gap-[18px] px-[28px] pt-[22px] pb-[24px]')}>{children}</main>
      </div>
      {footer}
    </div>
  );
}
