// Thẻ của các màn kích hoạt / đăng nhập / đổi mật khẩu. Thuần hiển thị (props vào, sự kiện ra): màn thật và bảng so ảnh dùng chung.
import type { FormEvent, ReactNode } from 'react';
import { CircleAlert, CircleX, ClockAlert, Info, KeyRound, Lock, Monitor, MonitorX, ServerOff, ShieldCheck, Timer, WifiOff } from 'lucide-react';
import { Banner, Button, Input } from '../../components/ui';
import { NetProgress } from '../../components/NetProgress';
import { cx } from '../../components/ui/cx';
import type { Notice, NoticeIcon } from '../../lib/auth-ui';
import { PRODUCT_NAME } from '../../lib/auth-ui';
import { ProductMark } from '@product/brand';
import { PRODUCT } from '@product/product';
import { openExternal } from '../../lib/open-external';

const ICONS: Record<NoticeIcon, typeof CircleX> = {
  'circle-x': CircleX,
  'monitor-x': MonitorX,
  'wifi-off': WifiOff,
  'server-off': ServerOff,
  timer: Timer,
  lock: Lock,
  'clock-alert': ClockAlert,
};

/** Dải báo lỗi trong thẻ: đỏ = lỗi người dùng cần sửa/liên hệ, hổ phách = mạng hoặc máy chủ. */
export function NoticeBanner({ notice }: { notice: Notice | null }) {
  if (!notice) return null;
  const Icon = ICONS[notice.icon];
  return (
    <Banner tone={notice.tone} icon={<Icon size={16} />}>
      {notice.text}
    </Banner>
  );
}

export function AuthCard({ width, gap = 18, onSubmit, children }: { width: number; gap?: 18 | 20; onSubmit?: (e: FormEvent) => void; children: ReactNode }) {
  return (
    <form
      onSubmit={onSubmit}
      noValidate
      style={{ width }}
      className={cx('stroke-in flex flex-col rounded-[16px] bg-surface p-[32px] leading-[normal] shadow-auth', gap === 20 ? 'gap-[20px]' : 'gap-[18px]')}
    >
      {children}
    </form>
  );
}

const TITLE = 'text-[22px]/[28px] font-bold tracking-[-0.3px] text-text';

function Head({ icon, title, sub }: { icon: ReactNode; title: string; sub: ReactNode }) {
  return (
    <div className="flex flex-col gap-[10px]">
      {icon}
      <h1 className={TITLE}>{title}</h1>
      {typeof sub === 'string' ? <p className="text-[13px]/[20px] whitespace-pre-wrap text-text-2">{sub}</p> : sub}
    </div>
  );
}

// ---------- Kích hoạt (LcRHt, Ko3Pm) ----------

export interface ActivationCardProps {
  width?: number;
  value: string;
  onChange?: (v: string) => void;
  notice?: Notice | null;
  invalidKey?: boolean;
  button?: string;
  busy?: boolean;
  /** Tên máy (từ bản quyền). Thiếu thì bỏ dòng này. */
  machine?: string;
  onSubmit?: (e: FormEvent) => void;
}

export function ActivationCard({ width = 420, value, onChange, notice, invalidKey, button = 'Kích hoạt', busy, machine, onSubmit }: ActivationCardProps) {
  return (
    <AuthCard width={width} gap={20} onSubmit={onSubmit}>
      <Head
        icon={
          <span className="flex h-[44px] w-[44px] items-center justify-center rounded-[12px] bg-accent-soft text-accent">
            <KeyRound size={22} />
          </span>
        }
        title="Kích hoạt bản quyền"
        sub={`Máy này chưa được kích hoạt. Nhập mã bản quyền mà bên triển khai ${PRODUCT_NAME} đã gửi cho công ty.`}
      />
      <NoticeBanner notice={notice ?? null} />
      <Input
        label="Mã bản quyền"
        size="license"
        mono
        autoFocus
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
        readOnly={!onChange}
        invalid={invalidKey}
        placeholder="HSD-XXXXX-XXXXX-XXXXX-XXXXX"
      />
      <Button type="submit" size="auth" block loading={busy}>
        {busy ? 'Đang kích hoạt…' : button}
      </Button>
      <NetProgress op="license.activate" active={!!busy} label="Đang kích hoạt máy" className="self-center" />
      {PRODUCT.freeLicense && (
        <p className="text-center text-[12px]/[16px] text-text-2">
          {PRODUCT.freeLicense.text}{' '}
          <a
            href={PRODUCT.freeLicense.url}
            onClick={(e) => {
              e.preventDefault();
              openExternal(PRODUCT.freeLicense!.url);
            }}
            className="font-semibold text-accent hover:underline"
          >
            {PRODUCT.freeLicense.cta}
          </a>
        </p>
      )}
      {machine && (
        <div className="flex items-center gap-[8px] pt-[12px] shadow-[inset_0_1px_0_var(--color-border)]">
          <Monitor size={13} className="shrink-0 text-text-3" />
          <span className="text-[11px]/[14px] whitespace-nowrap text-text-3">Tên máy: {machine}</span>
        </div>
      )}
    </AuthCard>
  );
}

// ---------- Đăng nhập (wcyQW, npit1) ----------

export interface LoginCardProps {
  width?: number;
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
  /** Tự đặt con trỏ: ô tên nếu trống, ngược lại ô mật khẩu. */
  autoFocus?: boolean;
}

