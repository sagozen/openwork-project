import { useEffect, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router';
import { Cloud, Settings } from 'lucide-react';
import { appNo, MODULES, moduleOfPath, pagePath, sidebarPages, type ModuleDef } from '@product/modules/registry';
import { useSession } from '../lib/session';
import { WindowsShell, type ShellNavSection } from './shell';
import { PICKER_PATH, useAppPick, useShellChrome } from './shell/use-shell-chrome';
import { AppDisabledDialog } from './overlays/dialogs';
import { ReviewBanner } from './overlays/ReviewBanner';
import { errorText } from '../lib/errors';
import { demoFlag } from '../lib/demo';
import { companyBadge } from '../lib/auth-ui';
import { UpdateBanner } from './UpdateBanner';
import { DriveAlertBanner } from './DriveSyncHost';
import { canSeeStorage } from '../sync/sync-view';

/** Nhớ app đang làm để trang CHUNG (Cài đặt, Lưu trữ) vẫn giữ đúng sidebar của app đó. */
function useActiveModule(): ModuleDef {
  const { pathname } = useLocation();
  const { hasApp } = useSession();
  const [last, setLast] = useState<ModuleDef | null>(null);
  const here = moduleOfPath(pathname);
  useEffect(() => {
    if (here) setLast(here);
  }, [here]);
  return here ?? last ?? MODULES.find((m) => hasApp(m.code)) ?? MODULES[0];
}

/**
 * Desktop: mỗi app 1 "cửa sổ" riêng như hsapp.pen - thanh tiêu đề (tên app, đồng bộ, tài khoản) + sidebar = các trang con của app
 * đang mở + mục CHUNG. Sinh từ danh mục phân hệ. Đổi app: hàng tab trên thanh tiêu đề (bấm một lần) hoặc màn chọn app.
 */
function DesktopShell() {
  const { company, appItem, can, state } = useSession();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const active = useActiveModule();
  const { chrome, portals } = useShellChrome(active.code);
  const pick = useAppPick();
  const apps = state?.apps ?? [];

  // Tiêu đề cửa sổ: "HS Báo giá · App 01"
  useEffect(() => {
    const title = `HS ${active.name} · ${appNo(active)}`;
    document.title = title;
    (window as unknown as { runtime?: { WindowSetTitle?: (t: string) => void } }).runtime?.WindowSetTitle?.(title);
  }, [active]);

  const go = (path: string) => () => navigate(path);
  const sections: ShellNavSection[] = [
    {
      label: `${appNo(active)} · ${active.name}`.toUpperCase(),
      items: sidebarPages(active.pages, can).map((pg) => {
        const to = pagePath(active, pg);
        return { key: to, label: pg.label, icon: <pg.icon size={17} />, p2: pg.phase === 2, active: pathname === to, onClick: go(to) };
      }),
    },
    {
      label: 'CHUNG',
      items: [
        // Lưu trữ đám mây: chỉ admin.drive (route cũng chặn).
        ...(canSeeStorage(can) ? [{ key: '/luu-tru', label: 'Lưu trữ đám mây', icon: <Cloud size={17} />, active: pathname === '/luu-tru', onClick: go('/luu-tru') }] : []),
        { key: '/cai-dat', label: 'Cài đặt', icon: <Settings size={17} />, active: pathname.startsWith('/cai-dat'), onClick: go('/cai-dat') },
      ],
    },
  ];

  // E-017: Bên triển khai tắt app khỏi bản quyền khi đang dùng: khoá ở lần kết nối tới, dữ liệu giữ nguyên.
  const disabled = appItem(active.code)?.state === 'license_disabled' && moduleOfPath(pathname)?.code === active.code;

  return (
    // ?demo=window (chỉ bản dev, bộ so ảnh): khung cửa sổ của pen đúng 1440×920, trong khi trang so ảnh chụp ở 1441×921.
    <div className={import.meta.env.DEV && demoFlag('window') ? 'h-dvh max-h-[920px] max-w-[1440px] overflow-hidden' : 'h-dvh'}>
      <WindowsShell appName={`HS ${active.name}`} workspace={companyBadge(company)} sections={sections} apps={apps} activeApp={active.code} onPickApp={pick} {...chrome}>
        <div className="min-h-0 flex-1 overflow-auto">
          <UpdateBanner />
          <ReviewBanner />
          <DriveAlertBanner />
          <Outlet />
        </div>
      </WindowsShell>
      {portals}
      {disabled && <AppDisabledDialog name={active.name} text={errorText({ code: 'app_disabled' }, { tên: active.name })} onBack={() => navigate(PICKER_PATH)} />}
    </div>
  );
}

export const Layout = DesktopShell;
