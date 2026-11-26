// Khung tài khoản Vipo (w86Ot): chỉ có màn "Gửi yêu cầu báo giá", không thấy app nội bộ nào (BR-013).
// Màn gửi yêu cầu là của feature vipo-sheet-exchange: ở đây chỉ dựng khung và gắn route của feature đó vào <Outlet />.
import { Outlet } from 'react-router';
import { EyeOff } from 'lucide-react';
import { WindowsShell } from '../../components/shell';
import { useShellChrome } from '../../components/shell/use-shell-chrome';
import { roleOf } from '../../components/ui';
import { useSession } from '../../lib/session';
import { PRODUCT_NAME, companyBadge } from '../../lib/auth-ui';

export const VIPO_HOME = '/gui-yeu-cau';

export function VipoShell() {
  const { state, company } = useSession();
  const { chrome, portals } = useShellChrome();
  const user = state?.user;
  return (
    <div className="h-dvh">
      <WindowsShell appName={PRODUCT_NAME} workspace={companyBadge(`Cổng gửi yêu cầu · ${company}`)} bare {...chrome} search={false} syncText={undefined} syncSlot={undefined} onAppClick={undefined}>
        <div className="flex h-full w-full flex-col items-stretch justify-start gap-[20px] px-[120px] pt-[32px] pb-[32px]">
          <div className="flex items-end gap-[12px]">
            <div className="flex min-w-0 flex-1 flex-col gap-[4px]">
              <p className="text-[12px]/[15px] text-text-3">
                {user?.name} · vai {roleOf('vipo')?.label}
              </p>
              <h1 className="text-[24px]/[30px] font-bold tracking-[-0.4px] text-text">Gửi yêu cầu báo giá</h1>
            </div>
            <span className="flex items-center gap-[8px] rounded-[8px] bg-amber-soft px-[12px] py-[8px] text-[12px]/[15px] font-semibold text-amber">
              <EyeOff size={14} />
              Tài khoản Vipo chỉ thấy màn này, không thấy app nội bộ nào.
            </span>
          </div>
          <div className="flex min-h-0 flex-1 flex-col">
            <Outlet />
          </div>
        </div>
      </WindowsShell>
      {portals}
    </div>
  );
}
