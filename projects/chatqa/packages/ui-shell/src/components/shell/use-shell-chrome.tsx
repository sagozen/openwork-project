// Phần chung của thanh tiêu đề Windows ở mọi màn đã đăng nhập (màn chọn app, màn làm việc, Vipo): pill đồng bộ, tài khoản,
// menu tài khoản (Đổi mật khẩu, Đăng xuất + hỏi khi còn việc chờ đồng bộ), bộ chuyển app, hộp Đổi mật khẩu.
import { useEffect, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { Lock, PowerOff } from 'lucide-react';
import { isDesktop, platform, type AppCode, type AppItem } from '../../platform';
import { useSession } from '../../lib/session';
import { useAction } from '../../lib/use-action';
import { appAction, appBlockedText } from '../../lib/auth-ui';
import { hasNativeFrame } from '../../lib/window';
import { moduleByCode } from '@product/modules/registry';
import { PRODUCT } from '@product/product';
import { SyncBadge, useSyncStatus } from '../SyncBadge';
import { syncPillText } from './sync-pill';
import { openExternal } from '../../lib/open-external';
import { useDriveSync } from '../../sync/drive-sync';
import { useToast } from '../overlays/ToastHost';
import { LogoutPendingDialog } from '../overlays/dialogs';
import { ChangePasswordDialog } from '../../pages/auth/ChangePasswordDialog';
import { AccountMenu, initialsOf, toneOf } from './AccountMenu';
import { AppSwitcherList } from './AppMenu';
import { VersionFooter } from './VersionFooter';
import type { WindowsShellProps } from './WindowsShell';

export const PASSWORD_PATH = '/doi-mat-khau';
export const PICKER_PATH = '/chon-app';

/** Bấm một app: mở được thì vào, không thì hiện đúng lỗi E-012 / E-013 / E-017 bằng thông báo nổi. */
export function useAppPick() {
  const navigate = useNavigate();
  const toast = useToast();
  return (item: AppItem) => {
    const a = appAction(item);
    if (a.type === 'open') return navigate(moduleByCode(item.code).path);
    toast.show(appBlockedText(item, a.code), a.code === 'app_forbidden' ? <Lock size={15} /> : <PowerOff size={15} />);
  };
}

export type ShellChrome = Pick<WindowsShellProps, 'search' | 'syncText' | 'syncTone' | 'syncSlot' | 'account' | 'onAccountClick' | 'onAppClick' | 'onSettingsClick' | 'onHelpClick' | 'controls' | 'footer'>;

export function useShellChrome(activeApp?: AppCode): { chrome: ShellChrome; portals: ReactNode } {
  const { state, refresh, auth } = useSession();
  const navigate = useNavigate();
  const { pathname, state: locState } = useLocation();
  const sync = useSyncStatus();
  const drive = useDriveSync();
  const pick = useAppPick();
  const [menu, setMenu] = useState<'account' | 'apps' | null>(null);
  const [dlg, setDlg] = useState<'password' | 'logout' | null>(null);
  const [pending, setPending] = useState(0);
  const user = state?.user;

  // Esc đóng menu đang mở.
  useEffect(() => {
    if (!menu) return;
    const on = (e: KeyboardEvent) => e.key === 'Escape' && setMenu(null);
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [menu]);

  const offline = sync ? !sync.online : !!state?.offline;
  // Sản phẩm không có hàng đợi đồng bộ (vd ChatQASoftware) đặt syncDoneLabel = null: không hiện pill lúc rảnh,
  // chỉ hiện khi thật sự có chuyện (mất mạng).
  const syncText = syncPillText(
    { offline, offlineDays: auth.offlineDays, needsLogin: sync?.needsLogin, failed: sync?.failed, conflict: sync?.conflict, syncing: sync?.syncing, pending: sync?.pending },
    PRODUCT.syncDoneLabel,
  );

  const [doLogout, busy] = useAction(async () => {
    try {
      await platform.logout(); // dữ liệu chờ đồng bộ vẫn giữ trên máy và tự đẩy lên khi có mạng, không cần phiên (BR-017)
    } finally {
      setDlg(null);
      await refresh();
    }
  });
  async function requestLogout() {
    setMenu(null);
    let n = auth.pending;
    try {
      n = (await platform.getState()).auth?.pending ?? n; // đọc lại số mục chờ ngay lúc bấm để báo đúng
    } catch {
      /* dùng số đang có */
    }
    if (n > 0) {
      setPending(n);
      setDlg('logout');
    } else void doLogout();
  }

  const passwordOpen = dlg === 'password' || pathname === PASSWORD_PATH;
  const closePassword = () => {
    setDlg(null);
    if (pathname === PASSWORD_PATH) navigate((locState as { from?: string } | null)?.from ?? '/', { replace: true });
  };

  const apps = state?.apps ?? [];
  const chrome: ShellChrome = {
    search: true,
    // Sản phẩm có Drive công ty: thanh trạng thái BR-007 bấm mở bảng đồng bộ; còn lại giữ pill hàng đợi.
    syncText: isDesktop && !drive ? (syncText ?? undefined) : undefined,
    syncSlot: drive ? <SyncBadge /> : undefined,
    syncTone: offline ? 'offline' : 'ok',
    controls: !hasNativeFrame(),
    account: user ? { initials: initialsOf(user.name), role: user.role, name: user.name, tone: toneOf(user.role) } : undefined,
    onAccountClick: () => setMenu((m) => (m === 'account' ? null : 'account')),
    onSettingsClick: () => navigate('/cai-dat'),
    onHelpClick: PRODUCT.landing.learn ? () => openExternal(PRODUCT.landing.learn!.url) : undefined,
    onAppClick: apps.length > 0 ? () => setMenu((m) => (m === 'apps' ? null : 'apps')) : undefined,
    footer: <VersionFooter />,
  };

  const portals = (
    <>
      {menu && <button type="button" aria-label="Đóng menu" tabIndex={-1} className="fixed inset-0 z-40 cursor-default" onClick={() => setMenu(null)} />}
      {menu === 'account' && user && (
        <AccountMenu
          name={user.name}
          role={user.role}
          className="fixed top-[46px] right-[12px] z-[45]"
          onChangePassword={() => {
            setMenu(null);
            setDlg('password');
          }}
          onLogout={() => void requestLogout()}
        />
      )}
      {menu === 'apps' && (
        <AppSwitcherList
          items={apps}
          active={activeApp}
          className="fixed top-[46px] left-[12px] z-[45] shadow-popup"
          onPick={(i) => {
            setMenu(null);
            pick(i);
          }}
        />
      )}
      {passwordOpen && <ChangePasswordDialog onClose={closePassword} />}
      {dlg === 'logout' && <LogoutPendingDialog n={pending} busy={busy} onStay={() => setDlg(null)} onLogout={() => void doLogout()} />}
    </>
  );
  return { chrome, portals };
}

