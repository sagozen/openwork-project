import { useEffect, useState } from 'react';
import { Lock, ShieldAlert } from 'lucide-react';
import { Banner, Button, Dialog } from '../../components/ui';
import { IS_HSDESK } from '../../lib/catalog';
import { useAction } from '../../lib/use-action';
import { adminApi, type AdminUser } from './admin-api';
import { adminErrorText, isOfflineError, writeOnline } from './admin-error';
import { LockWarning } from './PreflightPanel';
import { loadPreflight, type PreflightState } from './preflight';
import { roleLabelOf } from './user-form';

export interface LockUserDialogViewProps {
  user: Pick<AdminUser, 'display_name' | 'username' | 'role'>;
  preflight?: PreflightState;
  error?: unknown;
  busy?: boolean;
  onClose?: () => void;
  onConfirm?: () => void;
  overlay?: boolean;
}

/** Hộp xác nhận khoá tài khoản (TCvBy): cảnh báo không chặn; lỗi E-010 hiện ngay trong hộp. */
export function LockUserDialogView({ user, preflight, error, busy, onClose, onConfirm, overlay }: LockUserDialogViewProps) {
  return (
    <Dialog
      overlay={overlay}
      width={520}
      gap={14}
      tone="red"
      icon={<Lock size={18} />}
      title={`Khoá tài khoản ${user.display_name}?`}
      subtitle={`${user.username} · ${roleLabelOf(user.role)}`}
      onClose={onClose && (() => !busy && onClose())}
      actions={
        <>
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            Hủy
          </Button>
          <Button loading={busy} onClick={onConfirm} className="!bg-red">
            {busy ? 'Đang khoá…' : 'Khoá tài khoản'}
          </Button>
        </>
      }
    >
      {error ? (
        <Banner tone={isOfflineError(error) ? 'amber' : 'red'} icon={(error as { code?: string }).code === 'last_admin' ? <ShieldAlert size={16} /> : undefined}>
          {adminErrorText(error)}
        </Banner>
      ) : null}
      <p className="w-full text-[13px]/[20px] text-text-2">
        Phiên web đóng ngay. App Windows đang có mạng bị đăng xuất trong tối đa 15 phút, máy mất mạng nhận ở lần kết nối tới.
        {IS_HSDESK ? ' Thay đổi chờ được đẩy lên một lần: làm trước giờ khoá được công nhận, phần sau vào Chờ công nhận.' : ''} Tài khoản và lịch sử vẫn giữ, mở khoá được bất cứ lúc nào.
      </p>
      {IS_HSDESK && preflight && <LockWarning state={preflight} name={user.display_name} />}
    </Dialog>
  );
}

export function LockUserDialog({ user, onClose, onLocked }: { user: AdminUser; onClose: () => void; onLocked: (u: AdminUser) => void }) {
  const [preflight, setPreflight] = useState<PreflightState | undefined>();
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (!IS_HSDESK) return setPreflight(undefined);
    let live = true;
    void loadPreflight(user.id).then((s) => live && setPreflight(s));
    return () => {
      live = false;
    };
  }, [user.id]);

  const [confirm, busy] = useAction(async () => {
    setError(null);
    try {
      await writeOnline(() => adminApi.updateUser(user.id, { active: false }));
      onLocked({ ...user, status: 'locked' });
    } catch (e) {
      setError(e);
    }
  });
  return <LockUserDialogView user={user} preflight={preflight} error={error} busy={busy} onClose={onClose} onConfirm={() => void confirm()} />;
}
