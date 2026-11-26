// Phần chung của mọi màn web đã đăng nhập (desktop và điện thoại): mục trên thanh trên theo vai (BR-016), menu tài khoản
// (Đổi mật khẩu, Đăng xuất) và hộp Đổi mật khẩu. Đăng xuất gọi platform.logout: huỷ phiên ở Worker, xoá cache API của service worker.
import { useEffect, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { platform } from '../../platform';
import { isAdmin } from '../../platform/roles';
import { useSession } from '../../lib/session';
import { useAction } from '../../lib/use-action';
import { webHome, type WebHome } from '../../lib/auth-flow';
import { ChangePasswordDialog } from '../../pages/auth/ChangePasswordDialog';
import { LOGIN_PATH } from '../../pages/public/paths';
import { AccountMenu, initialsOf, toneOf } from './AccountMenu';
import type { WebShellProps } from './WebShell';

export const REPORT_PATH = '/bao-cao';
export const ADMIN_PATH = '/quan-tri';
export const NO_ACCESS_PATH = '/khong-co-quyen';
export const PASSWORD_PATH = '/doi-mat-khau';

/** Trang đầu của từng vai sau khi đăng nhập. */
export const homePath = (h: WebHome) => (h === 'admin' ? ADMIN_PATH : h === 'report' ? REPORT_PATH : NO_ACCESS_PATH);

export interface WebChrome {
  home: WebHome;
  /** Dành cho WebShell. */
  shell: Pick<WebShellProps, 'topNav' | 'company' | 'account' | 'onAccountClick'>;
  /** Avatar cho đầu trang điện thoại. */
  initials: string;
  tone: ReturnType<typeof toneOf>;
  toggleMenu: () => void;
  logout: () => void;
  /** Đang đăng xuất: nút Đăng xuất khoá lại, không gửi lệnh trùng. */
  loggingOut: boolean;
  /** Menu tài khoản + hộp đổi mật khẩu: đặt ở cuối cây giao diện. */
  portals: ReactNode;
}

export function useWebChrome(): WebChrome {
  const { state, refresh } = useSession();
  const navigate = useNavigate();
  const { pathname, state: locState } = useLocation();
  const user = state?.user ?? null;
  const [menu, setMenu] = useState(false);
  const [password, setPassword] = useState(false);
  const home = webHome(user?.role, user?.perms);

  useEffect(() => {
    if (!menu) return;
    const on = (e: KeyboardEvent) => e.key === 'Escape' && setMenu(false);
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [menu]);

  const go = (to: string) => () => navigate(to);
  const topNav: NonNullable<WebShellProps['topNav']> = [];
  if (home !== 'none') topNav.push({ key: 'report', label: 'Báo cáo', href: REPORT_PATH, active: pathname.startsWith(REPORT_PATH), onClick: go(REPORT_PATH) });
  if (isAdmin(user?.role)) topNav.push({ key: 'admin', label: 'Quản trị', href: ADMIN_PATH, active: pathname.startsWith(ADMIN_PATH), onClick: go(ADMIN_PATH) });

  const [logout, loggingOut] = useAction(async () => {
    setMenu(false);
    try {
      await platform.logout();
    } finally {
      // Đăng xuất xong về trang đăng nhập (trang chủ công khai là trang giới thiệu riêng), người đăng nhập kế tiếp
      // bắt đầu từ trang đầu theo vai của họ, không kẹt ở URL của người trước.
      navigate(LOGIN_PATH, { replace: true });
      await refresh();
    }
  });

  const passwordOpen = password || pathname === PASSWORD_PATH;
  const closePassword = () => {
    setPassword(false);
    if (pathname === PASSWORD_PATH) navigate((locState as { from?: string } | null)?.from ?? '/', { replace: true });
  };

  const portals = (
    <>
      {menu && <button type="button" aria-label="Đóng menu" tabIndex={-1} className="fixed inset-0 z-40 cursor-default" onClick={() => setMenu(false)} />}
      {menu && user && (
        <AccountMenu
          name={user.name}
          role={user.role}
          className="fixed top-[48px] right-[12px] z-[45]"
          onChangePassword={() => {
            setMenu(false);
            setPassword(true);
          }}
          onLogout={() => void logout()}
        />
      )}
      {passwordOpen && <ChangePasswordDialog onClose={closePassword} />}
    </>
  );

  return {
    home,
    shell: { topNav, company: user?.company, account: user ? { initials: initialsOf(user.name), role: user.role, tone: toneOf(user.role) } : undefined, onAccountClick: () => setMenu((m) => !m) },
    initials: user ? initialsOf(user.name) : '',
    tone: toneOf(user?.role ?? 'staff'),
    toggleMenu: () => setMenu((m) => !m),
    logout: () => void logout(),
    loggingOut,
    portals,
  };
}
