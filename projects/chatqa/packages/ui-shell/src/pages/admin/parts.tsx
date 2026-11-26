// Thành phần dùng chung của các màn quản trị (không phụ thuộc shell: vẽ trong Windows, web desktop hay điện thoại).
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronDown, Settings } from 'lucide-react';
import { useNavigate } from 'react-router';
import { Avatar, Banner, Menu, MenuItem, Tabs, type AvatarTone } from '../../components/ui';
import { cx } from '../../components/ui/cx';
import { adminErrorText } from './admin-error';
import type { AdminUser } from './admin-api';
import { TAB_PATHS, useAdmin, type TabKey } from './admin-context';
import { adminTabOn } from './admin-tabs';
import { initials } from './format';

const ALL_TABS: { key: TabKey; label: string }[] = [
  { key: 'users', label: 'Người dùng & quyền' },
  { key: 'matrix', label: 'Bảng quyền theo vai' },
  { key: 'devices', label: 'Máy & bản quyền' },
  { key: 'audit', label: 'Nhật ký quản trị' },
  { key: 'pending', label: 'Chờ công nhận' },
  { key: 'ai', label: 'Dịch vụ AI' },
  { key: 'drive', label: 'Kết nối Drive' },
];
const TABS = ALL_TABS.filter((t) => adminTabOn(t.key));

/** Khung trang quản trị: đường dẫn, tiêu đề, nút đầu trang, hàng tab (chỉ trong cửa sổ Windows; web dùng thanh bên), nội dung. */
export function AdminPage({ crumb, title, web, actions, tab, onNavigate, gap = 14, children }: { crumb: string; title: string; /** Chữ riêng của bản web nếu khác Windows (mặc định: "Cài đặt" -> "Quản trị"). */ web?: { crumb?: string; title?: string }; actions?: ReactNode; tab: TabKey | (string & {}); onNavigate?: (to: string) => void; /** Khe giữa các khối trong thân trang: 14 (nhật ký, bảng quyền, chờ công nhận) hoặc 16 (máy & bản quyền). */ gap?: 14 | 16; children: ReactNode }) {
  const { base, pending, chrome, extraTabs } = useAdmin();
  const onWeb = chrome === 'web';
  if (onWeb) {
    crumb = web?.crumb ?? crumb.replace(/^Cài đặt/, 'Quản trị');
    title = web?.title ?? title;
  }
  const navigate = useNavigate();
  const go = onNavigate ?? navigate;
  return (
    <div className="flex min-h-full min-w-0 flex-1 flex-col gap-[18px]">
      <div className="flex items-end gap-[10px]">
        <div className="flex min-w-0 flex-1 flex-col gap-[4px]">
          <div className="flex items-center gap-[6px] text-[12px] whitespace-nowrap text-text-3">
            <Settings size={13} />
            {crumb}
          </div>
          <h1 className="text-[24px] font-bold tracking-[-0.4px] whitespace-nowrap text-text">{title}</h1>
        </div>
        {actions && <div className="flex items-center gap-[10px]">{actions}</div>}
      </div>
      {!onWeb && (
        <Tabs
          className="w-full"
          value={tab}
          onChange={(k) => go(`${base}/${(TAB_PATHS as Record<string, string>)[k] ?? extraTabs.find((t) => t.key === k)?.path ?? ''}`)}
          items={[
            ...TABS.map((t) => ({ key: t.key as string, label: t.label, count: t.key === 'pending' && pending ? pending : undefined })),
            ...extraTabs.map((t) => ({ key: t.key, label: t.label, count: undefined })),
          ]}
        />
      )}
      <div className={cx('flex min-h-0 w-full flex-1 flex-col', gap === 16 ? 'gap-[16px]' : 'gap-[14px]')}>{children}</div>
    </div>
  );
}

/** Lỗi tải / lưu: mất mạng hiện E-020 (amber), lỗi khác hiện đỏ. */
export function ErrorBanner({ error, params, className }: { error: unknown; params?: Record<string, string | number>; className?: string }) {
  if (!error) return null;
  const code = (error as { code?: string }).code;
  return (
    <Banner tone={code === 'need_network' ? 'amber' : 'red'} className={className}>
      {adminErrorText(error, params)}
    </Banner>
  );
}

