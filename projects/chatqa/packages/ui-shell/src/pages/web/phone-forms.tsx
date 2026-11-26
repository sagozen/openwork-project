// Biểu mẫu đăng nhập / đặt mật khẩu mới trên điện thoại (G82Jk, pfQJa, IBUru): nền phẳng, không thẻ. Thuần hiển thị như cards.tsx.
import type { FormEvent, ReactNode } from 'react';
import { CircleX, Info, ShieldCheck } from 'lucide-react';
import { Button, Input } from '../../components/ui';
import { cx } from '../../components/ui/cx';
import { NetProgress } from '../../components/NetProgress';
import type { Notice } from '../../lib/auth-ui';
import { FieldError, FieldHint, NoticeBanner, type PasswordFieldsProps } from '../auth/cards';

const TITLE = 'text-[26px]/[33px] font-bold tracking-[-0.4px] text-text';

function PhoneForm({ onSubmit, children }: { onSubmit?: (e: FormEvent) => void; children: ReactNode }) {
  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-[16px] p-[20px] pt-[48px] leading-[normal]">
      {children}
    </form>
  );
}

/** Dải lỗi điện thoại: đệm 12, bo 10, chữ 13/19 (khung pfQJa). */
function PhoneNotice({ notice }: { notice: Notice | null }) {
  if (!notice) return null;
  if (notice.tone === 'red' && notice.icon === 'circle-x') {
    return (
      <div role="alert" className="stroke-in flex items-start gap-[10px] rounded-[10px] [--stroke-c:var(--color-line-red)] bg-red-soft p-[12px]">
        <CircleX size={16} className="shrink-0 text-red" />
        <p className="min-w-0 flex-1 text-[13px]/[19px] font-medium text-red">{notice.text}</p>
      </div>
    );
  }
  return <NoticeBanner notice={notice} />;
}

export interface PhoneLoginProps {
  subtitle: string;
  username: string;
  password: string;
  onUsername?: (v: string) => void;
  onPassword?: (v: string) => void;
  notice?: Notice | null;
  invalidFields?: boolean;
  button?: { label: string; disabled: boolean };
  busy?: boolean;
  placeholderPassword?: string;
  onSubmit?: (e: FormEvent) => void;
  autoFocus?: boolean;
}

export function PhoneLoginForm({ subtitle, username, password, onUsername, onPassword, notice, invalidFields, button = { label: 'Đăng nhập', disabled: false }, busy, placeholderPassword = '', onSubmit, autoFocus }: PhoneLoginProps) {
  return (
    <PhoneForm onSubmit={onSubmit}>
      <h1 className={TITLE}>Đăng nhập</h1>
      <p className="text-[14px]/[18px] text-text-2">{subtitle}</p>
      <PhoneNotice notice={notice ?? null} />
      <Input size="phone" label="Tên đăng nhập" value={username} onChange={(e) => onUsername?.(e.target.value)} invalid={invalidFields} autoComplete="username" autoCapitalize="none" spellCheck={false} autoFocus={autoFocus && !username} />
      <Input size="phone" label="Mật khẩu" password value={password} onChange={(e) => onPassword?.(e.target.value)} invalid={invalidFields} autoComplete="current-password" placeholder={placeholderPassword} autoFocus={autoFocus && !!username} />
      <Button type="submit" size="auth" block className="!h-[50px] !rounded-[10px] !text-[15px]/[19px]" disabled={button.disabled} loading={busy}>
        {busy ? 'Đang đăng nhập…' : button.label}
      </Button>
      <NetProgress op="auth.login" active={!!busy} label="Đang đăng nhập" className="self-center" />
      <p className="flex items-center justify-center gap-[6px] text-[13px]/[16px] text-text-3">
        <Info size={13} />
        Quên mật khẩu? Nhờ admin đặt lại.
      </p>
    </PhoneForm>
  );
}

export interface PhoneForceProps extends PasswordFieldsProps {
  notice?: Notice | null;
  busy?: boolean;
  onSubmit?: (e: FormEvent) => void;
}

/** Đặt mật khẩu mới bắt buộc (IBUru). Điện thoại không nêu tên người dùng trong lời dẫn. */
export function PhoneForcePasswordForm({ notice, busy, onSubmit, showCurrent, currentLabel, current, next, confirm, onCurrent, onNext, onConfirm, error, autoFocus }: PhoneForceProps) {
  const err = (n: 'current' | 'new' | 'confirm') => (error?.name === n ? error.text : null);
  return (
    <PhoneForm onSubmit={onSubmit}>
      <span className="mt-[0px] flex h-[44px] w-[44px] items-center justify-center rounded-[12px] bg-blue-soft text-blue">
        <ShieldCheck size={22} />
      </span>
      <h1 className="text-[24px]/[30px] font-bold tracking-[-0.4px]">Đặt mật khẩu mới</h1>
      <p className="text-[14px]/[21px] text-text-2">Bạn đang dùng mật khẩu tạm do admin đặt. Đặt mật khẩu của riêng bạn để tiếp tục.</p>
      <NoticeBanner notice={notice ?? null} />
      {showCurrent && (
        <Input size="phone" label={currentLabel ?? 'Mật khẩu hiện tại'} password value={current} onChange={(e) => onCurrent?.(e.target.value)} invalid={!!err('current')} autoComplete="current-password" autoFocus={autoFocus} hint={err('current') ? <FieldError>{err('current')}</FieldError> : undefined} />
      )}
      <Input size="phone" label="Mật khẩu mới" password value={next} onChange={(e) => onNext?.(e.target.value)} invalid={!!err('new')} autoComplete="new-password" autoFocus={autoFocus && !showCurrent} hint={err('new') ? <FieldError>{err('new')}</FieldError> : <FieldHint>Ít nhất 8 ký tự</FieldHint>} />
      <Input size="phone" label="Nhập lại" password value={confirm} onChange={(e) => onConfirm?.(e.target.value)} invalid={!!err('confirm')} autoComplete="new-password" hint={err('confirm') ? <FieldError>{err('confirm')}</FieldError> : undefined} />
      <Button type="submit" size="auth" block className={cx('!h-[50px] !rounded-[10px] !text-[15px]/[19px]')} loading={busy}>
        {busy ? 'Đang lưu…' : 'Lưu và tiếp tục'}
      </Button>
      <NetProgress op="auth.change-password" active={!!busy} label="Đang lưu mật khẩu mới" className="self-center" />
    </PhoneForm>
  );
}
