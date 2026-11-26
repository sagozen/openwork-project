import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Loader2, Lock, LockOpen, ShieldAlert, UserPen, UserPlus } from 'lucide-react';
import { Banner, Button, Checkbox, Dialog, Input } from '../../components/ui';
import { cx } from '../../components/ui/cx';
import type { AppCode } from '../../platform/types';
import { IS_HSDESK } from '../../lib/catalog';
import { adminApi, type AdminUser, type CreatedUser } from './admin-api';
import { adminErrorText, isOfflineError, writeOnline } from './admin-error';
import { AdornedField, AppChecks, FieldError, FieldLabel, RegenButton, RoleSegmented } from './form-parts';
import { EditWarningSide } from './PreflightPanel';
import { loadPreflight, type PreflightState } from './preflight';
import { demoState } from './demo';
import { appLabel } from './format';
import { canSaveUser, createBody, editImpact, editPatch, emptyForm, formFromUser, roleLabelOf, suggestTempPassword, type EditImpact, type UserForm } from './user-form';
import { PRODUCT_NAME } from '../../lib/auth-ui';
import { useAction } from '../../lib/use-action';

const codeOf = (e: unknown) => (e as { code?: string } | null)?.code ?? '';

export interface UserDialogViewProps {
  mode: 'add' | 'edit';
  form: UserForm;
  onChange: (patch: Partial<UserForm>) => void;
  licenseApps: AppCode[];
  orig?: AdminUser;
  impact?: EditImpact;
  preflight?: PreflightState;
  error?: unknown;
  busy?: boolean;
  /** Nút lưu bật được? (đủ thông tin, có thay đổi, không đang bị lỗi chặn). */
  canSave: boolean;
  footerNote?: ReactNode;
  onClose?: () => void;
  onSubmit?: () => void;
  onRegenerate?: () => void;
  onToggleLock?: () => void;
  /** Đang mở khoá từ dòng trạng thái: nút khoá lại, hiện vòng quay. */
  toggleLockBusy?: boolean;
  overlay?: boolean;
  /** Dòng trạng thái + nút Khoá khi sửa (khung lỗi chặn lưu của pen bỏ dòng này). */
  showStatus?: boolean;
  /** Bề rộng tuỳ chọn (khung so ảnh dùng 606 để vừa thẻ). */
  width?: number;
}

