import type { ReactNode } from 'react';
import { isDesktop } from '../../platform';
import { useSession } from '../../lib/session';
import { useIsPhone } from '../../lib/use-phone';
import { PhoneShell, WebShell, WindowsShell, type ShellAccount } from '../../components/shell';
import { hasNativeFrame } from '../../lib/window';
import { PRODUCT_NAME, companyBadge } from '../../lib/auth-ui';

export interface AuthScreenProps {
  /** Chữ cạnh tên app ở thanh tiêu đề ("Máy chưa kích hoạt", tên công ty). */
  workspace?: string;
  children: ReactNode;
  /** Chữ nhỏ dưới thẻ. */
  below?: ReactNode;
  stepper?: ReactNode;
  /** Màn chọn app có đủ thanh tiêu đề (tìm kiếm, đồng bộ, tài khoản). */
  chrome?: { search?: boolean; syncText?: string; account?: ShellAccount; onAccountClick?: () => void };
}

/**
 * Khung chung các màn trước khi vào app: cửa sổ Windows (thanh tiêu đề 42 + thân căn giữa) trên desktop;
 * trên web, thanh trên 56 + thẻ căn giữa từ 768px, đầu trang 52 + biểu mẫu phẳng dưới 768px (CT91Y, G82Jk, f94Ben, IBUru).
 */
export function AuthScreen({ workspace, children, below, stepper, chrome }: AuthScreenProps) {
  const phone = useIsPhone();
  const { state } = useSession();
  if (!isDesktop) {
    if (phone) {
      return (
        <div className="h-dvh">
          <PhoneShell padded={false}>{children}</PhoneShell>
        </div>
      );
    }
    return (
      <div className="h-dvh">
        <WebShell bare company={companyBadge(state?.user?.company)}>
          {children}
          {below && <p className="text-[12px]/[15px] text-text-3">{below}</p>}
        </WebShell>
      </div>
    );
  }
  return (
    <div className="h-dvh">
      <WindowsShell appName={PRODUCT_NAME} workspace={companyBadge(workspace)} bare controls={!hasNativeFrame()} {...chrome}>
        {stepper}
        {children}
        {below && <p className="text-[12px]/[15px] text-text-3">{below}</p>}
      </WindowsShell>
    </div>
  );
}
