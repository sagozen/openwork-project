import { LogOut, ShieldOff } from 'lucide-react';
import { useSession } from '../../lib/session';
import { errorText } from '../../lib/errors';
import { roleLabel } from '../../platform/roles';
import { Button } from '../../components/ui';
import { useIsPhone } from '../../lib/use-phone';
import { WebScreen } from '../../components/shell';
import { useWebChrome } from '../../components/shell/web-chrome';

/** E-013 trên web (n5iC2 / ho3Qa): vai không có màn nào ở bản web (Nhân viên, Vipo) hoặc mở thẳng một đường dẫn không được phép (NFR-009). */
export default function NoPermissionPage() {
  const phone = useIsPhone();
  const { state } = useSession();
  const { logout, loggingOut } = useWebChrome();
  const role = state?.user?.role;
  const text = errorText({ code: 'app_forbidden' }, { 'app / màn này': 'màn này' });
  const hint = role === 'vipo' ? 'Vai Vipo chỉ dùng màn Gửi yêu cầu trên app Windows. Bản web chỉ có Báo cáo và Quản trị.' : `Vai ${roleLabel(role)} làm việc trên app Windows. Bản web chỉ có Báo cáo và Quản trị.`;
  if (phone) {
    return (
      <WebScreen phone={{ padded: false, bodyClass: 'items-center justify-center gap-[14px] px-[28px]' }}>
        <span className="flex h-[60px] w-[60px] items-center justify-center rounded-full bg-chip-neutral text-text-2">
          <ShieldOff size={28} />
        </span>
        <h2 className="text-[22px]/[28px] font-bold">Chưa có quyền</h2>
        <p className="w-full text-center text-[15px]/[23px] text-text-2">{text}</p>
        <Button variant="secondary" size="lg" className="!h-[44px] !rounded-[10px] !px-[20px] !text-[14px]/[18px]" icon={<LogOut size={15} />} loading={loggingOut} onClick={logout}>
          {loggingOut ? 'Đang đăng xuất…' : 'Đăng xuất'}
        </Button>
      </WebScreen>
    );
  }
  return (
    <WebScreen bare>
      <div className="stroke-in flex w-[460px] max-w-full flex-col items-center gap-[14px] rounded-[16px] bg-surface p-[32px] leading-[normal]" role="alert">
        <span className="flex h-[56px] w-[56px] items-center justify-center rounded-full bg-table-head text-text-2">
          <ShieldOff size={26} />
        </span>
        <h2 className="text-[20px]/[25px] font-bold whitespace-nowrap">Chưa có quyền dùng màn này</h2>
        <p className="w-full text-center text-[14px]/[21px] text-text-2">{text}</p>
        <p className="w-full text-center text-[12px]/[18px] text-text-3">{hint}</p>
        <Button variant="secondary" size="lg" icon={<LogOut size={14} />} loading={loggingOut} onClick={logout}>
          {loggingOut ? 'Đang đăng xuất…' : 'Đăng xuất'}
        </Button>
      </div>
    </WebScreen>
  );
}