/** Hộp Thêm / Sửa người dùng (CMlK6, fuJ5z, Z073K). Chỉ vẽ; luồng gọi API nằm ở UserDialog. */
export function UserDialogView(p: UserDialogViewProps) {
  const { mode, form, orig, impact, error } = p;
  const add = mode === 'add';
  const code = codeOf(error);
  const taken = code === 'username_taken';
  const bannerError = error && !taken ? error : null;
  const roleExtra = !add && orig && form.role !== orig.role ? `${roleLabelOf(orig.role)} → ${roleLabelOf(form.role)}${impact?.demoted ? ' (hạ vai)' : ''}` : 'mỗi tài khoản đúng một vai';
  const appExtra = impact && impact.removedApps.length ? `bỏ ${impact.removedApps.map((c) => appLabel(c).split(' · ')[0]).join(', ')}` : 'mặc định chọn hết các app đã kích hoạt';
  // Lô đang giữ / mặt hàng đang khoá là dữ liệu nghiệp vụ của HS Desk: sản phẩm khác không có cột cảnh báo này.
  const hasSide = !add && IS_HSDESK && !!impact?.needsPreflight && !!p.preflight;
  const note =
    p.footerNote ??
    (add
      ? 'Người dùng phải đổi mật khẩu ở lần đăng nhập đầu.'
      : impact?.needsPreflight
        ? 'Hạ vai, bỏ app có hiệu lực từ lúc lưu: máy có mạng nhận trong tối đa 15 phút. Thao tác làm sau giờ lưu mà ngoài quyền mới sẽ không được công nhận.'
        : 'Thay đổi có hiệu lực từ lúc lưu: máy có mạng nhận trong tối đa 15 phút.');

  return (
    <Dialog
      overlay={p.overlay}
      width={p.width ?? (hasSide ? 940 : 600)}
      icon={add ? <UserPlus size={18} /> : <UserPen size={18} />}
      title={add ? 'Thêm người dùng' : 'Sửa người dùng'}
      subtitle={add ? 'Một tài khoản dùng cho mọi app công ty đã kích hoạt' : `${orig?.display_name ?? ''} · đang là ${roleLabelOf(orig?.role ?? '')}`}
      onClose={p.onClose && (() => !p.busy && p.onClose?.())}
      note={note}
      side={hasSide && p.preflight ? <EditWarningSide state={p.preflight} name={orig?.display_name ?? ''} /> : undefined}
      actions={
        <>
          <Button variant="secondary" disabled={p.busy} onClick={p.onClose}>
            Hủy
          </Button>
          <Button disabled={!p.canSave} loading={p.busy} onClick={p.onSubmit} className="disabled:!bg-accent disabled:!text-white disabled:opacity-[0.45]">
            {p.busy ? 'Đang lưu…' : add ? 'Thêm người dùng' : 'Lưu thay đổi'}
          </Button>
        </>
      }
    >
      {bannerError ? (
        <Banner tone={isOfflineError(bannerError) ? 'amber' : 'red'} icon={code === 'last_admin' ? <ShieldAlert size={16} /> : undefined}>
          {adminErrorText(bannerError, { username: form.username })}
        </Banner>
      ) : null}

      <div className="flex w-full gap-[14px]">
        <div className="flex min-w-0 flex-1 flex-col gap-[6px]">
          <FieldLabel>{add ? 'Tên đăng nhập' : 'Tên đăng nhập (không đổi được)'}</FieldLabel>
          <AdornedField label="Tên đăng nhập" mono readOnly={!add} invalid={taken} value={form.username} onChange={(v) => p.onChange({ username: v })}>
            {!add && <Lock size={14} className="shrink-0 text-text-3" />}
          </AdornedField>
          {taken && <FieldError>{adminErrorText(error, { username: form.username })}</FieldError>}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-[6px]">
          <FieldLabel>Tên hiển thị</FieldLabel>
          <Input size="dialog" aria-label="Tên hiển thị" value={form.displayName} onChange={(e) => p.onChange({ displayName: e.target.value })} />
        </div>
      </div>

      <div className="flex w-full flex-col gap-[6px]">
        <FieldLabel extra={roleExtra} warn={!add && form.role !== orig?.role}>
          Vai
        </FieldLabel>
        <RoleSegmented value={form.role} original={add ? undefined : orig?.role} onChange={(role) => p.onChange({ role, isDeployer: role === 'admin' ? form.isDeployer : false })} />
      </div>

      <div className="flex w-full flex-col gap-[8px]">
        <FieldLabel extra={appExtra} warn={!!impact?.removedApps.length}>
          App được cấp
        </FieldLabel>
        <AppChecks licenseApps={p.licenseApps} value={form.role === 'vipo' ? [] : form.apps} removed={impact?.removedApps} onChange={(apps) => p.onChange({ apps })} />
      </div>

      {add ? (
        <>
          <div className="flex w-full flex-col gap-[6px]">
            <FieldLabel extra="hết hạn sau 72 giờ nếu chưa dùng">Mật khẩu tạm</FieldLabel>
            <AdornedField label="Mật khẩu tạm" mono value={form.password} onChange={(v) => p.onChange({ password: v })}>
              <RegenButton onClick={p.onRegenerate} />
            </AdornedField>
          </div>
          <div className="stroke-in flex w-full flex-col gap-[6px] rounded-[8px] bg-table-head px-[14px] py-[12px]">
            <Checkbox checked={form.isDeployer} onChange={(v) => p.onChange(v ? { isDeployer: true, role: 'admin' } : { isDeployer: false })}>
              Bên triển khai
            </Checkbox>
            <p className="w-full text-[11px]/[16px] text-text-3">Chỉ chọn được khi thêm, sau đó không gỡ được. Chỉ dùng cho tài khoản Admin của đơn vị triển khai {PRODUCT_NAME}.</p>
          </div>
        </>
      ) : (
        orig && p.showStatus !== false && <StatusLine user={orig} onToggleLock={p.onToggleLock} disabled={p.busy || p.toggleLockBusy} busy={p.toggleLockBusy} />
      )}
    </Dialog>
  );
}

function StatusLine({ user, onToggleLock, disabled, busy }: { user: AdminUser; onToggleLock?: () => void; disabled?: boolean; busy?: boolean }) {
  const locked = user.status === 'locked';
  const text = locked ? 'Đã khoá' : user.status === 'temp_locked' ? 'Đang khoá tạm' : 'Đang hoạt động';
  const dot = locked ? 'bg-red' : user.status === 'temp_locked' ? 'bg-amber' : 'bg-green';
  return (
    <div className="flex w-full items-center gap-[8px] rounded-[8px] bg-table-head px-[12px] py-[10px]">
      <span className={cx('h-[7px] w-[7px] shrink-0 rounded-full', dot)} />
      <span className="min-w-0 flex-1 text-[12px] text-text-2">
        {text}
        {user.last_device ? ` · máy gần nhất ${user.last_device}` : ''}
      </span>
      <button
        type="button"
        disabled={disabled}
        aria-busy={busy || undefined}
        onClick={onToggleLock}
        className={cx('stroke-in flex h-[28px] shrink-0 items-center gap-[5px] rounded-[6px] px-[10px] text-[11.5px] font-semibold whitespace-nowrap disabled:opacity-50', locked ? 'text-text' : '[--stroke-c:var(--color-line-red)] text-red')}
      >
        {busy ? <Loader2 size={12} className="animate-spin" aria-hidden /> : locked ? <LockOpen size={12} /> : <Lock size={12} />}
        {busy ? 'Đang mở khoá…' : locked ? 'Mở khoá tài khoản' : 'Khoá tài khoản'}
      </button>
    </div>
  );
}

