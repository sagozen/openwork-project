import { useEffect, useId } from 'react';
import { KeyRound } from 'lucide-react';
import { useSession } from '../../lib/session';
import { Button, Dialog } from '../../components/ui';
import { NetProgress } from '../../components/NetProgress';
import { NoticeBanner, PasswordFields, type PasswordFieldsProps } from './cards';
import { usePasswordForm } from './use-password-form';
import type { Notice } from '../../lib/auth-ui';

export const PASSWORD_NOTE = 'Các máy khác và mọi phiên web của bạn sẽ phải đăng nhập lại.';

export interface PasswordDialogViewProps extends PasswordFieldsProps {
  /** "Hoàng Anh Tùng · anhtung". */
  subtitle: string;
  notice?: Notice | null;
  busy?: boolean;
  width?: number;
  overlay?: boolean;
  onClose?: () => void;
  onSubmit?: () => void;
}

/** Hộp Đổi mật khẩu (WroZv, g4aqy): thuần hiển thị. Chân hộp cao theo chữ ghi chú (63.5 khi một dòng, 69.5 khi ba dòng ở bề rộng 440). */
export function PasswordDialogView({ subtitle, notice, busy, width = 460, overlay, onClose, onSubmit, ...fields }: PasswordDialogViewProps) {
  const formId = useId();
  return (
    <Dialog
      overlay={overlay}
      icon={<KeyRound size={18} />}
      tone="blue"
      title="Đổi mật khẩu"
      subtitle={subtitle}
      width={width}
      onClose={onClose && (() => !busy && onClose())}
      note={PASSWORD_NOTE}
      actions={
        <>
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            Hủy
          </Button>
          <Button type="submit" form={formId} loading={busy}>
            {busy ? 'Đang lưu…' : 'Lưu mật khẩu mới'}
          </Button>
        </>
      }
    >
      {/* display: contents giữ nguyên khoảng cách 16 giữa các khối trong thân hộp; Enter gửi form được. */}
      <form
        id={formId}
        noValidate
        className="contents"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit?.();
        }}
      >
        <NoticeBanner notice={notice ?? null} />
        <PasswordFields {...fields} showCurrent />
        <NetProgress op="auth.change-password" active={!!busy} label="Đang lưu mật khẩu mới" />
      </form>
    </Dialog>
  );
}

/** Tự đổi mật khẩu từ menu tài khoản: cần mạng (E-020), đổi xong các máy khác và mọi phiên web phải đăng nhập lại. */
export function ChangePasswordDialog({ onClose }: { onClose: () => void }) {
  const { state, username } = useSession();
  const f = usePasswordForm({ onDone: onClose });
  const name = state?.user?.name ?? '';
  // Đang lưu thì Esc không đóng hộp: kết quả (lỗi E-007, E-020...) phải hiện được trong hộp.
  const busy = f.busy;
  useEffect(() => {
    const on = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose();
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [onClose, busy]);
  return (
    <PasswordDialogView
      subtitle={username ? `${name} · ${username}` : name}
      current={f.current}
      next={f.next}
      confirm={f.confirm}
      onCurrent={f.setCurrent}
      onNext={f.setNext}
      onConfirm={f.setConfirm}
      error={f.view.field}
      notice={f.view.banner}
      busy={f.busy}
      onClose={onClose}
      onSubmit={() => void f.submit()}
      autoFocus
    />
  );
}
