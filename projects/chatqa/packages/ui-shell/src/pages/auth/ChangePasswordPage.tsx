import { isDesktop } from '../../platform';
import { useSession } from '../../lib/session';
import { useIsPhone } from '../../lib/use-phone';
import { ForcePasswordCard } from './cards';
import { AuthScreen } from './AuthScreen';
import { usePasswordForm } from './use-password-form';
import { PhoneForcePasswordForm } from '../web/phone-forms';

/** Đặt mật khẩu mới bắt buộc sau khi đăng nhập bằng mật khẩu tạm (Z2ACu; web f94Ben, điện thoại IBUru): không có bước bỏ qua. */
export function ChangePasswordPage() {
  const { state, company } = useSession();
  const phone = useIsPhone();
  const f = usePasswordForm({ currentFromMemory: true });
  const fields = {
    showCurrent: f.needCurrent,
    currentLabel: 'Mật khẩu tạm',
    current: f.current,
    next: f.next,
    confirm: f.confirm,
    onCurrent: f.setCurrent,
    onNext: f.setNext,
    onConfirm: f.setConfirm,
    error: f.view.field,
    notice: f.view.banner,
    busy: f.busy,
    onSubmit: f.submit,
    autoFocus: true,
  };
  const below = isDesktop ? 'Bắt buộc ở lần đăng nhập đầu sau khi admin đặt lại mật khẩu. Không có bước bỏ qua.' : 'Đăng nhập web bằng mật khẩu tạm cũng phải qua bước này. Không có nút bỏ qua.';
  return (
    <AuthScreen workspace={company} below={below}>
      {!isDesktop && phone ? <PhoneForcePasswordForm {...fields} /> : <ForcePasswordCard name={state?.user?.name ?? ''} {...fields} />}
    </AuthScreen>
  );
}