export const avatarTone = (u: Pick<AdminUser, 'role' | 'status' | 'is_deployer'>): AvatarTone => (u.status === 'locked' ? 'locked' : u.is_deployer ? 'ai' : ((u.role === 'owner' ? 'admin' : u.role) as AvatarTone));
export const userInitials = (u: Pick<AdminUser, 'role' | 'display_name'>) => (u.role === 'vipo' ? 'VP' : initials(u.display_name));

export function UserAvatar({ user, size = 26 }: { user: Pick<AdminUser, 'role' | 'status' | 'is_deployer' | 'display_name'>; size?: number }) {
  return <Avatar initials={userInitials(user)} tone={avatarTone(user)} size={size} fontSize={size >= 48 ? 15 : size >= 30 ? 11 : 9} />;
}

/** Menu thả: `trigger` vẽ nút mở; bấm ngoài hoặc Esc thì đóng. */
export function Dropdown<K extends string>({ trigger, options, value, onChange, align = 'right' }: { trigger: (open: boolean, toggle: () => void) => ReactNode; options: { key: K; label: string }[]; value: K; onChange: (k: K) => void; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative shrink-0">
      {trigger(open, () => setOpen((o) => !o))}
      {open && (
        <div className={cx('absolute top-full z-30 mt-[4px]', align === 'right' ? 'right-0' : 'left-0')}>
          <Menu>
            {options.map((o) => (
              <MenuItem
                key={o.key}
                active={o.key === value}
                icon={o.key === value ? <Check size={14} /> : <span className="w-[14px]" />}
                onClick={() => {
                  onChange(o.key);
                  setOpen(false);
                }}
              >
                {o.label}
              </MenuItem>
            ))}
          </Menu>
        </div>
      )}
    </div>
  );
}

/** Ô lọc dạng nút có mũi tên + menu thả (Vai, Trạng thái, Người, Loại thao tác, Khoảng ngày). */
export function FilterMenu<K extends string>({ icon, label, valueLabel, options, value, onChange, size = 'sm', align = 'right' }: { icon: ReactNode; label: string; valueLabel: string; options: { key: K; label: string }[]; value: K; onChange: (k: K) => void; size?: 'sm' | 'md'; align?: 'left' | 'right' }) {
  const sm = size === 'sm';
  return (
    <Dropdown
      options={options}
      value={value}
      onChange={onChange}
      align={align}
      trigger={(open, toggle) => (
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={toggle}
          className={cx('flex shrink-0 items-center stroke-in bg-surface', sm ? 'h-[28px] gap-[6px] rounded-[7px] px-[10px] text-[11px]' : 'h-[34px] gap-[7px] rounded-[8px] px-[12px] text-[12px]')}
        >
          <span className="flex text-text-3">{icon}</span>
          <span className="whitespace-nowrap text-text-3">{label}</span>
          <span className="font-semibold whitespace-nowrap text-text">{valueLabel}</span>
          <ChevronDown size={sm ? 12 : 13} className="text-text-3" />
        </button>
      )}
    />
  );
}

/** Thông báo nổi tối góc dưới phải (Đã đặt lại mật khẩu...). Rộng 540, chữ 12.5/18 như khung vHb0D. */
export function AdminToast({ icon, children, onClose }: { icon: ReactNode; children: ReactNode; onClose?: () => void }) {
  useEffect(() => {
    if (!onClose) return;
    const t = setTimeout(onClose, 8000);
    return () => clearTimeout(t);
  }, [onClose]);
  return (
    <div role="status" className="fixed right-[40px] bottom-[16px] z-[60] flex w-[540px] max-w-[calc(100vw-56px)] items-center gap-[12px] rounded-[10px] bg-chrome px-[16px] py-[14px] leading-[normal] shadow-toast">
      <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[8px] bg-sync-pill text-sync-dot">{icon}</span>
      <p className="min-w-0 flex-1 text-[12.5px]/[18px] text-white">{children}</p>
    </div>
  );
}