export function LoginCard({ width = 400, subtitle, username, password, onUsername, onPassword, notice, invalidFields, button = { label: 'Đăng nhập', disabled: false }, busy, placeholderPassword = '', onSubmit, autoFocus }: LoginCardProps) {
  return (
    <AuthCard width={width} onSubmit={onSubmit}>
      <Head
        icon={<ProductMark className="h-[40px] w-[40px] rounded-[11px]" glyph={20} tone="light" />}
        title={`Đăng nhập ${PRODUCT_NAME}`}
        sub={subtitle}
      />
      <NoticeBanner notice={notice ?? null} />
      <Input
        size="login"
        label="Tên đăng nhập"
        value={username}
        onChange={(e) => onUsername?.(e.target.value)}
        readOnly={!onUsername}
        invalid={invalidFields}
        autoComplete="username"
        autoCapitalize="none"
        spellCheck={false}
        autoFocus={autoFocus && !username}
      />
      <Input
        size="login"
        label="Mật khẩu"
        password
        value={password}
        onChange={(e) => onPassword?.(e.target.value)}
        readOnly={!onPassword}
        invalid={invalidFields}
        autoComplete="current-password"
        placeholder={placeholderPassword}
        autoFocus={autoFocus && !!username}
      />
      <Button type="submit" size="auth" block disabled={button.disabled} loading={busy}>
        {busy ? 'Đang đăng nhập…' : button.label}
      </Button>
      <NetProgress op="auth.login" active={!!busy} label="Đang đăng nhập" className="self-center" />
      <p className="flex items-center justify-center gap-[6px] text-[12px]/[15px] text-text-3">
        <Info size={13} />
        Quên mật khẩu? Nhờ admin đặt lại.
      </p>
    </AuthCard>
  );
}

// ---------- Đổi mật khẩu: ghi chú dưới ô ----------

export function FieldHint({ children }: { children: ReactNode }) {
  return (
    <span className="flex items-center gap-[5px] text-[11.5px]/[15px] text-text-3">
      <Info size={12} className="shrink-0" />
      {children}
    </span>
  );
}

export function FieldError({ children }: { children: ReactNode }) {
  return (
    <span role="alert" className="flex items-start gap-[6px] text-[11.5px]/[16px] font-medium text-red">
      <CircleAlert size={13} className="mt-[1.5px] shrink-0" />
      {children}
    </span>
  );
}

export interface PasswordFieldsProps {
  /** Hiện ô "Mật khẩu hiện tại" (hộp tự đổi; màn bắt buộc chỉ hiện khi máy không còn nhớ mật khẩu tạm). */
  showCurrent?: boolean;
  currentLabel?: string;
  current: string;
  next: string;
  confirm: string;
  onCurrent?: (v: string) => void;
  onNext?: (v: string) => void;
  onConfirm?: (v: string) => void;
  error?: { name: 'current' | 'new' | 'confirm'; text: string } | null;
  autoFocus?: boolean;
}

/** Các ô mật khẩu chung cho màn bắt buộc (Z2ACu) và hộp tự đổi (WroZv). Lỗi hiện ngay dưới ô cần sửa. */
export function PasswordFields(p: PasswordFieldsProps) {
  const err = (name: 'current' | 'new' | 'confirm') => (p.error?.name === name ? p.error.text : null);
  return (
    <>
      {p.showCurrent && (
        <Input
          size="login"
          label={p.currentLabel ?? 'Mật khẩu hiện tại'}
          password
          value={p.current}
          onChange={(e) => p.onCurrent?.(e.target.value)}
          readOnly={!p.onCurrent}
          invalid={!!err('current')}
          autoComplete="current-password"
          autoFocus={p.autoFocus}
          hint={err('current') ? <FieldError>{err('current')}</FieldError> : undefined}
        />
      )}
      <Input
        size="login"
        label="Mật khẩu mới"
        password
        value={p.next}
        onChange={(e) => p.onNext?.(e.target.value)}
        readOnly={!p.onNext}
        invalid={!!err('new')}
        autoComplete="new-password"
        autoFocus={p.autoFocus && !p.showCurrent}
        hint={err('new') ? <FieldError>{err('new')}</FieldError> : <FieldHint>Ít nhất 8 ký tự</FieldHint>}
      />
      <Input
        size="login"
        label="Nhập lại"
        password
        value={p.confirm}
        onChange={(e) => p.onConfirm?.(e.target.value)}
        readOnly={!p.onConfirm}
        invalid={!!err('confirm')}
        autoComplete="new-password"
        hint={err('confirm') ? <FieldError>{err('confirm')}</FieldError> : undefined}
      />
    </>
  );
}

export interface ForcePasswordCardProps extends PasswordFieldsProps {
  width?: number;
  name: string;
  notice?: Notice | null;
  busy?: boolean;
  onSubmit?: (e: FormEvent) => void;
}

/** Màn đặt mật khẩu mới bắt buộc sau mật khẩu tạm (Z2ACu). */
export function ForcePasswordCard({ width = 420, name, notice, busy, onSubmit, ...fields }: ForcePasswordCardProps) {
  return (
    <AuthCard width={width} onSubmit={onSubmit}>
      <Head
        icon={
          <span className="flex h-[44px] w-[44px] items-center justify-center rounded-[12px] bg-blue-soft text-blue">
            <ShieldCheck size={22} />
          </span>
        }
        title="Đặt mật khẩu mới"
        sub={`${name}, bạn đang dùng mật khẩu tạm do admin đặt. Đặt mật khẩu của riêng bạn để tiếp tục.`}
      />
      <NoticeBanner notice={notice ?? null} />
      <PasswordFields {...fields} />
      <Button type="submit" size="auth" block loading={busy}>
        {busy ? 'Đang lưu…' : 'Lưu và tiếp tục'}
      </Button>
      <NetProgress op="auth.change-password" active={!!busy} label="Đang lưu mật khẩu mới" className="self-center" />
    </AuthCard>
  );
}