export interface UserDialogProps {
  mode: 'add' | 'edit';
  user?: AdminUser;
  /** Mọi tài khoản (nêu tên Bên triển khai khi báo E-010). */
  users: AdminUser[];
  licenseApps: AppCode[];
  onClose: () => void;
  onCreated: (u: CreatedUser, form: UserForm) => void;
  onUpdated: (u: AdminUser) => void;
  onToggleLock: (u: AdminUser) => void;
  /** Đang mở khoá tài khoản này (bấm từ dòng trạng thái). */
  toggleLockBusy?: boolean;
}

/** Luồng Thêm / Sửa: cần mạng (E-020), lỗi chặn lưu giữ nút lưu tắt tới khi sửa biểu mẫu. */
export function UserDialog({ mode, user, users, licenseApps, onClose, onCreated, onUpdated, onToggleLock, toggleLockBusy }: UserDialogProps) {
  const [form, setForm] = useState<UserForm>(() => {
    const base = mode === 'edit' && user ? formFromUser(user, licenseApps) : emptyForm(licenseApps);
    if (import.meta.env.DEV) {
      // chỉ bản dev: dữ liệu mẫu cho bộ so ảnh (khối này bị loại khi đóng gói)
      const demo = demoState();
      if (demo === 'dialog-add') return { ...base, username: 'nguyenvy', displayName: 'Nguyễn Thảo Vy' };
      if (demo === 'dialog-edit-warning') return { ...base, role: 'staff', apps: base.apps.filter((a: string) => a !== 'lot') };
    }
    return base;
  });
  const [error, setError] = useState<unknown>(null);
  const [preflight, setPreflight] = useState<PreflightState | undefined>();
  const digits = useRef(import.meta.env.DEV && demoState() === 'dialog-add' ? '7429' : String(Math.floor(Math.random() * 10000)).padStart(4, '0'));
  const autoPw = useRef(true);

  useEffect(() => {
    if (mode === 'add' && autoPw.current) setForm((f) => ({ ...f, password: suggestTempPassword(f.displayName, () => digits.current) }));
  }, [mode, form.displayName]);

  const impact = useMemo(() => (mode === 'edit' && user ? editImpact(user, form, licenseApps) : undefined), [mode, user, form, licenseApps]);
  const needsPreflight = !!impact?.needsPreflight;
  useEffect(() => {
    if (!IS_HSDESK || !needsPreflight || !user) return setPreflight(undefined);
    let live = true;
    void loadPreflight(user.id).then((s) => live && setPreflight(s));
    return () => {
      live = false;
    };
  }, [needsPreflight, user]);

  const change = (patch: Partial<UserForm>) => {
    if ('password' in patch) autoPw.current = false;
    setError(null);
    setForm((f) => ({ ...f, ...patch }));
  };
  const patch = mode === 'edit' && user ? editPatch(user, form, licenseApps) : null;
  const canSave = canSaveUser(mode, form, patch, error);
  const deployer = users.find((u) => u.is_deployer);

  const [submit, busy] = useAction(async () => {
    setError(null);
    try {
      if (mode === 'add') {
        const created = await writeOnline(() => adminApi.createUser(createBody(form, licenseApps)));
        onCreated(created, form);
      } else if (user && patch) {
        await writeOnline(() => adminApi.updateUser(user.id, patch));
        onUpdated({ ...user, display_name: patch.displayName ?? user.display_name, role: patch.role ?? user.role });
      }
    } catch (e) {
      setError(e);
    }
  });

  return (
    <UserDialogView
      mode={mode}
      form={form}
      onChange={change}
      licenseApps={licenseApps}
      orig={user}
      impact={impact}
      preflight={preflight}
      error={error}
      busy={busy}
      canSave={canSave}
      footerNote={codeOf(error) === 'last_admin' && deployer ? `${deployer.display_name} là Admin Bên triển khai nên không được tính.` : undefined}
      onClose={onClose}
      onSubmit={() => void submit()}
      onRegenerate={() => {
        digits.current = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
        autoPw.current = true;
        setForm((f) => ({ ...f, password: suggestTempPassword(f.displayName, () => digits.current) }));
      }}
      onToggleLock={() => user && onToggleLock(user)}
      toggleLockBusy={toggleLockBusy}
    />
  );
}
