import { useSession } from '../../lib/session';
import { WindowsShell } from '../../components/shell';
import { AppTiles } from '../../components/shell/AppMenu';
import { useAppPick, useShellChrome } from '../../components/shell/use-shell-chrome';
import { roleLabel } from '../../platform/roles';
import { PRODUCT_NAME, companyBadge } from '../../lib/auth-ui';

/** Màn chọn app sau đăng nhập (GxQIx): mỗi ô theo trạng thái app từ Go (dùng được, ổ khoá, mờ "Chưa kích hoạt"). */
export function AppPickerPage() {
  const { state, company } = useSession();
  const { chrome, portals } = useShellChrome();
  const pick = useAppPick();
  const user = state?.user;
  return (
    <div className="h-dvh">
      <WindowsShell appName={PRODUCT_NAME} workspace={companyBadge(company)} bare {...chrome} onAppClick={undefined}>
        <div className="flex h-full w-full flex-col items-stretch justify-start gap-[28px] px-[80px] pt-[56px]">
          <div className="flex flex-col gap-[6px]">
            <h1 className="text-[30px]/[38px] font-bold tracking-[-0.5px] text-text">Chào {user?.name}</h1>
            <p className="text-[14px]/[18px] text-text-2">{roleLabel(user?.role)}</p>
          </div>
          <AppTiles items={state?.apps ?? []} onPick={pick} />
        </div>
      </WindowsShell>
      {portals}
    </div>
  );
}
