import { useRef, useState } from 'react';
import { Check, Copy, EyeOff, Info, KeyRound } from 'lucide-react';
import { Button, Dialog } from '../../components/ui';
import { useAction } from '../../lib/use-action';
import { adminApi, type AdminUser } from './admin-api';
import { writeOnline } from './admin-error';
import { AdornedField, MiniButton, RegenButton } from './form-parts';
import { demoState } from './demo';
import { ErrorBanner } from './parts';
import { suggestTempPassword } from './user-form';

export interface ResetPasswordViewProps {
  user: Pick<AdminUser, 'display_name' | 'username' | 'status'>;
  password: string;
  /** confirm: hộp xác nhận kèm mật khẩu gợi ý (ujcJc). shown: mật khẩu do máy chủ đặt, hiện đúng một lần. */
  step: 'confirm' | 'shown';
  copied?: boolean;
  error?: unknown;
  busy?: boolean;
  onPasswordChange?: (v: string) => void;
  onRegenerate?: () => void;
  onCopy?: () => void;
  onClose?: () => void;
  onConfirm?: () => void;
  overlay?: boolean;
}

const subtitle = (u: ResetPasswordViewProps['user']) => `${u.display_name} · ${u.username}${u.status === 'temp_locked' ? ' · đang Khoá tạm vì nhập sai nhiều lần' : u.status === 'locked' ? ' · đang Đã khoá' : ''}`;

/** Hộp Đặt lại mật khẩu (ujcJc). Mật khẩu chỉ hiện ở hộp này; đóng rồi không xem lại được (NFR-001). */
export function ResetPasswordView({ user, password, step, copied, error, busy, onPasswordChange, onRegenerate, onCopy, onClose, onConfirm, overlay }: ResetPasswordViewProps) {
  const copy = (
    <MiniButton icon={copied ? <Check size={12} /> : <Copy size={12} />} size={28} onClick={onCopy}>
      {copied ? 'Đã chép' : 'Sao chép'}
    </MiniButton>
  );
  return (
    <Dialog
      overlay={overlay}
      width={500}
      gap={14}
      icon={<KeyRound size={18} />}
      title={step === 'confirm' ? 'Đặt lại mật khẩu' : 'Đã đặt lại mật khẩu'}
      subtitle={subtitle(user)}
      onClose={onClose && (() => !busy && onClose())}
      actions={
        step === 'confirm' ? (
          <>
            <Button variant="secondary" disabled={busy} onClick={onClose}>
              Hủy
            </Button>
            <Button loading={busy} onClick={onConfirm}>
              {busy ? 'Đang đặt lại…' : 'Đặt lại mật khẩu'}
            </Button>
          </>
        ) : (
          <Button onClick={onClose}>Xong</Button>
        )
      }
    >
      <ErrorBanner error={error} />
      <div className="flex w-full flex-col gap-[6px]">
        <span className="text-[12px] font-semibold whitespace-nowrap text-text-2">Mật khẩu tạm</span>
        <AdornedField label="Mật khẩu tạm" mono tall readOnly={step === 'shown'} value={password} onChange={onPasswordChange}>
          {step === 'confirm' && <RegenButton onClick={onRegenerate} />}
          {copy}
        </AdornedField>
      </div>
      <div className="flex w-full gap-[10px] rounded-[8px] bg-blue-soft px-[14px] py-[12px]">
        <Info size={15} className="mt-[2px] shrink-0 text-blue" />
        <p className="min-w-0 flex-1 text-[12.5px]/[19px] text-[#1E40AF]">Người dùng phải đổi mật khẩu ở lần đăng nhập tới. Mật khẩu tạm hết hạn sau 72 giờ nếu chưa dùng. Mọi phiên đang mở sẽ phải đăng nhập lại.</p>
      </div>
      <div className="flex w-full items-center gap-[8px]">
        <EyeOff size={13} className="shrink-0 text-text-3" />
        <p className="min-w-0 flex-1 text-[11.5px]/[15px] text-text-3">Mật khẩu tạm chỉ hiện ở hộp này. Sao chép và gửi riêng cho {user.display_name} trước khi đóng.</p>
      </div>
    </Dialog>
  );
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

/**
 * Luồng đặt lại: hiện mật khẩu gợi ý, admin bấm xác nhận mới gọi máy chủ. Máy chủ hiện tại tự sinh mật khẩu (bỏ qua mật khẩu gợi ý),
 * nên nếu khác thì chuyển sang bước "shown" để admin chép đúng mật khẩu máy chủ trả về.
 */
export function ResetPasswordDialog({ user, onClose, onDone }: { user: AdminUser; onClose: () => void; onDone: (user: AdminUser) => void }) {
  const digits = useRef(import.meta.env.DEV && demoState() === 'dialog-reset' ? '5183' : String(Math.floor(Math.random() * 10000)).padStart(4, '0'));
  const [password, setPassword] = useState(() => suggestTempPassword(user.display_name, () => digits.current));
  const [step, setStep] = useState<'confirm' | 'shown'>('confirm');
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const [confirm, busy] = useAction(async () => {
    setError(null);
    try {
      const res = await writeOnline(() => adminApi.resetPassword(user.id, password));
      if (res.tempPassword === password) return onDone(user);
      setPassword(res.tempPassword);
      setStep('shown');
    } catch (e) {
      setError(e);
    }
  });

  return (
    <ResetPasswordView
      user={user}
      password={password}
      step={step}
      copied={copied}
      error={error}
      busy={busy}
      onPasswordChange={setPassword}
      onRegenerate={() => {
        digits.current = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
        setPassword(suggestTempPassword(user.display_name, () => digits.current));
      }}
      onCopy={() => void copyText(password).then(() => setCopied(true))}
      onClose={() => (step === 'shown' ? onDone(user) : onClose())}
      onConfirm={() => void confirm()}
    />
  );
}
